import { createHash } from "node:crypto";
import type {
  ControlCancelOperation,
  ControlGetOperation,
  ControlListOperation,
  ControlRunOperation,
  JobManifest,
} from "../domain/schemas.js";
import {
  InvalidCursor,
  JobIdempotencyConflict,
  JobNotCancellable,
  JobNotFound,
} from "./services.js";

export { JobIdempotencyConflict as IdempotencyConflict } from "./services.js";

export type RunOperation = ControlRunOperation;
export type CancelOperation = ControlCancelOperation;
export type GetOperation = ControlGetOperation;
export type ListOperation = ControlListOperation;
export type JobStatus = JobManifest["status"];

export type SettleOperation =
  | {
      readonly version: 1;
      readonly operation: "settle";
      readonly jobId: string;
      readonly status: "succeeded";
      readonly outcome: NonNullable<JobManifest["outcome"]>;
    }
  | {
      readonly version: 1;
      readonly operation: "settle";
      readonly jobId: string;
      readonly status: "failed";
      readonly failure: { readonly code: string; readonly message: string };
    };

export type JobOperation =
  | RunOperation
  | GetOperation
  | ListOperation
  | CancelOperation
  | SettleOperation;

export interface StoredManifest {
  readonly manifest: JobManifest;
  readonly etag: string;
}

export interface ManifestStore {
  readonly create: (manifest: JobManifest) => Promise<StoredManifest | undefined>;
  readonly read: (jobId: string) => Promise<StoredManifest | undefined>;
  readonly replace: (
    jobId: string,
    expectedEtag: string,
    manifest: JobManifest,
  ) => Promise<StoredManifest | undefined>;
  readonly list: () => Promise<ReadonlyArray<StoredManifest>>;
}

export class StaleManifest extends Error {
  readonly code = "stale_manifest";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} was changed concurrently`);
    this.name = "StaleManifest";
  }
}

const canonicalSubmission = (operation: RunOperation) =>
  JSON.stringify({
    instruction: operation.instruction,
    repositorySet: operation.repositorySet,
  });

const submissionHash = (operation: RunOperation) =>
  createHash("sha256").update(canonicalSubmission(operation)).digest("hex");

export class InMemoryManifestStore implements ManifestStore {
  readonly #manifests = new Map<string, StoredManifest>();

  get size() {
    return this.#manifests.size;
  }

  async create(manifest: JobManifest) {
    if (this.#manifests.has(manifest.jobId)) return undefined;
    const stored = { manifest, etag: '"1"' };
    this.#manifests.set(manifest.jobId, stored);
    return stored;
  }

  async read(jobId: string) {
    return this.#manifests.get(jobId);
  }

  async replace(jobId: string, expectedEtag: string, manifest: JobManifest) {
    const existing = this.#manifests.get(jobId);
    if (existing?.etag !== expectedEtag) return undefined;
    const revision = Number.parseInt(existing.etag.replaceAll('"', ""), 10) + 1;
    const stored = { manifest, etag: `"${revision}"` };
    this.#manifests.set(jobId, stored);
    return stored;
  }

  async list() {
    return [...this.#manifests.values()];
  }
}

export interface JobControllerDependencies {
  readonly store: ManifestStore;
  readonly now: () => string;
  readonly submittedBy: () => string;
  readonly wakeLaunch: (jobId: string) => Promise<void>;
}

export interface JobListPage {
  readonly jobs: ReadonlyArray<JobManifest>;
  readonly nextCursor?: string;
}

export interface JobController {
  readonly handle: {
    (operation: ListOperation): Promise<JobListPage>;
    (operation: Exclude<JobOperation, ListOperation>): Promise<JobManifest>;
    (operation: JobOperation): Promise<JobManifest | JobListPage>;
  };
}

const encodeCursor = (offset: number, status: JobStatus | undefined) =>
  `cursor-${Buffer.from(JSON.stringify({ offset, status: status ?? null })).toString("base64url")}`;

const decodeCursor = (cursor: string, status: JobStatus | undefined) => {
  try {
    if (!cursor.startsWith("cursor-")) throw new Error();
    const decoded = JSON.parse(Buffer.from(cursor.slice(7), "base64url").toString()) as {
      offset?: unknown;
      status?: unknown;
    };
    if (
      !Number.isInteger(decoded.offset) ||
      (decoded.offset as number) < 0 ||
      decoded.status !== (status ?? null)
    ) {
      throw new Error();
    }
    return decoded.offset as number;
  } catch {
    throw new InvalidCursor({ message: "Invalid Job list cursor" });
  }
};

export const paginateJobManifests = (
  manifests: ReadonlyArray<JobManifest>,
  operation: ListOperation,
): JobListPage => {
  const offset = operation.cursor === undefined ? 0 : decodeCursor(operation.cursor, operation.status);
  const retained = manifests
    .filter((manifest) => operation.status === undefined || manifest.status === operation.status)
    .sort(
      (left, right) =>
        right.audit.submittedAt.localeCompare(left.audit.submittedAt) ||
        right.jobId.localeCompare(left.jobId),
    );
  const jobs = retained.slice(offset, offset + operation.limit);
  const nextOffset = offset + jobs.length;
  return {
    jobs,
    ...(nextOffset < retained.length
      ? { nextCursor: encodeCursor(nextOffset, operation.status) }
      : {}),
  };
};

export const cancelJobManifest = (manifest: JobManifest, timestamp: string): JobManifest => {
  if (manifest.status === "cancelled") return manifest;
  if (manifest.status !== "queued" && manifest.status !== "running") {
    throw new JobNotCancellable({ jobId: manifest.jobId });
  }
  return {
    ...manifest,
    status: "cancelled",
    transitions: [...manifest.transitions, { status: "cancelled", timestamp }],
    failure: { code: "cancelled", message: "Job cancelled by user" },
  };
};

export const makeJobController = (dependencies: JobControllerDependencies): JobController => {
  const handle = async (operation: JobOperation): Promise<JobManifest | JobListPage> => {
    if (operation.operation === "list") {
      return paginateJobManifests(
        (await dependencies.store.list()).map(({ manifest }) => manifest),
        operation,
      );
    }

    if (operation.operation === "get") {
      const existing = await dependencies.store.read(operation.jobId);
      if (existing === undefined) throw new JobNotFound({ jobId: operation.jobId });
      return existing.manifest;
    }

    if (operation.operation === "settle") {
      const existing = await dependencies.store.read(operation.jobId);
      if (existing === undefined) throw new JobNotFound({ jobId: operation.jobId });
      if (["succeeded", "failed", "cancelled"].includes(existing.manifest.status)) {
        throw new StaleManifest(operation.jobId);
      }
      const terminal: JobManifest = {
        ...existing.manifest,
        status: operation.status,
        transitions: [
          ...existing.manifest.transitions,
          { status: operation.status, timestamp: dependencies.now() },
        ],
        ...(operation.status === "succeeded"
          ? { outcome: operation.outcome }
          : { failure: operation.failure }),
      };
      const replaced = await dependencies.store.replace(
        operation.jobId,
        existing.etag,
        terminal,
      );
      if (replaced === undefined) throw new StaleManifest(operation.jobId);
      return replaced.manifest;
    }

    if (operation.operation === "cancel") {
      const existing = await dependencies.store.read(operation.jobId);
      if (existing === undefined) throw new JobNotFound({ jobId: operation.jobId });
      const cancelled = cancelJobManifest(existing.manifest, dependencies.now());
      if (cancelled === existing.manifest) return existing.manifest;
      const replaced = await dependencies.store.replace(
        operation.jobId,
        existing.etag,
        cancelled,
      );
      if (replaced === undefined) {
        const winner = await dependencies.store.read(operation.jobId);
        if (winner?.manifest.status === "cancelled") return winner.manifest;
        throw new StaleManifest(operation.jobId);
      }
      return replaced.manifest;
    }

    const canonicalHash = submissionHash(operation);
    const submittedAt = dependencies.now();
    const manifest: JobManifest = {
      version: 1,
      jobId: operation.jobId,
      submission: {
        canonicalHash,
        instruction: operation.instruction,
        repositorySet: operation.repositorySet,
      },
      status: "queued",
      transitions: [{ status: "queued", timestamp: submittedAt }],
      audit: { submittedAt, submittedBy: dependencies.submittedBy() },
      runtime: { writerGeneration: 0 },
      transcript: { highestCursor: null },
      artifacts: {},
    };

    const created = await dependencies.store.create(manifest);
    if (created !== undefined) {
      await dependencies.wakeLaunch(operation.jobId).catch(() => undefined);
      return created.manifest;
    }

    const existing = await dependencies.store.read(operation.jobId);
    if (existing?.manifest.submission.canonicalHash === canonicalHash) {
      return existing.manifest;
    }
    throw new JobIdempotencyConflict({
      jobId: operation.jobId,
      message: `Job ${operation.jobId} already exists with different submission content`,
    });
  };
  return { handle } as JobController;
};

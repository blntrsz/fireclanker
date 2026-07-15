import { createHash } from "node:crypto";

export interface RunOperation {
  readonly version: 1;
  readonly operation: "run";
  readonly jobId: string;
  readonly instruction: string;
  readonly repositorySet: ReadonlyArray<unknown>;
}

export interface CancelOperation {
  readonly version: 1;
  readonly operation: "cancel";
  readonly jobId: string;
}

export interface GetOperation {
  readonly version: 1;
  readonly operation: "get";
  readonly jobId: string;
}

type ResponseOutcome = {
  readonly version: 1;
  readonly kind: "response";
  readonly response: string;
};

export type SettleOperation =
  | {
      readonly version: 1;
      readonly operation: "settle";
      readonly jobId: string;
      readonly status: "succeeded";
      readonly outcome: ResponseOutcome;
    }
  | {
      readonly version: 1;
      readonly operation: "settle";
      readonly jobId: string;
      readonly status: "failed";
      readonly failure: { readonly code: string; readonly message: string };
    };

export interface ListOperation {
  readonly version: 1;
  readonly operation: "list";
  readonly status?: JobStatus;
  readonly limit: number;
  readonly cursor?: string;
}

export type JobOperation =
  | RunOperation
  | GetOperation
  | ListOperation
  | CancelOperation
  | SettleOperation;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobManifest {
  readonly version: 1;
  readonly jobId: string;
  readonly submission: {
    readonly canonicalHash: string;
    readonly instruction: string;
    readonly repositorySet: ReadonlyArray<unknown>;
  };
  readonly status: JobStatus;
  readonly transitions: ReadonlyArray<{
    readonly status: JobStatus;
    readonly timestamp: string;
  }>;
  readonly audit: {
    readonly submittedAt: string;
    readonly submittedBy: string;
  };
  readonly runtime: { readonly writerGeneration: number };
  readonly transcript: { readonly highestCursor: null };
  readonly failure?: { readonly code: string; readonly message: string };
  readonly outcome?: ResponseOutcome;
  readonly artifacts: Record<string, never>;
}

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

export class IdempotencyConflict extends Error {
  readonly code = "idempotency_conflict";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} already exists with different submission content`);
    this.name = "IdempotencyConflict";
  }
}

export class StaleManifest extends Error {
  readonly code = "stale_manifest";

  constructor(readonly jobId: string) {
    super(`Job ${jobId} was changed concurrently`);
    this.name = "StaleManifest";
  }
}

export class InvalidCursor extends Error {
  readonly code = "invalid_cursor";

  constructor() {
    super("Invalid Job list cursor");
    this.name = "InvalidCursor";
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
    throw new InvalidCursor();
  }
};

export const makeJobController = (dependencies: JobControllerDependencies): JobController => {
  const handle = async (operation: JobOperation): Promise<JobManifest | JobListPage> => {
    if (operation.operation === "list") {
      const offset = operation.cursor === undefined ? 0 : decodeCursor(operation.cursor, operation.status);
      const retained = (await dependencies.store.list())
        .map(({ manifest }) => manifest)
        .filter((manifest) => operation.status === undefined || manifest.status === operation.status)
        .sort((left, right) =>
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
    }

    if (operation.operation === "get") {
      const existing = await dependencies.store.read(operation.jobId);
      if (existing === undefined) throw new Error(`Job ${operation.jobId} not found`);
      return existing.manifest;
    }

    if (operation.operation === "settle") {
      const existing = await dependencies.store.read(operation.jobId);
      if (existing === undefined) throw new Error(`Job ${operation.jobId} not found`);
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
      if (existing === undefined) throw new Error(`Job ${operation.jobId} not found`);
      if (existing.manifest.status === "cancelled") return existing.manifest;
      if (existing.manifest.status !== "queued" && existing.manifest.status !== "running") {
        throw new Error(`Job ${operation.jobId} is not cancellable`);
      }
      const cancelled: JobManifest = {
        ...existing.manifest,
        status: "cancelled",
        transitions: [
          ...existing.manifest.transitions,
          { status: "cancelled", timestamp: dependencies.now() },
        ],
        failure: { code: "cancelled", message: "Job cancelled by user" },
      };
      const replaced = await dependencies.store.replace(
        operation.jobId,
        existing.etag,
        cancelled,
      );
      if (replaced === undefined) throw new StaleManifest(operation.jobId);
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
    throw new IdempotencyConflict(operation.jobId);
  };
  return { handle } as JobController;
};

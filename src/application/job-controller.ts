import { createHash } from "node:crypto";
import { Context, Effect, Schema } from "effect";
import type {
  ControlCancelOperation,
  ControlGetOperation,
  ControlListOperation,
  ControlRunOperation,
  JobListPage,
  JobManifest,
} from "../domain/schemas.js";
import {
  InvalidCursor,
  JobIdempotencyConflict,
  JobNotCancellable,
  JobNotFound,
  ManifestPersistenceError,
  StaleManifest,
} from "./services.js";

export { JobIdempotencyConflict as IdempotencyConflict } from "./services.js";

export type RunOperation = ControlRunOperation;
export type CancelOperation = ControlCancelOperation;
export type GetOperation = ControlGetOperation;
export type ListOperation = ControlListOperation;
export type JobStatus = JobManifest["status"];

export type StartOperation = {
  readonly version: 1;
  readonly operation: "start";
  readonly jobId: string;
  readonly microvmId: string;
  readonly writerGeneration: number;
};

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
  | StartOperation
  | SettleOperation;

export interface StoredManifest {
  readonly manifest: JobManifest;
  readonly etag: string;
}

export interface ManifestStoreService {
  readonly create: (
    manifest: JobManifest,
  ) => Effect.Effect<StoredManifest | undefined, ManifestPersistenceError>;
  readonly read: (
    jobId: string,
  ) => Effect.Effect<StoredManifest | undefined, ManifestPersistenceError>;
  readonly replace: (
    jobId: string,
    expectedEtag: string,
    manifest: JobManifest,
  ) => Effect.Effect<StoredManifest | undefined, ManifestPersistenceError>;
  readonly list: () => Effect.Effect<ReadonlyArray<StoredManifest>, ManifestPersistenceError>;
}

export class ManifestStore extends Context.Service<ManifestStore, ManifestStoreService>()(
  "fireclanker/ManifestStore",
) {}

const canonicalSubmission = (operation: RunOperation) =>
  JSON.stringify({
    instruction: operation.instruction,
    repositorySet: operation.repositorySet,
  });

const submissionHash = (operation: RunOperation) =>
  createHash("sha256").update(canonicalSubmission(operation)).digest("hex");

export class InMemoryManifestStore implements ManifestStoreService {
  readonly #manifests = new Map<string, StoredManifest>();

  get size() {
    return this.#manifests.size;
  }

  snapshot(jobId: string): StoredManifest | undefined {
    return this.#manifests.get(jobId);
  }

  readonly create = Effect.fn("ManifestStore.Memory.create")((manifest: JobManifest) =>
    Effect.sync(() => {
      if (this.#manifests.has(manifest.jobId)) return undefined;
      const stored = { manifest, etag: '"1"' };
      this.#manifests.set(manifest.jobId, stored);
      return stored;
    }),
  );

  readonly read = Effect.fn("ManifestStore.Memory.read")((jobId: string) =>
    Effect.sync(() => this.#manifests.get(jobId)),
  );

  readonly replace = Effect.fn("ManifestStore.Memory.replace")(
    (jobId: string, expectedEtag: string, manifest: JobManifest) =>
      Effect.sync(() => {
        const existing = this.#manifests.get(jobId);
        if (existing?.etag !== expectedEtag) return undefined;
        const revision = Number.parseInt(existing.etag.replaceAll('"', ""), 10) + 1;
        const stored = { manifest, etag: `"${revision}"` };
        this.#manifests.set(jobId, stored);
        return stored;
      }),
  );

  readonly list = Effect.fn("ManifestStore.Memory.list")(() =>
    Effect.sync(() => [...this.#manifests.values()]),
  );
}

export interface JobControllerDependencies {
  readonly store: ManifestStoreService;
  readonly now: Effect.Effect<string>;
  readonly submittedBy: Effect.Effect<string>;
  readonly wakeLaunch: (jobId: string) => Effect.Effect<void, ManifestPersistenceError>;
  readonly requestTermination: (microvmId: string) => Effect.Effect<void, ManifestPersistenceError>;
}

export interface JobControllerService {
  readonly handle: (
    operation: JobOperation,
  ) => Effect.Effect<
    JobManifest | JobListPage,
    | JobNotFound
    | JobNotCancellable
    | JobIdempotencyConflict
    | InvalidCursor
    | StaleManifest
    | ManifestPersistenceError
  >;
}

export class JobController extends Context.Service<JobController, JobControllerService>()(
  "fireclanker/JobController",
) {}

const encodeCursor = (offset: number, status: JobStatus | undefined) =>
  `cursor-${Buffer.from(JSON.stringify({ offset, status: status ?? null })).toString("base64url")}`;

const CursorPayloadSchema = Schema.Struct({
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: Schema.NullOr(Schema.Literals(["queued", "running", "succeeded", "failed", "cancelled"])),
});

const invalidCursor = () => new InvalidCursor({ message: "Invalid Job list cursor" });

const decodeCursor = Effect.fn("JobController.decodeCursor")(function* (
  cursor: string,
  status: JobStatus | undefined,
) {
  if (!cursor.startsWith("cursor-")) return yield* Effect.fail(invalidCursor());
  const input = yield* Effect.try({
    try: () => JSON.parse(Buffer.from(cursor.slice(7), "base64url").toString()),
    catch: invalidCursor,
  });
  const decoded = yield* Schema.decodeUnknownEffect(CursorPayloadSchema, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(invalidCursor));
  if (decoded.status !== (status ?? null)) return yield* Effect.fail(invalidCursor());
  return decoded.offset;
});

export const paginateJobManifests = (
  manifests: ReadonlyArray<JobManifest>,
  operation: ListOperation,
): Effect.Effect<JobListPage, InvalidCursor> => Effect.gen(function* () {
  const offset = operation.cursor === undefined ? 0 : yield* decodeCursor(operation.cursor, operation.status);
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
});

export const cancelJobManifest = (
  manifest: JobManifest,
  timestamp: string,
): Effect.Effect<JobManifest, JobNotCancellable> => Effect.gen(function* () {
  if (manifest.status === "cancelled") return manifest;
  if (manifest.status !== "queued" && manifest.status !== "running") {
    return yield* Effect.fail(new JobNotCancellable({ jobId: manifest.jobId }));
  }
  return {
    ...manifest,
    status: "cancelled",
    transitions: [...manifest.transitions, { status: "cancelled", timestamp }],
    failure: { code: "cancelled", message: "Job cancelled by user" },
  };
});

export const makeJobController = (dependencies: JobControllerDependencies): JobControllerService => {
  const handle = Effect.fn("JobController.handle")(function* (operation: JobOperation) {
    if (operation.operation === "list") {
      return yield* paginateJobManifests(
        (yield* dependencies.store.list()).map(({ manifest }) => manifest),
        operation,
      );
    }

    if (operation.operation === "get") {
      const existing = yield* dependencies.store.read(operation.jobId);
      if (existing === undefined) return yield* Effect.fail(new JobNotFound({ jobId: operation.jobId }));
      return existing.manifest;
    }

    if (operation.operation === "start") {
      const existing = yield* dependencies.store.read(operation.jobId);
      if (existing === undefined) return yield* Effect.fail(new JobNotFound({ jobId: operation.jobId }));
      if (existing.manifest.status === "cancelled") {
        yield* dependencies.requestTermination(operation.microvmId);
        return existing.manifest;
      }
      if (existing.manifest.status !== "queued") {
        return yield* Effect.fail(new StaleManifest({ jobId: operation.jobId }));
      }
      const running: JobManifest = {
        ...existing.manifest,
        status: "running",
        transitions: [
          ...existing.manifest.transitions,
          { status: "running", timestamp: yield* dependencies.now },
        ],
        runtime: {
          writerGeneration: operation.writerGeneration,
          microvmId: operation.microvmId,
        },
      };
      const replaced = yield* dependencies.store.replace(
        operation.jobId,
        existing.etag,
        running,
      );
      if (replaced === undefined) {
        const winner = yield* dependencies.store.read(operation.jobId);
        if (winner?.manifest.status === "cancelled") {
          yield* dependencies.requestTermination(operation.microvmId);
          return winner.manifest;
        }
        return yield* Effect.fail(new StaleManifest({ jobId: operation.jobId }));
      }
      return replaced.manifest;
    }

    if (operation.operation === "settle") {
      const existing = yield* dependencies.store.read(operation.jobId);
      if (existing === undefined) return yield* Effect.fail(new JobNotFound({ jobId: operation.jobId }));
      if (["succeeded", "failed", "cancelled"].includes(existing.manifest.status)) {
        return yield* Effect.fail(new StaleManifest({ jobId: operation.jobId }));
      }
      const terminal: JobManifest = {
        ...existing.manifest,
        status: operation.status,
        transitions: [
          ...existing.manifest.transitions,
          { status: operation.status, timestamp: yield* dependencies.now },
        ],
        ...(operation.status === "succeeded"
          ? { outcome: operation.outcome }
          : { failure: operation.failure }),
      };
      const replaced = yield* dependencies.store.replace(
        operation.jobId,
        existing.etag,
        terminal,
      );
      if (replaced === undefined) return yield* Effect.fail(new StaleManifest({ jobId: operation.jobId }));
      return replaced.manifest;
    }

    if (operation.operation === "cancel") {
      const existing = yield* dependencies.store.read(operation.jobId);
      if (existing === undefined) return yield* Effect.fail(new JobNotFound({ jobId: operation.jobId }));
      const cancelled = yield* cancelJobManifest(existing.manifest, yield* dependencies.now);
      if (cancelled === existing.manifest) return existing.manifest;
      const microvmId = existing.manifest.runtime.microvmId;
      const replaced = yield* dependencies.store.replace(
        operation.jobId,
        existing.etag,
        cancelled,
      );
      if (replaced === undefined) {
        const winner = yield* dependencies.store.read(operation.jobId);
        if (winner?.manifest.status === "cancelled") return winner.manifest;
        return yield* Effect.fail(new StaleManifest({ jobId: operation.jobId }));
      }
      if (microvmId !== undefined) yield* dependencies.requestTermination(microvmId);
      return replaced.manifest;
    }

    const canonicalHash = submissionHash(operation);
    const submittedAt = yield* dependencies.now;
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
      audit: { submittedAt, submittedBy: yield* dependencies.submittedBy },
      runtime: { writerGeneration: 0 },
      transcript: { highestCursor: null },
      artifacts: {},
    };

    const created = yield* dependencies.store.create(manifest);
    if (created !== undefined) {
      yield* dependencies.wakeLaunch(operation.jobId).pipe(Effect.catch(() => Effect.void));
      return created.manifest;
    }

    const existing = yield* dependencies.store.read(operation.jobId);
    if (existing?.manifest.submission.canonicalHash === canonicalHash) {
      return existing.manifest;
    }
    return yield* Effect.fail(new JobIdempotencyConflict({
      jobId: operation.jobId,
      message: `Job ${operation.jobId} already exists with different submission content`,
    }));
  });
  return JobController.of({ handle });
};

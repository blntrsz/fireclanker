import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import {
  DeploymentCore,
  DeploymentOperationFailure,
  JobControl,
  JobNotCancellable,
  JobNotFound,
  InvalidCursor,
  Pi,
  Time,
} from "../application/services.js";
import {
  ALCHEMY_SOURCE_REVISION,
  deploymentKey,
  deploymentResources,
  deriveDeploymentPlan,
  type DeploymentConfiguration,
  type DeploymentIdentity,
} from "../domain/deployment.js";
import {
  ExecutionTranscriptEventSchema,
  JobManifestSchema,
  JobStatusSchema,
  ResponseOutcomeSchema,
  type ExecutionTranscriptEvent,
  type JobManifest,
} from "../domain/schemas.js";

const timestamps = [
  "2000-01-01T00:00:00.000Z",
  "2000-01-01T00:00:01.000Z",
  "2000-01-01T00:00:02.000Z",
  "2000-01-01T00:00:03.000Z",
] as const;

const stateDirectory = () =>
  process.env.FIRECLANKER_TEST_STATE_DIRECTORY ?? join(process.cwd(), ".fireclanker-test-state");

const manifestPath = (jobId: string) => join(stateDirectory(), `${jobId}.json`);
const transcriptPath = (jobId: string) => join(stateDirectory(), `${jobId}.transcript.json`);

const readPersistedDocument = <A>(jobId: string, path: string, decode: (input: unknown) => A) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) throw new JobNotFound({ jobId });
      return decode(await file.json());
    },
    catch: (error) => (error instanceof JobNotFound ? error : new JobNotFound({ jobId })),
  });

const decodeManifest = Schema.decodeUnknownSync(JobManifestSchema, {
  onExcessProperty: "error",
});
const decodeTranscript = Schema.decodeUnknownSync(Schema.Array(ExecutionTranscriptEventSchema), {
  onExcessProperty: "error",
});

const readManifest = (jobId: string) =>
  readPersistedDocument(jobId, manifestPath(jobId), decodeManifest);

const readTranscript = (jobId: string) =>
  readPersistedDocument(jobId, transcriptPath(jobId), decodeTranscript);

const DeterministicPi = Layer.effect(
  Pi,
  Effect.succeed({
    complete: (instruction: string) =>
      Effect.succeed({
        version: 1 as const,
        kind: "response" as const,
        response: `Deterministic response to: ${instruction}`,
      }),
  }),
);

const DeterministicTime = Layer.effect(
  Time,
  Effect.sync(() => {
    let index = 0;
    return {
      now: Effect.sync(() => timestamps[index++] ?? timestamps.at(-1)!),
    };
  }),
);

const JobControlFromDeterministicServices = Layer.effect(
  JobControl,
  Effect.gen(function* () {
    const pi = yield* Pi;
    const time = yield* Time;
    return {
      submit: (operation) =>
        Effect.gen(function* () {
          const { instruction } = operation;
          const jobId = operation.jobId;
          const completion = yield* pi.complete(instruction);
          if (completion.kind !== "response") {
            return yield* Effect.die(
              new Error("The deterministic tracer only supports a Response Outcome"),
            );
          }
          const outcome = Schema.decodeUnknownSync(ResponseOutcomeSchema)({
            version: 1,
            kind: "response",
            response: completion.response,
          });
          const queuedAt = yield* time.now;
          const runningAt = yield* time.now;
          const outcomeAt = yield* time.now;
          const succeededAt = yield* time.now;
          const decodeStatus = Schema.decodeUnknownSync(JobStatusSchema, {
            onExcessProperty: "error",
          });
          const queued = decodeStatus({
            version: 1,
            jobId,
            status: "queued",
            timestamp: queuedAt,
          });
          const running = decodeStatus({
            version: 1,
            jobId,
            status: "running",
            timestamp: runningAt,
          });
          const succeeded = decodeStatus({
            version: 1,
            jobId,
            status: "succeeded",
            timestamp: succeededAt,
          });
          const manifest: JobManifest = {
            version: 1,
            jobId,
            submission: {
              canonicalHash: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify({ instruction, repositorySet: operation.repositorySet }))
                .digest("hex"),
              instruction,
              repositorySet: operation.repositorySet,
            },
            status: "succeeded",
            transitions: [
              { status: queued.status, timestamp: queued.timestamp },
              { status: running.status, timestamp: running.timestamp },
              { status: succeeded.status, timestamp: succeeded.timestamp },
            ],
            audit: {
              submittedAt: new Date().toISOString(),
              submittedBy: operation.submittedBy ?? "arn:aws:iam::123456789012:user/tester",
            },
            runtime: { writerGeneration: 0 },
            transcript: { highestCursor: "cursor-4" },
            outcome,
            artifacts: {},
          };
          const transcript: ReadonlyArray<ExecutionTranscriptEvent> = [
            {
              version: 1,
              sequence: 1,
              cursor: "cursor-1",
              timestamp: queuedAt,
              type: "status",
              jobId,
              status: queued.status,
            },
            {
              version: 1,
              sequence: 2,
              cursor: "cursor-2",
              timestamp: runningAt,
              type: "status",
              jobId,
              status: running.status,
            },
            {
              version: 1,
              sequence: 3,
              cursor: "cursor-3",
              timestamp: outcomeAt,
              type: "outcome",
              jobId,
              outcome,
            },
            {
              version: 1,
              sequence: 4,
              cursor: "cursor-4",
              timestamp: succeededAt,
              type: "status",
              jobId,
              status: succeeded.status,
            },
          ];

          Schema.decodeUnknownSync(JobManifestSchema)(manifest);
          Schema.decodeUnknownSync(Schema.Array(ExecutionTranscriptEventSchema))(transcript);
          yield* Effect.promise(() => mkdir(stateDirectory(), { recursive: true }));
          if (process.env.FIRECLANKER_TEST_EXECUTION_DISABLED === "1") {
            const { outcome: _outcome, ...accepted } = manifest;
            const queuedManifest: JobManifest = {
              ...accepted,
              status: "queued",
              transitions: [manifest.transitions[0]!],
              transcript: { highestCursor: null },
            };
            yield* Effect.promise(() =>
              Bun.write(manifestPath(jobId), JSON.stringify(queuedManifest)),
            );
            yield* Effect.promise(() => Bun.write(transcriptPath(jobId), "[]"));
            return queuedManifest;
          }
          yield* Effect.promise(() => Bun.write(manifestPath(jobId), JSON.stringify(manifest)));
          yield* Effect.promise(() => Bun.write(transcriptPath(jobId), JSON.stringify(transcript)));
          return manifest;
        }),
      get: (operation) => readManifest(operation.jobId),
      list: (operation) =>
        Effect.tryPromise({
          try: async () => {
            await mkdir(stateDirectory(), { recursive: true });
            const files = (await readdir(stateDirectory())).filter(
              (file) => /^job-[a-f0-9]{12}\.json$/.test(file),
            );
            const retained = (
              await Promise.all(files.map((file) => Bun.file(join(stateDirectory(), file)).json()))
            )
              .map((input) => decodeManifest(input))
              .filter(
                (manifest) => operation.status === undefined || manifest.status === operation.status,
              )
              .sort(
                (left, right) =>
                  right.audit.submittedAt.localeCompare(left.audit.submittedAt) ||
                  right.jobId.localeCompare(left.jobId),
              );
            let offset = 0;
            if (operation.cursor !== undefined) {
              try {
                const cursor = JSON.parse(
                  Buffer.from(operation.cursor.replace(/^cursor-/, ""), "base64url").toString(),
                ) as { offset: number; status: string | null };
                if (
                  !operation.cursor.startsWith("cursor-") ||
                  !Number.isInteger(cursor.offset) ||
                  cursor.offset < 0 ||
                  cursor.status !== (operation.status ?? null)
                ) {
                  throw new Error();
                }
                offset = cursor.offset;
              } catch {
                throw new InvalidCursor({ message: "Invalid Job list cursor" });
              }
            }
            const jobs = retained.slice(offset, offset + operation.limit);
            const nextOffset = offset + jobs.length;
            return {
              jobs,
              ...(nextOffset < retained.length
                ? {
                    nextCursor: `cursor-${Buffer.from(
                      JSON.stringify({ offset: nextOffset, status: operation.status ?? null }),
                    ).toString("base64url")}`,
                  }
                : {}),
            };
          },
          catch: (error) =>
            error instanceof InvalidCursor
              ? error
              : new InvalidCursor({ message: "Unable to list retained Jobs" }),
        }),
      cancel: (operation) =>
        Effect.tryPromise({
          try: async () => {
            const manifest = await Effect.runPromise(readManifest(operation.jobId));
            if (manifest.status === "cancelled") return manifest;
            if (manifest.status !== "queued" && manifest.status !== "running") {
              throw new JobNotCancellable({ jobId: operation.jobId });
            }
            const cancelled: JobManifest = {
              ...manifest,
              status: "cancelled",
              transitions: [
                ...manifest.transitions,
                { status: "cancelled", timestamp: new Date().toISOString() },
              ],
              failure: { code: "cancelled", message: "Job cancelled by user" },
            };
            await Bun.write(manifestPath(operation.jobId), JSON.stringify(cancelled));
            return cancelled;
          },
          catch: (error) =>
            error instanceof JobNotFound || error instanceof JobNotCancellable
              ? error
              : new JobNotFound({ jobId: operation.jobId }),
        }),
      watch: (operation) => readTranscript(operation.jobId),
    };
  }),
);

export const DeterministicJobControl = JobControlFromDeterministicServices.pipe(
  Layer.provide([DeterministicPi, DeterministicTime]),
);

interface PersistedDeployment {
  readonly configuration: DeploymentConfiguration;
  readonly tokenVersion: number;
  readonly controlAlias: "live";
}

type DeploymentState = Record<string, PersistedDeployment>;

const deploymentStatePath = () => join(stateDirectory(), "deployments.json");

const readDeploymentState = async (): Promise<DeploymentState> => {
  const file = Bun.file(deploymentStatePath());
  return (await file.exists()) ? ((await file.json()) as DeploymentState) : {};
};

const writeDeploymentState = async (state: DeploymentState) => {
  await mkdir(stateDirectory(), { recursive: true });
  await Bun.write(deploymentStatePath(), JSON.stringify(state));
};

const sameConfiguration = (left: DeploymentConfiguration, right: DeploymentConfiguration) =>
  JSON.stringify(left) === JSON.stringify(right);

const deploymentFailure = (error: unknown) =>
  error instanceof DeploymentOperationFailure
    ? error
    : new DeploymentOperationFailure({
        message: error instanceof Error ? error.message : "Deployment operation failed",
      });

export const DeterministicDeploymentCore = Layer.effect(
  DeploymentCore,
  Effect.succeed({
    resolveIdentity: (configuration: DeploymentConfiguration) =>
      Effect.succeed({
        accountId: "123456789012",
        region: configuration.region,
        name: configuration.name,
      }),
    plan: (operation, identity, configuration, rotateGitHubToken) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          const existing = state[deploymentKey(identity)];
          const derived = deriveDeploymentPlan({
            operation,
            exists: existing !== undefined,
            configurationMatches:
              existing !== undefined && sameConfiguration(existing.configuration, configuration),
            rotateGitHubToken,
          });
          return {
            operation,
            ...derived,
            identity,
            bootstrapBucket: `alchemy-assets-${identity.accountId}-${identity.region}-an`,
            statePrefix: `deployments/${identity.name}/`,
            resources: deploymentResources(identity.name),
            alchemyRevision: ALCHEMY_SOURCE_REVISION,
          } as const;
        },
        catch: deploymentFailure,
      }),
    apply: (plan, configuration, githubToken) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          const key = deploymentKey(plan.identity);
          const existing = state[key];
          if (plan.action === "no-op" && existing !== undefined && githubToken === undefined) {
            return { tokenVersion: existing.tokenVersion };
          }
          if (existing === undefined && githubToken === undefined) {
            throw new DeploymentOperationFailure({
              message: "First deployment requires a GitHub token; pass --github-token-stdin",
            });
          }
          const tokenVersion = (existing?.tokenVersion ?? 0) + (githubToken === undefined ? 0 : 1);
          state[key] = { configuration, tokenVersion, controlAlias: "live" };
          await writeDeploymentState(state);
          return { tokenVersion };
        },
        catch: deploymentFailure,
      }),
    destroy: (plan) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          delete state[deploymentKey(plan.identity)];
          await writeDeploymentState(state);
        },
        catch: deploymentFailure,
      }),
    verifyControlAlias: (identity: DeploymentIdentity) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          if (state[deploymentKey(identity)]?.controlAlias !== "live") {
            throw new Error(`Control Lambda live alias verification failed for ${identity.name}`);
          }
        },
        catch: deploymentFailure,
      }),
  }),
);

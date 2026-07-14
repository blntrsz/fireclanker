import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { JobControl, JobNotFound, Pi, Time } from "../application/services.js";
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
          const jobId = `job-${new Bun.CryptoHasher("sha256")
            .update(instruction)
            .digest("hex")
            .slice(0, 12)}`;
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
            instruction,
            repositorySet: [],
            status: "succeeded",
            transitions: [
              { status: queued.status, timestamp: queued.timestamp },
              { status: running.status, timestamp: running.timestamp },
              { status: succeeded.status, timestamp: succeeded.timestamp },
            ],
            highestTranscriptCursor: "cursor-4",
            outcome,
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
          yield* Effect.promise(() => Bun.write(manifestPath(jobId), JSON.stringify(manifest)));
          yield* Effect.promise(() => Bun.write(transcriptPath(jobId), JSON.stringify(transcript)));
          return manifest;
        }),
      get: (operation) => readManifest(operation.jobId),
      watch: (operation) => readTranscript(operation.jobId),
    };
  }),
);

export const DeterministicJobControl = JobControlFromDeterministicServices.pipe(
  Layer.provide([DeterministicPi, DeterministicTime]),
);

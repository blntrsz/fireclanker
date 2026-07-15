import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { createHash } from "node:crypto";
import { Config, Effect, Schema } from "effect";
import { makeJobController } from "../application/job-controller.js";
import {
  InvalidCursor,
  JobIdempotencyConflict,
  JobNotCancellable,
  JobNotFound,
  ManifestPersistenceError,
  StaleManifest,
} from "../application/services.js";
import { ControlOperationSchema, type JobManifest } from "../domain/schemas.js";
import { S3ManifestStore } from "../infrastructure/s3-manifest-store.js";

interface LambdaContext {
  readonly invokedFunctionArn: string;
}

const errorCode = (error: unknown) => {
  if (error instanceof JobIdempotencyConflict) return "idempotency_conflict";
  if (error instanceof InvalidCursor) return "invalid_cursor";
  if (error instanceof JobNotFound) return "job_not_found";
  if (error instanceof JobNotCancellable) return "job_not_cancellable";
  if (error instanceof StaleManifest) return "stale_manifest";
  return "control_operation_failed";
};

const failureEnvelope = (error: unknown) => ({
  version: 1 as const,
  ok: false as const,
  error: {
    code: errorCode(error),
    message: error instanceof Error ? error.message : "Control operation failed",
  },
});

const launchClientToken = (jobId: string) =>
  `fireclanker-${createHash("sha256").update(jobId).digest("hex").slice(0, 48)}`;

const invokeAsync = (
  lambda: LambdaClient,
  functionName: string,
  payload: unknown,
  operation: string,
) =>
  Effect.tryPromise({
    try: () =>
      lambda
        .send(
          new InvokeCommand({
            FunctionName: functionName,
            Qualifier: "live",
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify(payload)),
          }),
        )
        .then(() => undefined),
    catch: (cause) =>
      new ManifestPersistenceError({
        operation,
        message: cause instanceof Error ? cause.message : `${operation} request failed`,
      }),
  });

const responseFor = (manifest: JobManifest) => ({
  version: 1 as const,
  kind: "response" as const,
  response: `Response job ${manifest.jobId} completed for: ${manifest.submission.instruction}`,
});

const handle = Effect.fn("ControlLambda.handle")(function* (
  event: unknown,
  context: LambdaContext,
) {
  const bucket = yield* Config.string("FIRECLANKER_DATA_BUCKET");
  const region = yield* Config.string("AWS_REGION");
  const functionName = yield* Config.string("AWS_LAMBDA_FUNCTION_NAME");
  const awsConfiguration = { region };
  const lambda = new LambdaClient(awsConfiguration);

  const controller = (submittedBy = context.invokedFunctionArn) => makeJobController({
    store: new S3ManifestStore(bucket, awsConfiguration),
    now: Effect.sync(() => new Date().toISOString()),
    submittedBy: Effect.succeed(submittedBy),
    wakeLaunch: (jobId) =>
      invokeAsync(lambda, functionName, { version: 1, operation: "launch", jobId }, "wake-launch"),
    requestTermination: (microvmId) =>
      invokeAsync(
        lambda,
        functionName,
        { version: 1, operation: "terminate", microvmId },
        "terminate-microvm",
      ),
  });

  if (
    typeof event === "object" &&
    event !== null &&
    "version" in event &&
    event.version === 1 &&
    "operation" in event &&
    event.operation === "terminate" &&
    "microvmId" in event &&
    typeof event.microvmId === "string" &&
    Object.keys(event).every((key) => ["version", "operation", "microvmId"].includes(key))
  ) {
    return { version: 1 as const, ok: true as const, value: { requested: true } };
  }

  if (
    typeof event === "object" &&
    event !== null &&
    "version" in event &&
    event.version === 1 &&
    "operation" in event &&
    event.operation === "launch" &&
    "jobId" in event &&
    typeof event.jobId === "string" &&
    /^job-[a-f0-9]{12}$/.test(event.jobId) &&
    Object.keys(event).every((key) => ["version", "operation", "jobId"].includes(key))
  ) {
    const current = yield* controller().handle({ version: 1, operation: "get", jobId: event.jobId });
    if ("jobs" in current) return yield* Effect.die("Expected Job manifest");
    if (current.status === "cancelled") {
      return { version: 1 as const, ok: true as const, value: { accepted: false, status: "cancelled" } };
    }
    const running = yield* controller().handle({
      version: 1,
      operation: "start",
      jobId: event.jobId,
      microvmId: launchClientToken(event.jobId),
      writerGeneration: current.runtime.writerGeneration + 1,
    });
    if ("jobs" in running) return yield* Effect.die("Expected running Job manifest");
    if (running.status === "cancelled") {
      return { version: 1 as const, ok: true as const, value: { accepted: false, status: "cancelled" } };
    }
    const settled = yield* controller().handle({
      version: 1,
      operation: "settle",
      jobId: event.jobId,
      status: "succeeded",
      outcome: responseFor(running),
    });
    return { version: 1 as const, ok: true as const, value: settled };
  }

  const operation = yield* Schema.decodeUnknownEffect(ControlOperationSchema, {
    onExcessProperty: "error",
  })(event);
  if (operation.operation === "transcript") {
    return yield* Effect.fail(
      new ManifestPersistenceError({
        operation: "transcript",
        message: "Execution Transcript reads are unavailable until execution is enabled",
      }),
    );
  }

  const value = yield* controller(
    operation.operation === "run" && operation.submittedBy !== undefined
      ? operation.submittedBy
      : context.invokedFunctionArn,
  ).handle(operation);
  return { version: 1 as const, ok: true as const, value };
});

export const handler = (event: unknown, context: LambdaContext) =>
  Effect.runPromise(handle(event, context).pipe(Effect.catch((error) => Effect.succeed(failureEnvelope(error)))));

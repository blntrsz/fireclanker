import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
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
import { ControlOperationSchema } from "../domain/schemas.js";
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

const handle = Effect.fn("ControlLambda.handle")(function* (
  event: unknown,
  context: LambdaContext,
) {
  const bucket = yield* Config.string("FIRECLANKER_DATA_BUCKET");
  const region = yield* Config.string("AWS_REGION");
  const functionName = yield* Config.string("AWS_LAMBDA_FUNCTION_NAME");
  const awsConfiguration = { region };

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
    return { version: 1 as const, ok: true as const, value: { accepted: true } };
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

  const lambda = new LambdaClient(awsConfiguration);
  const controller = makeJobController({
    store: new S3ManifestStore(bucket, awsConfiguration),
    now: Effect.sync(() => new Date().toISOString()),
    submittedBy: Effect.succeed(
      operation.operation === "run" && operation.submittedBy !== undefined
        ? operation.submittedBy
        : context.invokedFunctionArn,
    ),
    wakeLaunch: (jobId) =>
      Effect.tryPromise({
        try: () =>
          lambda
            .send(
              new InvokeCommand({
                FunctionName: functionName,
                Qualifier: "live",
                InvocationType: "Event",
                Payload: Buffer.from(JSON.stringify({ version: 1, operation: "launch", jobId })),
              }),
            )
            .then(() => undefined),
        catch: (cause) =>
          new ManifestPersistenceError({
            operation: "wake-launch",
            message: cause instanceof Error ? cause.message : "Launch wake-up failed",
          }),
      }),
  });
  const value = yield* controller.handle(operation);
  return { version: 1 as const, ok: true as const, value };
});

export const handler = (event: unknown, context: LambdaContext) =>
  Effect.runPromise(handle(event, context).pipe(Effect.catch((error) => Effect.succeed(failureEnvelope(error)))));

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Schema } from "effect";
import {
  StaleManifest,
  makeJobController,
} from "../application/job-controller.js";
import {
  InvalidCursor,
  JobIdempotencyConflict,
  JobNotCancellable,
  JobNotFound,
} from "../application/services.js";
import { S3ManifestStore } from "../infrastructure/s3-manifest-store.js";
import { ControlOperationSchema } from "../domain/schemas.js";

interface LambdaContext {
  readonly invokedFunctionArn: string;
}

const bucket = process.env.FIRECLANKER_DATA_BUCKET;
if (bucket === undefined) throw new Error("FIRECLANKER_DATA_BUCKET is required");

const region = process.env.AWS_REGION;
const awsConfiguration = region === undefined ? {} : { region };
const store = new S3ManifestStore(bucket, awsConfiguration);
const lambda = new LambdaClient(awsConfiguration);

const errorCode = (error: unknown) => {
  if (error instanceof JobIdempotencyConflict) return "idempotency_conflict";
  if (error instanceof InvalidCursor) return "invalid_cursor";
  if (error instanceof JobNotFound) return "job_not_found";
  if (error instanceof JobNotCancellable) return "job_not_cancellable";
  if (error instanceof StaleManifest) return error.code;
  return "control_operation_failed";
};

export const handler = async (event: unknown, context: LambdaContext) => {
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
    return { version: 1, ok: true, value: { accepted: true } };
  }

  try {
    const operation = Schema.decodeUnknownSync(ControlOperationSchema, {
      onExcessProperty: "error",
    })(event);
    if (operation.operation === "transcript") {
      throw new Error("Execution Transcript reads are unavailable until execution is enabled");
    }
    const controller = makeJobController({
      store,
      now: () => new Date().toISOString(),
      submittedBy: () =>
        operation.operation === "run" && operation.submittedBy !== undefined
          ? operation.submittedBy
          : context.invokedFunctionArn,
      wakeLaunch: async (jobId) => {
        const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
        if (functionName === undefined) return;
        await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            Qualifier: "live",
            InvocationType: "Event",
            Payload: Buffer.from(JSON.stringify({ version: 1, operation: "launch", jobId })),
          }),
        );
      },
    });
    const value = await controller.handle(operation);
    return { version: 1, ok: true, value };
  } catch (error) {
    return {
      version: 1,
      ok: false,
      error: {
        code: errorCode(error),
        message: error instanceof Error ? error.message : "Control operation failed",
      },
    };
  }
};

import {
  DescribeSecretCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Effect, Layer, Schema } from "effect";
import {
  ConfigurationSource,
  DeploymentCore,
  DeploymentOperationFailure,
  DeploymentUnavailable,
  InvalidCursor,
  JobIdempotencyConflict,
  JobControl,
  JobNotCancellable,
  JobNotFound,
} from "../application/services.js";
import {
  ALCHEMY_SOURCE_REVISION,
  deploymentKey,
  type DeploymentConfiguration,
  type DeploymentIdentity,
} from "../domain/deployment.js";
import {
  applyAlchemyStack,
  type AmbientCredentials,
  bootstrapBucketName,
  controlPolicyDocument,
  dataBucketName,
  destroyAlchemyStack,
  githubSecretName,
  planAlchemyStack,
  verifyAlchemyControlAlias,
} from "../infrastructure/alchemy-core.js";
import {
  JobListPageSchema,
  JobManifestSchema,
  type ControlOperation,
} from "../domain/schemas.js";

const unavailable = () =>
  Effect.fail(
    new DeploymentUnavailable({
      message: "Deployment unavailable: no production Deployment adapter is configured",
    }),
  );

class ControlResponseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly jobId?: string,
  ) {
    super(message);
  }
}

const controlResponseFailure = (error: unknown) => {
  if (error instanceof ControlResponseError) {
    if (error.code === "job_not_found") return new JobNotFound({ jobId: error.jobId ?? "unknown" });
    if (error.code === "job_not_cancellable") {
      return new JobNotCancellable({ jobId: error.jobId ?? "unknown" });
    }
    if (error.code === "idempotency_conflict") {
      return new JobIdempotencyConflict({ jobId: error.jobId ?? "unknown", message: error.message });
    }
    if (error.code === "invalid_cursor") return new InvalidCursor({ message: error.message });
  }
  return new DeploymentUnavailable({
    message: error instanceof Error ? error.message : "Control Lambda invocation failed",
  });
};

export const ProductionJobControl = Layer.effect(
  JobControl,
  Effect.gen(function* () {
    const configurationSource = yield* ConfigurationSource;
    const invoke = (operation: ControlOperation, configurationPath: string | undefined) =>
      Effect.gen(function* () {
        const configuration = yield* configurationSource.load(configurationPath);
        return yield* Effect.tryPromise({
          try: async () => {
            let envelope: unknown = operation;
            if (operation.operation === "run") {
              const caller = await new STSClient({ region: configuration.region }).send(
                new GetCallerIdentityCommand({}),
              );
              envelope = { ...operation, ...(caller.Arn === undefined ? {} : { submittedBy: caller.Arn }) };
            }
            const response = await new LambdaClient({ region: configuration.region }).send(
              new InvokeCommand({
                FunctionName: `fireclanker-${configuration.name}-control`,
                Qualifier: "live",
                InvocationType: "RequestResponse",
                Payload: Buffer.from(JSON.stringify(envelope)),
              }),
            );
            if (response.FunctionError !== undefined || response.Payload === undefined) {
              throw new Error(response.FunctionError ?? "Control Lambda returned no payload");
            }
            const decoded = JSON.parse(Buffer.from(response.Payload).toString()) as {
              version?: number;
              ok?: boolean;
              value?: unknown;
              error?: { code?: string; message?: string };
            };
            if (decoded.version !== 1 || decoded.ok !== true) {
              throw new ControlResponseError(
                decoded.error?.code ?? "control_operation_failed",
                decoded.error?.message ?? "Control Lambda rejected the operation",
                "jobId" in operation ? operation.jobId : undefined,
              );
            }
            return decoded.value;
          },
          catch: controlResponseFailure,
        });
      });

    return {
      submit: (operation, configurationPath) =>
        invoke(operation, configurationPath).pipe(
          Effect.map((value) =>
            Schema.decodeUnknownSync(JobManifestSchema, { onExcessProperty: "error" })(value),
          ),
        ),
      get: (operation, configurationPath) =>
        invoke(operation, configurationPath).pipe(
          Effect.map((value) =>
            Schema.decodeUnknownSync(JobManifestSchema, { onExcessProperty: "error" })(value),
          ),
        ),
      list: (operation, configurationPath) =>
        invoke(operation, configurationPath).pipe(
          Effect.map((value) =>
            Schema.decodeUnknownSync(JobListPageSchema, { onExcessProperty: "error" })(value),
          ),
        ),
      cancel: (operation, configurationPath) =>
        invoke(operation, configurationPath).pipe(
          Effect.map((value) =>
            Schema.decodeUnknownSync(JobManifestSchema, { onExcessProperty: "error" })(value),
          ),
        ),
      watch: unavailable,
    };
  }),
);

const deploymentFailure = (error: unknown) =>
  error instanceof DeploymentOperationFailure
    ? error
    : new DeploymentOperationFailure({
        message: error instanceof Error ? error.message : "AWS Deployment operation failed",
      });

export const ProductionDeploymentCore = Layer.effect(
  DeploymentCore,
  Effect.sync(() => {
    const plannedConfigurations = new Map<string, DeploymentConfiguration>();
    const plannedCredentials = new Map<string, AmbientCredentials>();
    return {
      resolveIdentity: (configuration: DeploymentConfiguration) =>
        Effect.tryPromise({
          try: async () => {
            const resolved = await defaultProvider()();
            const credentials: AmbientCredentials = {
              accessKeyId: resolved.accessKeyId,
              secretAccessKey: resolved.secretAccessKey,
              ...(resolved.sessionToken === undefined ? {} : { sessionToken: resolved.sessionToken }),
            };
            const identity = await new STSClient({
              region: configuration.region,
              credentials,
            }).send(
              new GetCallerIdentityCommand({}),
            );
            if (identity.Account === undefined) throw new Error("STS did not return an account ID");
            const deploymentIdentity = {
              accountId: identity.Account,
              region: configuration.region,
              name: configuration.name,
            };
            plannedCredentials.set(deploymentKey(deploymentIdentity), credentials);
            return deploymentIdentity;
          },
          catch: deploymentFailure,
        }),
      plan: (operation, identity, configuration, rotateGitHubToken) =>
        Effect.tryPromise({
          try: async () => {
            plannedConfigurations.set(deploymentKey(identity), configuration);
            const credentials = plannedCredentials.get(deploymentKey(identity));
            if (credentials === undefined) throw new Error("Ambient AWS credentials were not resolved");
            const s3 = new S3Client({ region: identity.region, credentials });
            let bootstrapExists = true;
            try {
              await s3.send(new HeadBucketCommand({ Bucket: bootstrapBucketName(identity) }));
            } catch (error) {
              if (error instanceof NotFound || (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
                bootstrapExists = false;
              } else {
                throw error;
              }
            }
            const alchemyPlan = await planAlchemyStack(
              operation,
              configuration,
              identity,
              credentials,
              bootstrapExists,
            );
            let hasGitHubToken = false;
            try {
              const secret = await new SecretsManagerClient({
                region: identity.region,
                credentials,
              }).send(
                new DescribeSecretCommand({ SecretId: githubSecretName(identity) }),
              );
              hasGitHubToken = Object.keys(secret.VersionIdsToStages ?? {}).length > 0;
            } catch (error) {
              if (error instanceof ResourceNotFoundException) hasGitHubToken = false;
              else throw error;
            }
            const tokenUpdate = operation === "deploy" && (!hasGitHubToken || rotateGitHubToken);
            const imperativeResources: string[] = [];
            if (operation === "deploy") {
              try {
                const current = await s3.send(
                  new GetObjectCommand({
                    Bucket: dataBucketName(identity),
                    Key: "runtime-configuration.json",
                  }),
                );
                if ((await current.Body?.transformToString()) !== JSON.stringify(configuration)) {
                  imperativeResources.push("update AWS.S3.Object runtime-configuration.json");
                }
              } catch (error) {
                if (
                  error instanceof NoSuchKey ||
                  error instanceof NoSuchBucket ||
                  (error as { $metadata?: { httpStatusCode?: number } }).$metadata
                    ?.httpStatusCode === 404
                ) {
                  imperativeResources.push("create AWS.S3.Object runtime-configuration.json");
                } else {
                  throw error;
                }
              }

              if (alchemyPlan.controlRoleName === undefined) {
                imperativeResources.push("create AWS.IAM.RolePolicy fireclanker-control");
              } else {
                try {
                  const current = await new IAMClient({ region: identity.region, credentials }).send(
                    new GetRolePolicyCommand({
                      RoleName: alchemyPlan.controlRoleName,
                      PolicyName: "fireclanker-control",
                    }),
                  );
                  const observed = JSON.parse(decodeURIComponent(current.PolicyDocument ?? "{}"));
                  if (JSON.stringify(observed) !== JSON.stringify(controlPolicyDocument(identity))) {
                    imperativeResources.push("update AWS.IAM.RolePolicy fireclanker-control");
                  }
                } catch (error) {
                  if (error instanceof NoSuchEntityException) {
                    imperativeResources.push("create AWS.IAM.RolePolicy fireclanker-control");
                  } else {
                    throw error;
                  }
                }
              }

              const lambda = new LambdaClient({ region: identity.region, credentials });
              try {
                const alias = await lambda.send(
                  new GetAliasCommand({
                    FunctionName: `fireclanker-${identity.name}-control`,
                    Name: "live",
                  }),
                );
                const [qualified, latest] = await Promise.all([
                  lambda.send(
                    new GetFunctionCommand({
                      FunctionName: `fireclanker-${identity.name}-control`,
                      Qualifier: alias.FunctionVersion,
                    }),
                  ),
                  lambda.send(
                    new GetFunctionCommand({
                      FunctionName: `fireclanker-${identity.name}-control`,
                    }),
                  ),
                ]);
                if (qualified.Configuration?.CodeSha256 !== latest.Configuration?.CodeSha256) {
                  imperativeResources.push("update AWS.Lambda.Alias live");
                }
              } catch (error) {
                if (error instanceof LambdaNotFound) {
                  imperativeResources.push("create AWS.Lambda.Alias live");
                } else {
                  throw error;
                }
              }
            } else if (alchemyPlan.action !== "no-op") {
              imperativeResources.push(
                "delete AWS.S3.Object runtime-configuration.json",
                "delete AWS.IAM.RolePolicy fireclanker-control",
                "delete AWS.Lambda.Alias live",
              );
            }
            return {
              operation,
              action:
                (tokenUpdate || imperativeResources.length > 0) && alchemyPlan.action === "no-op"
                  ? "update"
                  : alchemyPlan.action,
              identity,
              bootstrapBucket: bootstrapBucketName(identity),
              statePrefix: `deployments/${identity.name}/`,
              resources: [
                ...alchemyPlan.resources,
                ...imperativeResources,
                ...(tokenUpdate ? ["update AWS.SecretsManager.Secret GitHubPat value"] : []),
              ],
              requiresGitHubToken: tokenUpdate,
              alchemyRevision: ALCHEMY_SOURCE_REVISION,
            } as const;
          },
          catch: deploymentFailure,
        }),
      apply: (plan, configuration, githubToken) =>
        Effect.tryPromise({
          try: async () => {
            const credentials = plannedCredentials.get(deploymentKey(plan.identity));
            if (credentials === undefined) throw new Error("Ambient AWS credentials were not resolved");
            if (plan.action !== "no-op" || githubToken !== undefined) {
              await applyAlchemyStack(configuration, plan.identity, credentials, githubToken);
            }
            return { tokenVersion: githubToken === undefined ? 0 : 1 };
          },
          catch: deploymentFailure,
        }),
      destroy: (plan) =>
        Effect.tryPromise({
          try: async () => {
            const configuration = plannedConfigurations.get(deploymentKey(plan.identity));
            const credentials = plannedCredentials.get(deploymentKey(plan.identity));
            if (configuration === undefined) throw new Error("Deployment was not planned");
            if (credentials === undefined) throw new Error("Ambient AWS credentials were not resolved");
            if (plan.action !== "no-op") {
              await destroyAlchemyStack(configuration, plan.identity, credentials);
            }
          },
          catch: deploymentFailure,
        }),
      verifyControlAlias: (identity: DeploymentIdentity) =>
        Effect.tryPromise({
          try: () => {
            const credentials = plannedCredentials.get(deploymentKey(identity));
            if (credentials === undefined) throw new Error("Ambient AWS credentials were not resolved");
            return verifyAlchemyControlAlias(identity, credentials);
          },
          catch: deploymentFailure,
        }),
    };
  }),
);
import { GetRolePolicyCommand, IAMClient, NoSuchEntityException } from "@aws-sdk/client-iam";
import { GetAliasCommand, GetFunctionCommand, ResourceNotFoundException as LambdaNotFound } from "@aws-sdk/client-lambda";
import {
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchBucket,
  NoSuchKey,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";

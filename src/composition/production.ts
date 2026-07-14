import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  DescribeSecretCommand,
  ResourceNotFoundException,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { Effect, Layer } from "effect";
import {
  DeploymentCore,
  DeploymentOperationFailure,
  DeploymentUnavailable,
  JobControl,
} from "../application/services.js";
import {
  ALCHEMY_SOURCE_REVISION,
  deploymentKey,
  deploymentResources,
  type DeploymentConfiguration,
  type DeploymentIdentity,
} from "../domain/deployment.js";
import {
  applyAlchemyStack,
  bootstrapBucketName,
  dataBucketName,
  destroyAlchemyStack,
  githubSecretName,
  verifyAlchemyControlAlias,
} from "../infrastructure/alchemy-core.js";

const unavailable = () =>
  Effect.fail(
    new DeploymentUnavailable({
      message: "Deployment unavailable: no production Deployment adapter is configured",
    }),
  );

export const ProductionJobControl = Layer.effect(
  JobControl,
  Effect.succeed({
    submit: unavailable,
    get: unavailable,
    watch: unavailable,
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
    return {
      resolveIdentity: (configuration: DeploymentConfiguration) =>
        Effect.tryPromise({
          try: async () => {
            const identity = await new STSClient({ region: configuration.region }).send(
              new GetCallerIdentityCommand({}),
            );
            if (identity.Account === undefined) throw new Error("STS did not return an account ID");
            return {
              accountId: identity.Account,
              region: configuration.region,
              name: configuration.name,
            };
          },
          catch: deploymentFailure,
        }),
      plan: (operation, identity, configuration, rotateGitHubToken) =>
        Effect.tryPromise({
          try: async () => {
            plannedConfigurations.set(deploymentKey(identity), configuration);
            let exists = true;
            try {
              await new SecretsManagerClient({ region: identity.region }).send(
                new DescribeSecretCommand({ SecretId: githubSecretName(identity) }),
              );
            } catch (error) {
              if (error instanceof ResourceNotFoundException) exists = false;
              else throw error;
            }

            let configurationMatches = false;
            if (exists) {
              try {
                const current = await new S3Client({ region: identity.region }).send(
                  new GetObjectCommand({
                    Bucket: dataBucketName(identity),
                    Key: "runtime-configuration.json",
                  }),
                );
                configurationMatches =
                  (await current.Body?.transformToString()) === JSON.stringify(configuration);
              } catch {
                configurationMatches = false;
              }
            }

            const action =
              operation === "destroy"
                ? exists
                  ? "delete"
                  : "no-op"
                : !exists
                  ? "create"
                  : configurationMatches && !rotateGitHubToken
                    ? "no-op"
                    : "update";
            return {
              operation,
              action,
              identity,
              bootstrapBucket: bootstrapBucketName(identity),
              statePrefix: `deployments/${identity.name}/`,
              resources: deploymentResources(identity.name),
              requiresGitHubToken:
                operation === "deploy" && (!exists || rotateGitHubToken),
              alchemyRevision: ALCHEMY_SOURCE_REVISION,
            } as const;
          },
          catch: deploymentFailure,
        }),
      apply: (plan, configuration, githubToken) =>
        Effect.tryPromise({
          try: async () => {
            if (plan.action !== "no-op" || githubToken !== undefined) {
              await applyAlchemyStack(configuration, plan.identity, githubToken);
            }
            return { tokenVersion: githubToken === undefined ? 0 : 1 };
          },
          catch: deploymentFailure,
        }),
      destroy: (plan) =>
        Effect.tryPromise({
          try: async () => {
            const configuration = plannedConfigurations.get(deploymentKey(plan.identity));
            if (configuration === undefined) throw new Error("Deployment was not planned");
            if (plan.action !== "no-op") await destroyAlchemyStack(configuration, plan.identity);
          },
          catch: deploymentFailure,
        }),
      verifyControlAlias: (identity: DeploymentIdentity) =>
        Effect.tryPromise({
          try: () => verifyAlchemyControlAlias(identity),
          catch: deploymentFailure,
        }),
    };
  }),
);

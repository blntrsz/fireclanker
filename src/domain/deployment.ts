export const ALCHEMY_SOURCE_REVISION = "c999680eedb38aa1e311c65d8dd9ef67c785b9b8" as const;

export const supportedRegions = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "ap-northeast-1",
  "eu-west-1",
] as const;

export type SupportedRegion = (typeof supportedRegions)[number];
export type SupportedModel = "gpt-5.5" | "claude-sonnet-5" | "claude-opus-4.8";

export interface DeploymentConfiguration {
  readonly version: 1;
  readonly name: string;
  readonly region: SupportedRegion;
  readonly model: SupportedModel;
  readonly repositoryCatalog: ReadonlyArray<string>;
  readonly retentionDays: number;
}

export interface DeploymentIdentity {
  readonly accountId: string;
  readonly region: SupportedRegion;
  readonly name: string;
}

export interface DeploymentPlan {
  readonly operation: "deploy" | "destroy";
  readonly action: "create" | "update" | "no-op" | "delete";
  readonly identity: DeploymentIdentity;
  readonly bootstrapBucket: string;
  readonly statePrefix: string;
  readonly resources: ReadonlyArray<string>;
  readonly requiresGitHubToken: boolean;
  readonly alchemyRevision: typeof ALCHEMY_SOURCE_REVISION;
}

export const deriveDeploymentPlan = ({
  configurationMatches,
  exists,
  operation,
  rotateGitHubToken,
}: {
  readonly configurationMatches: boolean;
  readonly exists: boolean;
  readonly operation: "deploy" | "destroy";
  readonly rotateGitHubToken: boolean;
}): Pick<DeploymentPlan, "action" | "requiresGitHubToken"> => ({
  action:
    operation === "destroy"
      ? exists
        ? "delete"
        : "no-op"
      : !exists
        ? "create"
        : configurationMatches && !rotateGitHubToken
          ? "no-op"
          : "update",
  requiresGitHubToken: operation === "deploy" && (!exists || rotateGitHubToken),
});

export const deploymentKey = (identity: DeploymentIdentity) =>
  `${identity.accountId}/${identity.region}/${identity.name}`;

export const deploymentResources = (name: string): ReadonlyArray<string> => [
  `S3 data bucket fireclanker-${name}-data with Lifecycle expiration`,
  `normalized runtime configuration deployments/${name}/runtime-configuration.json`,
  `Control Lambda fireclanker-${name}-control and live alias`,
  "build, Control, and runner IAM roles with scoped policies",
  "Control, build, and runner CloudWatch log groups",
  "empty Secrets Manager GitHub PAT resource",
  "pinned ARM64 Lambda MicroVM image with /ready and /run hooks",
];

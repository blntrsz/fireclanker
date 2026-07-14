import { PutRolePolicyCommand, IAMClient } from "@aws-sdk/client-iam";
import {
  CreateAliasCommand,
  GetAliasCommand,
  LambdaClient,
  PublishVersionCommand,
  UpdateAliasCommand,
} from "@aws-sdk/client-lambda";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import * as AWS from "alchemy/AWS";
import { Assets } from "alchemy/AWS";
import * as Plan from "alchemy/Plan";
import { evalStack, Stack } from "alchemy/Stack";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { localState } from "alchemy/State/LocalState";
import * as Test from "alchemy/Test/Core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeploymentConfiguration, DeploymentIdentity } from "../domain/deployment.js";

export interface AmbientCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

const controlHandler = `
export const handler = async (event: unknown) => ({
  statusCode: 200,
  body: JSON.stringify({ version: 1, accepted: true, event })
});
`;

const runtimeDockerfile = `FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y python3 && dnf clean all
WORKDIR /app
COPY app.py .
EXPOSE 8080
CMD ["python3", "-u", "app.py"]
`;

const runtimeApplication = `
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        if self.path.endswith("/ready") or self.path.endswith("/run"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ready")
            return
        self.send_response(404)
        self.end_headers()
    def log_message(self, format, *args):
        return

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
`;

export const bootstrapBucketName = (identity: DeploymentIdentity) =>
  `alchemy-assets-${identity.accountId}-${identity.region}-an`;

export const dataBucketName = (identity: DeploymentIdentity) =>
  `fireclanker-${identity.accountId}-${identity.region}-${identity.name}-data`;

export const githubSecretName = (identity: DeploymentIdentity) =>
  `fireclanker/${identity.name}/github-pat`;

const prepareEmbeddedAssets = async (configuration: DeploymentConfiguration) => {
  const hash = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(configuration))
    .update(controlHandler)
    .update(runtimeDockerfile)
    .update(runtimeApplication)
    .digest("hex");
  const root = join(tmpdir(), "fireclanker-alchemy", hash);
  const image = join(root, "image");
  await mkdir(image, { recursive: true });
  const control = join(root, "control.ts");
  await Bun.write(control, controlHandler);
  await Bun.write(join(image, "Dockerfile"), runtimeDockerfile);
  await Bun.write(join(image, "app.py"), runtimeApplication);
  return { control, image };
};

const lambdaTrust: AWS.IAM.PolicyDocument = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: ["sts:AssumeRole", "sts:TagSession"],
    },
  ],
};

const createStack = (
  configuration: DeploymentConfiguration,
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
  assets: Awaited<ReturnType<typeof prepareEmbeddedAssets>>,
) => {
  const bootstrapBucket = bootstrapBucketName(identity);
  const dataBucket = dataBucketName(identity);
  const secretName = githubSecretName(identity);
  const prefix = `deployments/${identity.name}`;

  return Stack(
    `Fireclanker-${identity.name}`,
    {
      providers: namedProviders(identity, credentials),
      state: AWS.state({ bucketName: bootstrapBucket, prefix: `${prefix}/` }),
    },
    Effect.gen(function* () {
      yield* AWS.S3.Bucket("Data", {
        bucketName: dataBucket,
        forceDestroy: true,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
        lifecycleRules: [
          {
            ID: "ExpireRetainedJobs",
            Status: "Enabled",
            Filter: { Prefix: "jobs/" },
            Expiration: { Days: configuration.retentionDays },
          },
        ],
        tags: { deployment: identity.name },
      });

      yield* AWS.Logs.LogGroup("ControlLogs", {
        logGroupName: `/aws/lambda/fireclanker-${identity.name}-control`,
        retentionInDays: 30,
      });
      yield* AWS.Logs.LogGroup("BuildLogs", {
        logGroupName: `/fireclanker/${identity.name}/build`,
        retentionInDays: 30,
      });
      yield* AWS.Logs.LogGroup("RunnerLogs", {
        logGroupName: `/fireclanker/${identity.name}/runner`,
        retentionInDays: 30,
      });

      const buildRole = yield* AWS.IAM.Role("BuildRole", {
        roleName: `fireclanker-${identity.name}-build`,
        assumeRolePolicyDocument: lambdaTrust,
        inlinePolicies: {
          assets: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetObject"], Resource: [`arn:aws:s3:::${bootstrapBucket}/${prefix}/assets/*`] },
              { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:aws:logs:${identity.region}:${identity.accountId}:log-group:/fireclanker/${identity.name}/build:*`] },
            ],
          },
        },
      });

      yield* AWS.IAM.Role("RunnerRole", {
        roleName: `fireclanker-${identity.name}-runner`,
        assumeRolePolicyDocument: lambdaTrust,
        inlinePolicies: {
          runtime: {
            Version: "2012-10-17",
            Statement: [
              { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket"], Resource: [`arn:aws:s3:::${dataBucket}`, `arn:aws:s3:::${dataBucket}/jobs/*`] },
              { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [`arn:aws:secretsmanager:${identity.region}:${identity.accountId}:secret:${secretName}*`] },
              { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [`arn:aws:lambda:${identity.region}:${identity.accountId}:function:fireclanker-${identity.name}-control:live`] },
              { Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: ["*"] },
              { Effect: "Allow", Action: ["logs:CreateLogStream", "logs:PutLogEvents"], Resource: [`arn:aws:logs:${identity.region}:${identity.accountId}:log-group:/fireclanker/${identity.name}/runner:*`] },
            ],
          },
        },
      });

      yield* AWS.SecretsManager.Secret("GitHubPat", {
        name: secretName,
        description: `GitHub PAT for Fireclanker Deployment ${identity.name}`,
        tags: { deployment: identity.name },
      });

      const control = yield* AWS.Lambda.Function("Control", {
        main: assets.control,
        handler: "handler",
        functionName: `fireclanker-${identity.name}-control`,
        architecture: "arm64",
        runtime: "nodejs22.x",
        url: false,
        env: {
          FIRECLANKER_CONFIGURATION_BUCKET: dataBucket,
          FIRECLANKER_CONFIGURATION_KEY: "runtime-configuration.json",
        },
      });

      yield* AWS.Lambda.MicrovmImage("RunnerImage", {
        name: `fireclanker-${identity.name}-runner`,
        context: assets.image,
        buildRole,
        resources: [{ minimumMemoryInMiB: 512 }],
        cpuConfigurations: [{ architecture: "ARM_64" }],
        hooks: {
          port: 8080,
          microvmImageHooks: { ready: "ENABLED", readyTimeoutInSeconds: 30 },
          microvmHooks: { run: "ENABLED", runTimeoutInSeconds: 30 },
        },
        tags: { deployment: identity.name, content: assets.image.split("/").at(-2)! },
      });

      return { controlRoleName: control.roleName, controlFunctionName: control.functionName };
    }),
  );
};

const namedAssets = (identity: DeploymentIdentity, credentials: AmbientCredentials) => {
  const bucketName = bootstrapBucketName(identity);
  const key = (hash: string) => `deployments/${identity.name}/assets/lambda/${hash}.zip`;
  const client = new S3Client({ region: identity.region, credentials });
  return Layer.succeed(Assets, {
    bucketName: Effect.succeed(bucketName),
    uploadAsset: (hash: string, content: Uint8Array) =>
      Effect.tryPromise({
        try: async () => {
          const assetKey = key(hash);
          try {
            await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: assetKey }));
          } catch (error) {
            if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) {
              throw error;
            }
            await client.send(
              new PutObjectCommand({
                Bucket: bucketName,
                Key: assetKey,
                Body: content,
                ContentType: "application/zip",
              }),
            );
          }
          return assetKey;
        },
        catch: (cause) => ({
          _tag: "AssetsUploadError" as const,
          message: `Failed to upload deployment asset ${hash}`,
          cause,
        }),
      }),
    hasAsset: (hash: string) =>
      Effect.tryPromise({
        try: async () => {
          try {
            await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key(hash) }));
            return true;
          } catch (error) {
            if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
              return false;
            }
            throw error;
          }
        },
        catch: (cause) => ({
          _tag: "AssetsCheckError" as const,
          message: `Failed to check deployment asset ${hash}`,
          cause,
        }),
      }),
  });
};

const namedProviders = (identity: DeploymentIdentity, credentials: AmbientCredentials) =>
  Layer.merge(AWS.providers(), namedAssets(identity, credentials));

const withExplicitAccount = async <A>(
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
  run: () => Promise<A>,
) => {
  const previous = {
    account: process.env.AWS_ACCOUNT_ID,
    region: process.env.AWS_REGION,
    defaultRegion: process.env.AWS_DEFAULT_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    ci: process.env.CI,
  };
  process.env.AWS_ACCOUNT_ID = identity.accountId;
  process.env.AWS_REGION = identity.region;
  process.env.AWS_DEFAULT_REGION = identity.region;
  process.env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
  if (credentials.sessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
  else process.env.AWS_SESSION_TOKEN = credentials.sessionToken;
  process.env.CI = "1";
  try {
    return await run();
  } finally {
    if (previous.account === undefined) delete process.env.AWS_ACCOUNT_ID;
    else process.env.AWS_ACCOUNT_ID = previous.account;
    if (previous.region === undefined) delete process.env.AWS_REGION;
    else process.env.AWS_REGION = previous.region;
    if (previous.defaultRegion === undefined) delete process.env.AWS_DEFAULT_REGION;
    else process.env.AWS_DEFAULT_REGION = previous.defaultRegion;
    if (previous.accessKeyId === undefined) delete process.env.AWS_ACCESS_KEY_ID;
    else process.env.AWS_ACCESS_KEY_ID = previous.accessKeyId;
    if (previous.secretAccessKey === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previous.secretAccessKey;
    if (previous.sessionToken === undefined) delete process.env.AWS_SESSION_TOKEN;
    else process.env.AWS_SESSION_TOKEN = previous.sessionToken;
    if (previous.ci === undefined) delete process.env.CI;
    else process.env.CI = previous.ci;
  }
};

const options = (
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
  state: NonNullable<Test.MakeOptions["state"]> = AWS.state({
    bucketName: bootstrapBucketName(identity),
    prefix: `deployments/${identity.name}/`,
  }),
) => ({
  providers: namedProviders(identity, credentials),
  state,
  stage: "live",
  // Select a profile that can only correspond to the credentials resolved for
  // this invocation. In CI mode Alchemy configures a missing profile from the
  // explicit environment values installed by withExplicitAccount.
  profile: `fireclanker-ambient-${new Bun.CryptoHasher("sha256")
    .update(identity.accountId)
    .update(identity.region)
    .update(credentials.accessKeyId)
    .update(credentials.secretAccessKey)
    .update(credentials.sessionToken ?? "")
    .digest("hex")
    .slice(0, 16)}`,
});

export interface AlchemyPlanSummary {
  readonly action: "create" | "update" | "no-op" | "delete";
  readonly resources: ReadonlyArray<string>;
  readonly controlRoleName?: string;
}

export const planAlchemyStack = async (
  operation: "deploy" | "destroy",
  configuration: DeploymentConfiguration,
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
  bootstrapExists: boolean,
): Promise<AlchemyPlanSummary> =>
  withExplicitAccount(identity, credentials, async () => {
    const assets = await prepareEmbeddedAssets(configuration);
    const coreOptions = options(
      identity,
      credentials,
      bootstrapExists ? undefined : inMemoryState(),
    );
    const stack = createStack(configuration, identity, credentials, assets);
    const effect = evalStack(
      stack,
      (compiled) =>
        Plan.make(
          (operation === "destroy"
            ? { ...compiled, resources: {}, bindings: {}, actions: {}, output: {} }
            : compiled) as any,
        ),
      { stage: coreOptions.stage },
    );
    const plan = await Test.run(effect, coreOptions);
    const nodes = [
      ...Object.entries(plan.resources),
      ...Object.entries(plan.deletions).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
      ),
    ];
    const resources = nodes.map(
      ([fqn, node]) => `${node.action} ${node.resource.Type} ${fqn}`,
    );
    const actions = nodes.map(([, node]) => node.action);
    const controlNode = nodes.find(([, node]) => node.resource.Type === "AWS.Lambda.Function")?.[1];
    const controlRoleName = (controlNode?.state as { attr?: { roleName?: string } } | undefined)?.attr
      ?.roleName;
    const action =
      operation === "destroy"
        ? actions.includes("delete")
          ? "delete"
          : "no-op"
        : actions.includes("create")
          ? "create"
          : actions.some((action) => action === "update" || action === "replace")
            ? "update"
            : "no-op";
    return {
      action,
      resources: [
        ...(bootstrapExists ? [] : [`create AWS.S3.Bucket ${bootstrapBucketName(identity)}`]),
        ...resources,
      ],
      ...(controlRoleName === undefined ? {} : { controlRoleName }),
    };
  });

export const controlPolicyDocument = (identity: DeploymentIdentity) => ({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:DeleteObject"], Resource: [`arn:aws:s3:::${dataBucketName(identity)}`, `arn:aws:s3:::${dataBucketName(identity)}/jobs/*`, `arn:aws:s3:::${dataBucketName(identity)}/runtime-configuration.json`] },
    { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [`arn:aws:lambda:${identity.region}:${identity.accountId}:function:fireclanker-${identity.name}-control:live`] },
    { Effect: "Allow", Action: ["iam:PassRole"], Resource: [`arn:aws:iam::${identity.accountId}:role/fireclanker-${identity.name}-runner`] },
    { Effect: "Allow", Action: ["lambda:RunMicrovm", "lambda:GetMicrovm", "lambda:TerminateMicrovm"], Resource: ["*"] },
  ],
});

export const applyAlchemyStack = async (
  configuration: DeploymentConfiguration,
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
  githubToken: string | undefined,
) =>
  withExplicitAccount(identity, credentials, async () => {
    const assets = await prepareEmbeddedAssets(configuration);
    const coreOptions = options(identity, credentials);
    const bootstrapOptions = { ...coreOptions, state: localState() };
    await Test.run(
      Test.withProviders(AWS.bootstrap(), bootstrapOptions, `Bootstrap-${identity.name}`),
      bootstrapOptions,
    );
    const output = await Test.run(
      Test.deploy(coreOptions, createStack(configuration, identity, credentials, assets)),
      coreOptions,
    );

    const region = identity.region;
    await new S3Client({ region }).send(
      new PutObjectCommand({
        Bucket: dataBucketName(identity),
        Key: "runtime-configuration.json",
        Body: JSON.stringify(configuration),
        ContentType: "application/json",
      }),
    );
    if (githubToken !== undefined) {
      await new SecretsManagerClient({ region }).send(
        new PutSecretValueCommand({ SecretId: githubSecretName(identity), SecretString: githubToken }),
      );
    }

    await new IAMClient({ region }).send(
      new PutRolePolicyCommand({
        RoleName: output.controlRoleName,
        PolicyName: "fireclanker-control",
        PolicyDocument: JSON.stringify(controlPolicyDocument(identity)),
      }),
    );

    const lambda = new LambdaClient({ region });
    const published = await lambda.send(new PublishVersionCommand({ FunctionName: output.controlFunctionName }));
    if (published.Version === undefined) throw new Error("Control Lambda version was not published");
    try {
      await lambda.send(new CreateAliasCommand({ FunctionName: output.controlFunctionName, Name: "live", FunctionVersion: published.Version }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ResourceConflictException") throw error;
      await lambda.send(new UpdateAliasCommand({ FunctionName: output.controlFunctionName, Name: "live", FunctionVersion: published.Version }));
    }
  });

export const destroyAlchemyStack = async (
  configuration: DeploymentConfiguration,
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
) =>
  withExplicitAccount(identity, credentials, async () => {
    const assets = await prepareEmbeddedAssets(configuration);
    const coreOptions = options(identity, credentials);
    await Test.run(
      Test.destroy(coreOptions, createStack(configuration, identity, credentials, assets)),
      coreOptions,
    );
  });

export const verifyAlchemyControlAlias = async (
  identity: DeploymentIdentity,
  credentials: AmbientCredentials,
) => {
  const alias = await new LambdaClient({ region: identity.region, credentials }).send(
    new GetAliasCommand({ FunctionName: `fireclanker-${identity.name}-control`, Name: "live" }),
  );
  if (alias.Name !== "live" || alias.FunctionVersion === undefined) {
    throw new Error(`Control Lambda live alias verification failed for ${identity.name}`);
  }
};

import * as Alchemy from "alchemy";
import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import { IMAGE_NAME, LOG_GROUP_NAME } from "./constants.ts";
import { MicrovmExecutionRole } from "./runtime-role.ts";

export default Alchemy.Stack(
  "FireclankerAlchemyMicrovmPrototype",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* AWS.Logs.LogGroup("FireclankerPrototypeMicrovmLogs", {
      logGroupName: LOG_GROUP_NAME,
      retentionInDays: 1,
      tags: { purpose: "fireclanker-wayfinder-prototype" },
    });
    const executionRole = yield* MicrovmExecutionRole;
    const buildRole = yield* AWS.IAM.Role("FireclankerPrototypeMicrovmBuildRole");
    const image = yield* AWS.Lambda.MicrovmImage("FireclankerPrototypeSandbox", {
      name: IMAGE_NAME,
      context: fileURLToPath(new URL("./image", import.meta.url)),
      buildRole,
      resources: [{ minimumMemoryInMiB: 512 }],
      cpuConfigurations: [{ architecture: "ARM_64" }],
      hooks: {
        port: 8080,
        microvmImageHooks: {
          ready: "ENABLED",
          readyTimeoutInSeconds: 30,
        },
        microvmHooks: {
          run: "ENABLED",
          runTimeoutInSeconds: 30,
        },
      },
      tags: { purpose: "fireclanker-wayfinder-prototype" },
    });
    return {
      imageArn: image.imageArn,
      imageVersion: image.latestActiveImageVersion,
      imageState: image.state,
      microvmExecutionRoleArn: executionRole.roleArn,
    };
  }),
);

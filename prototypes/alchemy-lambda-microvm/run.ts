import { LOG_GROUP_NAME, REGION } from "./constants.ts";
import { existsSync, symlinkSync } from "node:fs";

const checkout = new URL("../../.agents/alchemy-effect/", import.meta.url).pathname;

const command = (args: string[], capture = false, cwd = import.meta.dirname) => {
  const child = Bun.spawnSync(args, {
    cwd,
    env: {
      ...process.env,
      NODE_PATH: `${checkout}/packages/alchemy/node_modules`,
    },
    stdout: capture ? "pipe" : "inherit",
    stderr: "inherit",
  });
  if (child.exitCode !== 0) {
    throw new Error(`${args.join(" ")} exited ${child.exitCode}`);
  }
  return capture ? child.stdout.toString().trim() : "";
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let createdAssetsBucket = false;
const ensureAssetsBucket = () => {
  const output = command(["bun", "bootstrap.ts", "ensure"], true);
  const result = JSON.parse(output.split("\n").at(-1)!) as {
    created: boolean;
  };
  createdAssetsBucket = result.created;
};

const removeAssetsBucket = () => {
  command(["bun", "bootstrap.ts", "destroy"]);
};

const destroyStack = async () => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      command(["bun", "--no-install", "alchemy-cli.ts", "destroy"]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`destroy attempt ${attempt} failed; retrying in 5s`);
        await sleep(5_000);
      }
    }
  }
  throw lastError;
};

const startedAt = Date.now();
let deploymentAttempted = false;

try {
  command(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], false, checkout);
  const localNodeModules = `${import.meta.dirname}/node_modules`;
  if (!existsSync(localNodeModules)) {
    symlinkSync(`${checkout}/packages/alchemy/node_modules`, localNodeModules, "dir");
  }
  ensureAssetsBucket();
  deploymentAttempted = true;
  command(["bun", "--no-install", "alchemy-cli.ts", "deploy"]);
  const executionRoleArn = command(
    [
      "aws",
      "iam",
      "get-role",
      "--role-name",
      "fireclanker-wayfinder-microvm-execution",
      "--query",
      "Role.Arn",
      "--output",
      "text",
    ],
    true,
  );
  process.env.MICROVM_EXECUTION_ROLE_ARN = executionRoleArn;
  const result = JSON.parse(command(["bun", "exercise.ts"], true));
  console.log("\nLifecycle result:\n", JSON.stringify(result, null, 2));

  let matchingEvents: Array<{ timestamp?: number; message?: string }> = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const logs = JSON.parse(
      command(
        [
          "aws",
          "logs",
          "filter-log-events",
          "--region",
          REGION,
          "--log-group-name",
          LOG_GROUP_NAME,
          "--start-time",
          String(startedAt),
          "--filter-pattern",
          "FIRECLANKER_RUN_HOOK",
          "--output",
          "json",
        ],
        true,
      ),
    ) as { events?: Array<{ timestamp?: number; message?: string }> };
    matchingEvents = logs.events ?? [];
    if (matchingEvents.length > 0) break;
    await sleep(2_000);
  }
  if (matchingEvents.length === 0) {
    throw new Error("CloudWatch did not receive the /run hook marker");
  }
  console.log("\nCloudWatch /run hook event:\n", JSON.stringify(matchingEvents.at(-1), null, 2));
} finally {
  try {
    if (deploymentAttempted) {
      await destroyStack();
    }
  } finally {
    if (createdAssetsBucket) {
      removeAssetsBucket();
    }
  }
}

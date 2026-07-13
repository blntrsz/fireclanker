import { bootstrap, destroyBootstrap } from "alchemy/AWS/Bootstrap";
import { AWSEnvironment } from "alchemy/AWS/Environment";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { REGION } from "./constants.ts";

const action = process.argv[2];
if (action !== "ensure" && action !== "destroy") {
  throw new Error("usage: bun bootstrap.ts <ensure|destroy>");
}

const accountId = process.env.AWS_ACCOUNT_ID;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!accountId || !accessKeyId || !secretAccessKey) {
  throw new Error("AWS_ACCOUNT_ID and Granted AWS credentials are required");
}

const resolvedCredentials = Effect.succeed({
  accessKeyId: Redacted.make(accessKeyId),
  secretAccessKey: Redacted.make(secretAccessKey),
  sessionToken: process.env.AWS_SESSION_TOKEN
    ? Redacted.make(process.env.AWS_SESSION_TOKEN)
    : undefined,
});

const live = Layer.mergeAll(
  Credentials.fromEnv(),
  Region.fromEnv(),
  FetchHttpClient.layer,
  Layer.succeed(
    AWSEnvironment,
    Effect.succeed({
      accountId,
      region: REGION,
      credentials: resolvedCredentials,
    }),
  ),
);

const result = await Effect.runPromise(
  (action === "ensure" ? bootstrap() : destroyBootstrap()).pipe(Effect.provide(live)),
);
console.log(JSON.stringify(result));

import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
import * as Microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { IMAGE_NAME, LOG_GROUP_NAME, NO_INGRESS_CONNECTOR } from "./constants.ts";

const executionRoleArn = process.env.MICROVM_EXECUTION_ROLE_ARN;
if (!executionRoleArn) {
  throw new Error("MICROVM_EXECUTION_ROLE_ARN is required");
}

const program = Effect.gen(function* () {
  const listed = yield* Microvms.listMicrovmImages({
    nameFilter: IMAGE_NAME,
    maxResults: 10,
  });
  const image = listed.items.find((candidate) => candidate.name === IMAGE_NAME);
  if (!image?.latestActiveImageVersion) {
    return yield* Effect.die(
      new Error(`active image ${IMAGE_NAME} was not found after deployment`),
    );
  }

  const jobId = `wayfinder-${Date.now()}`;
  const logStream = `${jobId}-${Date.now()}`;
  const payload = JSON.stringify({
    jobId,
    instruction: "emit readiness and stop cleanly",
  });
  const startedAt = Date.now();
  const transitions: Array<{ state: string; atMs: number }> = [];
  const launched = yield* Microvms.runMicrovm({
    imageIdentifier: image.imageArn,
    imageVersion: image.latestActiveImageVersion,
    ingressNetworkConnectors: [NO_INGRESS_CONNECTOR],
    executionRoleArn,
    maximumDurationInSeconds: 300,
    runHookPayload: payload,
    logging: { cloudWatch: { logGroup: LOG_GROUP_NAME, logStream } },
  });
  transitions.push({ state: launched.state, atMs: Date.now() - startedAt });

  const read = Microvms.getMicrovm({
    microvmIdentifier: launched.microvmId,
  }).pipe(
    Effect.tap((current) =>
      Effect.sync(() => {
        if (transitions.at(-1)?.state !== current.state) {
          transitions.push({
            state: current.state,
            atMs: Date.now() - startedAt,
          });
        }
      }),
    ),
  );
  const waitFor = (expected: string) =>
    read.pipe(
      Effect.flatMap((current) =>
        current.state === expected
          ? Effect.succeed(current)
          : Effect.fail(new Error(`MicroVM is ${current.state}, not ${expected}`)),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
    );

  return yield* Effect.gen(function* () {
    const running = yield* waitFor("RUNNING");
    const readyAtMs = Date.now() - startedAt;
    yield* Microvms.terminateMicrovm({
      microvmIdentifier: launched.microvmId,
    });
    const terminated = yield* waitFor("TERMINATED");
    return {
      jobId,
      microvmId: launched.microvmId,
      imageArn: running.imageArn,
      imageVersion: running.imageVersion,
      endpointReturned: Boolean(launched.endpoint),
      ingressNetworkConnectors: running.ingressNetworkConnectors,
      egressNetworkConnectors: running.egressNetworkConnectors,
      runHookPayloadBytes: new TextEncoder().encode(payload).byteLength,
      readyAtMs,
      terminatedAtMs: Date.now() - startedAt,
      finalState: terminated.state,
      transitions,
      logGroup: LOG_GROUP_NAME,
      logStream,
    };
  }).pipe(
    Effect.ensuring(
      Microvms.terminateMicrovm({
        microvmIdentifier: launched.microvmId,
      }).pipe(Effect.ignore),
    ),
  );
});

const live = Layer.mergeAll(Credentials.fromEnv(), Region.fromEnv(), FetchHttpClient.layer);

const result = await Effect.runPromise(program.pipe(Effect.provide(live)));
console.log(JSON.stringify(result));

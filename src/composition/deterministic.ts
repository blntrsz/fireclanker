import { mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import {
  cancelJobManifest,
  paginateJobManifests,
} from "../application/job-controller.js";
import {
  DeploymentCore,
  DeploymentOperationFailure,
  JobControl,
  JobNotCancellable,
  JobNotFound,
  InvalidCursor,
  Pi,
  Time,
} from "../application/services.js";
import {
  ALCHEMY_SOURCE_REVISION,
  deploymentKey,
  deploymentResources,
  deriveDeploymentPlan,
  type DeploymentConfiguration,
  type DeploymentIdentity,
} from "../domain/deployment.js";
import {
  ExecutionTranscriptEventSchema,
  JobManifestSchema,
  JobStatusSchema,
  ChangeSetOutcomeSchema,
  ResponseOutcomeSchema,
  type ExecutionTranscriptEvent,
  type JobManifest,
  type RepositorySetMember,
} from "../domain/schemas.js";

const timestamps = [
  "2000-01-01T00:00:00.000Z",
  "2000-01-01T00:00:01.000Z",
  "2000-01-01T00:00:02.000Z",
  "2000-01-01T00:00:03.000Z",
] as const;

const stateDirectory = () =>
  process.env.FIRECLANKER_TEST_STATE_DIRECTORY ?? join(process.cwd(), ".fireclanker-test-state");

const manifestPath = (jobId: string) => join(stateDirectory(), `${jobId}.json`);
const transcriptPath = (jobId: string) => join(stateDirectory(), `${jobId}.transcript.json`);

const readPersistedDocument = <A>(jobId: string, path: string, decode: (input: unknown) => A) =>
  Effect.tryPromise({
    try: async () => {
      const file = Bun.file(path);
      if (!(await file.exists())) throw new JobNotFound({ jobId });
      return decode(await file.json());
    },
    catch: (error) => (error instanceof JobNotFound ? error : new JobNotFound({ jobId })),
  });

const decodeManifest = Schema.decodeUnknownSync(JobManifestSchema, {
  onExcessProperty: "error",
});
const decodeTranscript = Schema.decodeUnknownSync(Schema.Array(ExecutionTranscriptEventSchema), {
  onExcessProperty: "error",
});

const readManifest = (jobId: string) =>
  readPersistedDocument(jobId, manifestPath(jobId), decodeManifest);

const readTranscript = (jobId: string, cursor: string | undefined) =>
  readPersistedDocument(jobId, transcriptPath(jobId), decodeTranscript).pipe(
    Effect.map((events) => {
      if (cursor === undefined) return events;
      const index = events.findIndex((event) => event.cursor === cursor);
      return index === -1 ? events : events.slice(index + 1);
    }),
  );


type PullRequestState = {
  readonly number: number;
  readonly branch: string;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
  readonly state: "open" | "closed" | "merged";
};

type RepositoryPublicationState = {
  readonly defaultBranch: string;
  readonly nextPullRequestNumber: number;
  readonly pullRequests: ReadonlyArray<PullRequestState>;
};

type PublicationState = Record<string, RepositoryPublicationState>;

const publicationStatePath = () => join(stateDirectory(), "publication-state.json");
const repositoryEnvKey = (repository: string) =>
  `FIRECLANKER_TEST_REPOSITORY_DIRECTORY_${repository.replace(/[^a-z0-9]/gi, "_").toUpperCase()}`;

const readPublicationState = async (): Promise<PublicationState> => {
  const file = Bun.file(publicationStatePath());
  return (await file.exists()) ? ((await file.json()) as PublicationState) : {};
};

const writePublicationState = async (state: PublicationState) => {
  await mkdir(stateDirectory(), { recursive: true });
  await Bun.write(publicationStatePath(), JSON.stringify(state));
};

const runGit = (cwd: string, args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
};

const publishDeterministicChangeSet = async (
  jobId: string,
  instruction: string,
  repositorySet: ReadonlyArray<RepositorySetMember>,
) => {
  const state = await readPublicationState();
  const pullRequests = [];
  for (const member of repositorySet) {
    const directory = process.env[repositoryEnvKey(member.repository)];
    if (directory === undefined || !existsSync(directory)) {
      throw new Error(`Repository ${member.repository} has no deterministic repository directory`);
    }
    const existingState = state[member.repository] ?? {
      defaultBranch: "main",
      nextPullRequestNumber: 1,
      pullRequests: [],
    };
    const target = member.target ?? { kind: "branch" as const, name: `fireclanker/${jobId}` };
    const branch = target.kind === "branch" ? target.name : target.headBranch;
    const proposedTitle = `Fireclanker Change Set for ${jobId}`;
    const proposedDescription = `Pi proposed description for ${jobId}\n\nFireclanker provenance: ${jobId}`;
    let nextPullRequestNumber = existingState.nextPullRequestNumber;
    let action: "reused" | "created" | "updated";
    let pullRequest: PullRequestState | undefined;

    if (target.kind === "pull-request") {
      pullRequest = existingState.pullRequests.find((candidate) => candidate.number === target.number);
      if (pullRequest === undefined || pullRequest.branch !== target.headBranch || pullRequest.state !== "open") {
        throw new Error(`Pull request #${target.number} for ${member.repository} is not writable`);
      }
      action = "updated";
      pullRequest = { ...pullRequest, description: proposedDescription };
    } else {
      pullRequest = existingState.pullRequests.find(
        (candidate) => candidate.branch === branch && candidate.state === "open",
      );
      if (pullRequest === undefined) {
        action = "created";
        pullRequest = {
          number: nextPullRequestNumber,
          branch,
          title: proposedTitle,
          description: proposedDescription,
          draft: true,
          state: "open",
        };
        nextPullRequestNumber += 1;
      } else {
        action = "reused";
      }
    }

    runGit(directory, ["checkout", branch]);
    await Bun.write(join(directory, `.fireclanker-${jobId}.txt`), `${instruction}\n`);
    runGit(directory, ["add", `.fireclanker-${jobId}.txt`]);
    runGit(directory, ["commit", "-m", `Fireclanker ${jobId}`]);
    const remote = runGit(directory, ["remote", "get-url", "origin"]);
    runGit(directory, ["push", remote, `HEAD:${branch}`]);

    state[member.repository] = {
      defaultBranch: existingState.defaultBranch,
      nextPullRequestNumber,
      pullRequests: [
        ...existingState.pullRequests.filter((candidate) => candidate.number !== pullRequest.number),
        pullRequest,
      ].sort((left, right) => left.number - right.number),
    };
    pullRequests.push({
      repository: member.repository,
      number: pullRequest.number,
      title: pullRequest.title,
      url: `https://github.com/${member.repository}/pull/${pullRequest.number}`,
      draft: pullRequest.draft,
      action,
      description: pullRequest.description,
    });
  }
  await writePublicationState(state);
  return Schema.decodeUnknownSync(ChangeSetOutcomeSchema)({
    version: 1,
    kind: "change-set",
    summary: `Published ${pullRequests.length} repository Change Set for ${jobId}`,
    pullRequests,
  });
};

const DeterministicPi = Layer.succeed(
  Pi,
  Pi.of({
    complete: Effect.fn("Pi.Deterministic.complete")((instruction: string) =>
      Effect.succeed({
        version: 1 as const,
        kind: "response" as const,
        response: `Deterministic response to: ${instruction}`,
      })),
  }),
);

const DeterministicTime = Layer.sync(
  Time,
  () => {
    let index = 0;
    return Time.of({
      now: Effect.sync(() => timestamps[index++] ?? "2000-01-01T00:00:03.000Z"),
    });
  },
);

const JobControlFromDeterministicServices = Layer.effect(
  JobControl,
  Effect.gen(function* () {
    const pi = yield* Pi;
    const time = yield* Time;
    return JobControl.of({
      submit: Effect.fn("JobControl.Deterministic.submit")(function* (operation) {
          const { instruction } = operation;
          const jobId = operation.jobId;
          const completion = yield* pi.complete(instruction);
          if (completion.kind !== "response") {
            return yield* Effect.die(
              new Error("The deterministic tracer only supports a Response Outcome"),
            );
          }
          const outcome = process.env.FIRECLANKER_TEST_PUBLICATION_ENABLED === "1"
            ? yield* Effect.tryPromise({
                try: () => publishDeterministicChangeSet(jobId, instruction, operation.repositorySet),
                catch: (error) =>
                  new JobNotFound({
                    jobId,
                  }),
              })
            : Schema.decodeUnknownSync(ResponseOutcomeSchema)({
                version: 1,
                kind: "response",
                response: completion.response,
              });
          const queuedAt = yield* time.now;
          const runningAt = yield* time.now;
          const outcomeAt = yield* time.now;
          const succeededAt = yield* time.now;
          const decodeStatus = Schema.decodeUnknownSync(JobStatusSchema, {
            onExcessProperty: "error",
          });
          const queued = decodeStatus({
            version: 1,
            jobId,
            status: "queued",
            timestamp: queuedAt,
          });
          const running = decodeStatus({
            version: 1,
            jobId,
            status: "running",
            timestamp: runningAt,
          });
          const succeeded = decodeStatus({
            version: 1,
            jobId,
            status: "succeeded",
            timestamp: succeededAt,
          });
          const manifest: JobManifest = {
            version: 1,
            jobId,
            submission: {
              canonicalHash: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify({ instruction, repositorySet: operation.repositorySet }))
                .digest("hex"),
              instruction,
              repositorySet: operation.repositorySet,
            },
            status: "succeeded",
            transitions: [
              { status: queued.status, timestamp: queued.timestamp },
              { status: running.status, timestamp: running.timestamp },
              { status: succeeded.status, timestamp: succeeded.timestamp },
            ],
            audit: {
              submittedAt: new Date().toISOString(),
              submittedBy: operation.submittedBy ?? "arn:aws:iam::123456789012:user/tester",
            },
            runtime: { writerGeneration: 0 },
            transcript: { highestCursor: "cursor-4" },
            outcome,
            artifacts: {},
          };
          const transcript: ReadonlyArray<ExecutionTranscriptEvent> = [
            {
              version: 1,
              sequence: 1,
              cursor: "cursor-1",
              timestamp: queuedAt,
              type: "status",
              jobId,
              status: queued.status,
            },
            {
              version: 1,
              sequence: 2,
              cursor: "cursor-2",
              timestamp: runningAt,
              type: "status",
              jobId,
              status: running.status,
            },
            {
              version: 1,
              sequence: 3,
              cursor: "cursor-3",
              timestamp: outcomeAt,
              type: "outcome",
              jobId,
              outcome,
            },
            {
              version: 1,
              sequence: 4,
              cursor: "cursor-4",
              timestamp: succeededAt,
              type: "status",
              jobId,
              status: succeeded.status,
            },
          ];

          Schema.decodeUnknownSync(JobManifestSchema)(manifest);
          Schema.decodeUnknownSync(Schema.Array(ExecutionTranscriptEventSchema))(transcript);
          yield* Effect.promise(() => mkdir(stateDirectory(), { recursive: true }));
          if (process.env.FIRECLANKER_TEST_EXECUTION_DISABLED === "1") {
            const { outcome: _outcome, ...accepted } = manifest;
            const initialTransition = manifest.transitions[0];
            if (initialTransition === undefined) {
              return yield* Effect.die(new Error("Expected the queued Job transition"));
            }
            const queuedManifest: JobManifest = {
              ...accepted,
              status: "queued",
              transitions: [initialTransition],
              transcript: { highestCursor: null },
            };
            yield* Effect.promise(() =>
              Bun.write(manifestPath(jobId), JSON.stringify(queuedManifest)),
            );
            yield* Effect.promise(() => Bun.write(transcriptPath(jobId), "[]"));
            return queuedManifest;
          }
          yield* Effect.promise(() => Bun.write(manifestPath(jobId), JSON.stringify(manifest)));
          yield* Effect.promise(() => Bun.write(transcriptPath(jobId), JSON.stringify(transcript)));
          return manifest;
        }),
      get: Effect.fn("JobControl.Deterministic.get")((operation) => readManifest(operation.jobId)),
      list: Effect.fn("JobControl.Deterministic.list")(function* (operation) {
            yield* Effect.tryPromise({
              try: () => mkdir(stateDirectory(), { recursive: true }),
              catch: () => new InvalidCursor({ message: "Unable to list retained Jobs" }),
            });
            const files = (yield* Effect.tryPromise({
              try: () => readdir(stateDirectory()),
              catch: () => new InvalidCursor({ message: "Unable to list retained Jobs" }),
            })).filter(
              (file) => /^job-[a-f0-9]{12}\.json$/.test(file),
            );
            const inputs = yield* Effect.tryPromise({
              try: () => Promise.all(files.map((file) => Bun.file(join(stateDirectory(), file)).json())),
              catch: () => new InvalidCursor({ message: "Unable to list retained Jobs" }),
            });
            return yield* paginateJobManifests(inputs.map((input) => decodeManifest(input)), operation);
      }),
      cancel: Effect.fn("JobControl.Deterministic.cancel")(function* (operation) {
            const file = Bun.file(manifestPath(operation.jobId));
            if (!(yield* Effect.promise(() => file.exists()))) {
              return yield* Effect.fail(new JobNotFound({ jobId: operation.jobId }));
            }
            const manifest = decodeManifest(yield* Effect.promise(() => file.json()));
            const cancelled = yield* cancelJobManifest(manifest, new Date().toISOString());
            yield* Effect.promise(() => Bun.write(manifestPath(operation.jobId), JSON.stringify(cancelled)));
            return cancelled;
      }),
      watch: Effect.fn("JobControl.Deterministic.watch")((operation) => readTranscript(operation.jobId, operation.cursor)),
    });
  }),
);

export const DeterministicJobControl = JobControlFromDeterministicServices.pipe(
  Layer.provide([DeterministicPi, DeterministicTime]),
);

interface PersistedDeployment {
  readonly configuration: DeploymentConfiguration;
  readonly tokenVersion: number;
  readonly controlAlias: "live";
}

type DeploymentState = Record<string, PersistedDeployment>;

const deploymentStatePath = () => join(stateDirectory(), "deployments.json");

const readDeploymentState = async (): Promise<DeploymentState> => {
  const file = Bun.file(deploymentStatePath());
  return (await file.exists()) ? ((await file.json()) as DeploymentState) : {};
};

const writeDeploymentState = async (state: DeploymentState) => {
  await mkdir(stateDirectory(), { recursive: true });
  await Bun.write(deploymentStatePath(), JSON.stringify(state));
};

const sameConfiguration = (left: DeploymentConfiguration, right: DeploymentConfiguration) =>
  JSON.stringify(left) === JSON.stringify(right);

const deploymentFailure = (error: unknown) =>
  error instanceof DeploymentOperationFailure
    ? error
    : new DeploymentOperationFailure({
        message: error instanceof Error ? error.message : "Deployment operation failed",
      });

export const DeterministicDeploymentCore = Layer.effect(
  DeploymentCore,
  Effect.succeed({
    resolveIdentity: (configuration: DeploymentConfiguration) =>
      Effect.succeed({
        accountId: "123456789012",
        region: configuration.region,
        name: configuration.name,
      }),
    plan: (operation, identity, configuration, rotateGitHubToken) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          const existing = state[deploymentKey(identity)];
          const derived = deriveDeploymentPlan({
            operation,
            exists: existing !== undefined,
            configurationMatches:
              existing !== undefined && sameConfiguration(existing.configuration, configuration),
            rotateGitHubToken,
          });
          return {
            operation,
            ...derived,
            identity,
            bootstrapBucket: `alchemy-assets-${identity.accountId}-${identity.region}-an`,
            statePrefix: `deployments/${identity.name}/`,
            resources: deploymentResources(identity.name),
            alchemyRevision: ALCHEMY_SOURCE_REVISION,
          } as const;
        },
        catch: deploymentFailure,
      }),
    apply: (plan, configuration, githubToken) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          const key = deploymentKey(plan.identity);
          const existing = state[key];
          if (plan.action === "no-op" && existing !== undefined && githubToken === undefined) {
            return { tokenVersion: existing.tokenVersion };
          }
          if (existing === undefined && githubToken === undefined) {
            throw new DeploymentOperationFailure({
              message: "First deployment requires a GitHub token; pass --github-token-stdin",
            });
          }
          const tokenVersion = (existing?.tokenVersion ?? 0) + (githubToken === undefined ? 0 : 1);
          state[key] = { configuration, tokenVersion, controlAlias: "live" };
          await writeDeploymentState(state);
          return { tokenVersion };
        },
        catch: deploymentFailure,
      }),
    destroy: (plan) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          delete state[deploymentKey(plan.identity)];
          await writeDeploymentState(state);
        },
        catch: deploymentFailure,
      }),
    verifyControlAlias: (identity: DeploymentIdentity) =>
      Effect.tryPromise({
        try: async () => {
          const state = await readDeploymentState();
          if (state[deploymentKey(identity)]?.controlAlias !== "live") {
            throw new Error(`Control Lambda live alias verification failed for ${identity.name}`);
          }
        },
        catch: deploymentFailure,
      }),
  }),
);

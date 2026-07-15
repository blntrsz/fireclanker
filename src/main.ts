import { BunRuntime, BunServices } from "@effect/platform-bun";
import { randomBytes } from "node:crypto";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, CliError, CliOutput, Command, Flag } from "effect/unstable/cli";
import {
  ConfigurationSource,
  ConfirmationRequired,
  DeploymentCore,
  FileSystemProcess,
  GitHubTokenRequired,
  InvalidUsage,
  JobControl,
  TerminalInteraction,
} from "./application/services.js";
import {
  DeterministicDeploymentCore,
  DeterministicJobControl,
} from "./composition/deterministic.js";
import {
  ProductionDeploymentCore,
  ProductionJobControl,
} from "./composition/production.js";
import {
  PlatformConfigurationSource,
  PlatformFileSystemProcess,
  PlatformTerminalInteraction,
} from "./composition/platform.js";
import type { DeploymentPlan } from "./domain/deployment.js";
import {
  CliEventSchema,
  ControlOperationSchema,
  type ControlGetOperation,
  type ControlListOperation,
  type ControlCancelOperation,
  type ControlRunOperation,
  type ControlTranscriptOperation,
  type ExecutionTranscriptEvent,
} from "./domain/schemas.js";

declare const FIRECLANKER_COMPOSITION: "production" | "test";

const rootCommand = Command.make("fireclanker").pipe(
  Command.withSharedFlags({
    json: Flag.boolean("json"),
    config: Flag.string("config").pipe(Flag.optional),
  }),
);

const jsonLine = (event: unknown): string =>
  JSON.stringify(Schema.decodeUnknownSync(CliEventSchema, { onExcessProperty: "error" })(event));
const decodeControlOperation = (input: unknown, message: string) =>
  Schema.decodeUnknownEffect(ControlOperationSchema, {
    onExcessProperty: "error",
  })(input).pipe(Effect.mapError(() => new InvalidUsage({ message })));

const run = Command.make(
  "run",
  {
    instruction: Argument.string("instruction").pipe(Argument.optional),
    file: Flag.string("file").pipe(Flag.optional),
  },
  ({ file, instruction }) =>
    Effect.gen(function* () {
      const globals = yield* rootCommand;
      const positionalInstruction = Option.getOrUndefined(instruction);
      const instructionFile = Option.getOrUndefined(file);
      if (positionalInstruction === undefined && instructionFile === undefined) {
        return yield* new InvalidUsage({
          message: "Missing required argument: instruction",
        });
      }
      if (positionalInstruction !== undefined && instructionFile !== undefined) {
        return yield* new InvalidUsage({
          message: "Use exactly one instruction source: positional text or --file",
        });
      }
      const source = yield* FileSystemProcess;
      const resolvedInstruction =
        positionalInstruction ?? (yield* source.readInstruction(instructionFile!));
      const control = yield* JobControl;
      const operation = (yield* decodeControlOperation(
        {
          version: 1,
          operation: "run",
          jobId: `job-${randomBytes(6).toString("hex")}`,
          instruction: resolvedInstruction,
          repositorySet: [],
        },
        "Invalid run operation",
      )) as ControlRunOperation;
      const manifest = yield* control.submit(operation, Option.getOrUndefined(globals.config));
      if (globals.json) {
        yield* Console.log(
          jsonLine({
            version: 1,
            event: "job-accepted",
            jobId: manifest.jobId,
            status: "queued",
          }),
        );
        return;
      }
      yield* Console.log(
        `Job ${manifest.jobId} queued\nResume with: fireclanker get ${manifest.jobId} --watch`,
      );
    }),
);

const renderTranscriptEvent = (event: ExecutionTranscriptEvent): string => {
  if (event.type === "status") {
    return `[${event.timestamp}] Job ${event.jobId} ${event.status}`;
  }
  return event.outcome.kind === "response"
    ? `[${event.timestamp}] Response: ${event.outcome.response}`
    : `[${event.timestamp}] Change Set: ${event.outcome.summary}`;
};

const jsonTranscriptEvent = (event: ExecutionTranscriptEvent) =>
  event.type === "status"
    ? {
        version: 1,
        event: "job-status",
        jobId: event.jobId,
        status: event.status,
        timestamp: event.timestamp,
        cursor: event.cursor,
      }
    : {
        version: 1,
        event: "outcome",
        jobId: event.jobId,
        outcome: event.outcome,
        timestamp: event.timestamp,
        cursor: event.cursor,
      };

const get = Command.make(
  "get",
  {
    jobId: Argument.string("job-id"),
    watch: Flag.boolean("watch"),
  },
  ({ jobId, watch }) =>
    Effect.gen(function* () {
      const globals = yield* rootCommand;
      const control = yield* JobControl;
      if (watch) {
        const operation = (yield* decodeControlOperation(
          {
            version: 1,
            operation: "transcript",
            jobId,
          },
          `Invalid Job ID: ${jobId}`,
        )) as ControlTranscriptOperation;
        const events = yield* control.watch(operation, Option.getOrUndefined(globals.config));
        yield* Console.log(
          events
            .map((event) =>
              globals.json ? jsonLine(jsonTranscriptEvent(event)) : renderTranscriptEvent(event),
            )
            .join("\n"),
        );
        return;
      }

      const operation = (yield* decodeControlOperation(
        {
          version: 1,
          operation: "get",
          jobId,
        },
        `Invalid Job ID: ${jobId}`,
      )) as ControlGetOperation;
      const manifest = yield* control.get(operation, Option.getOrUndefined(globals.config));
      if (globals.json) {
        yield* Console.log(
          jsonLine({
            version: 1,
            event: "job-status",
            jobId: manifest.jobId,
            status: manifest.status,
            ...(manifest.outcome === undefined ? {} : { outcome: manifest.outcome }),
            ...(manifest.failure === undefined ? {} : { failure: manifest.failure }),
          }),
        );
        return;
      }
      const outcome = manifest.outcome;
      const renderedOutcome =
        outcome?.kind === "response"
          ? `\nResponse: ${outcome.response}`
          : outcome?.kind === "change-set"
            ? `\nChange Set: ${outcome.summary}`
            : "";
      const renderedFailure =
        manifest.failure === undefined
          ? ""
          : `\nFailure: ${manifest.failure.code}: ${manifest.failure.message}`;
      yield* Console.log(
        `Job ${manifest.jobId}\nStatus: ${manifest.status}${renderedOutcome}${renderedFailure}`,
      );
    }),
);

const list = Command.make(
  "list",
  {
    status: Flag.choice("status", ["queued", "running", "succeeded", "failed", "cancelled"] as const).pipe(
      Flag.optional,
    ),
    limit: Flag.integer("limit").pipe(Flag.withDefault(20)),
    cursor: Flag.string("cursor").pipe(Flag.optional),
  },
  ({ cursor, limit, status }) =>
    Effect.gen(function* () {
      const globals = yield* rootCommand;
      const control = yield* JobControl;
      const operation = (yield* decodeControlOperation(
        {
          version: 1,
          operation: "list",
          limit,
          ...(Option.isNone(status) ? {} : { status: status.value }),
          ...(Option.isNone(cursor) ? {} : { cursor: cursor.value }),
        },
        "Invalid Job list arguments",
      )) as ControlListOperation;
      const page = yield* control.list(operation, Option.getOrUndefined(globals.config));
      if (globals.json) {
        yield* Console.log(
          jsonLine({
            version: 1,
            event: "job-list",
            jobs: page.jobs,
            ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          }),
        );
        return;
      }
      const rows = page.jobs.map(
        (job) => `${job.jobId}  ${job.status}  ${job.audit.submittedAt}  ${job.submission.instruction}`,
      );
      if (page.nextCursor !== undefined) {
        rows.push(
          `Continue with: fireclanker list${operation.status === undefined ? "" : ` --status ${operation.status}`} --limit ${operation.limit} --cursor ${page.nextCursor}`,
        );
      }
      yield* Console.log(rows.join("\n"));
    }),
);

const cancel = Command.make(
  "cancel",
  { jobId: Argument.string("job-id") },
  ({ jobId }) =>
    Effect.gen(function* () {
      const globals = yield* rootCommand;
      const control = yield* JobControl;
      const operation = (yield* decodeControlOperation(
        { version: 1, operation: "cancel", jobId },
        `Invalid Job ID: ${jobId}`,
      )) as ControlCancelOperation;
      const manifest = yield* control.cancel(operation, Option.getOrUndefined(globals.config));
      if (globals.json) {
        yield* Console.log(
          jsonLine({
            version: 1,
            event: "job-cancelled",
            jobId: manifest.jobId,
            status: "cancelled",
          }),
        );
        return;
      }
      yield* Console.log(`Job ${manifest.jobId} cancelled`);
    }),
);

const renderPlan = (plan: DeploymentPlan) =>
  [
    `${plan.operation === "deploy" ? "Deployment" : "Destruction"} plan: ${plan.action}`,
    `Deployment: ${plan.identity.name}`,
    `Identity: ${plan.identity.accountId}/${plan.identity.region}/${plan.identity.name}`,
    `Portable state: s3://${plan.bootstrapBucket}/${plan.statePrefix}`,
    ...plan.resources.map((resource) => `  ${plan.operation === "destroy" ? "-" : "+"} ${resource}`),
    plan.operation === "destroy"
      ? `Preserve shared bootstrap bucket: ${plan.bootstrapBucket}`
      : `Alchemy revision: ${plan.alchemyRevision}`,
  ].join("\n");

const jsonPlan = (plan: DeploymentPlan) =>
  JSON.stringify({
    version: 1,
    event: "deployment-plan",
    operation: plan.operation,
    action: plan.action,
    deployment: plan.identity,
    bootstrapBucket: plan.bootstrapBucket,
    statePrefix: plan.statePrefix,
    resources: plan.resources,
    alchemyRevision: plan.alchemyRevision,
  });

const requireConfirmation = (plan: DeploymentPlan, yes: boolean, json: boolean) =>
  Effect.gen(function* () {
    if (yes) return;
    const terminal = yield* TerminalInteraction;
    const interactive = yield* terminal.isInteractive;
    if (!json && interactive && (yield* terminal.confirm(`Apply ${plan.operation} plan?`))) return;
    return yield* new ConfirmationRequired({
      message: `Confirmation required for Deployment ${plan.identity.name}; pass --yes`,
    });
  });

const deploymentCommand = (operation: "deploy" | "destroy") =>
  Command.make(
    operation,
    {
      yes: Flag.boolean("yes"),
      githubTokenStdin: Flag.boolean("github-token-stdin"),
    },
    ({ githubTokenStdin, yes }) =>
      Effect.gen(function* () {
        const globals = yield* rootCommand;
        if (operation === "destroy" && githubTokenStdin) {
          return yield* new InvalidUsage({
            message: "--github-token-stdin is only valid with deploy",
          });
        }
        const source = yield* ConfigurationSource;
        const configuration = yield* source.load(Option.getOrUndefined(globals.config));
        const core = yield* DeploymentCore;
        const identity = yield* core.resolveIdentity(configuration);
        const plan = yield* core.plan(operation, identity, configuration, githubTokenStdin);

        yield* Console.log(globals.json ? jsonPlan(plan) : renderPlan(plan));
        yield* requireConfirmation(plan, yes, globals.json);

        if (operation === "destroy") {
          yield* core.destroy(plan);
          if (!globals.json) yield* Console.log(`Destroyed Deployment ${identity.name}`);
          return;
        }

        let githubToken: string | undefined;
        if (githubTokenStdin) {
          githubToken = (yield* Effect.promise(() => Bun.stdin.text())).trim();
          if (githubToken.length === 0) {
            return yield* new GitHubTokenRequired({ message: "GitHub token cannot be empty" });
          }
        } else if (plan.requiresGitHubToken) {
          const terminal = yield* TerminalInteraction;
          if (yield* terminal.isInteractive) {
            githubToken = yield* terminal.readSecret("GitHub token: ");
          }
        }

        if (plan.requiresGitHubToken && githubToken === undefined) {
          return yield* new GitHubTokenRequired({
            message: "First deployment requires a GitHub token; pass --github-token-stdin",
          });
        }

        yield* core.apply(plan, configuration, githubToken);
        yield* core.verifyControlAlias(identity);
        if (!globals.json) {
          yield* Console.log(`Deployed ${identity.name}; verified Control Lambda live alias`);
        }
      }),
  );

const deploy = deploymentCommand("deploy");
const destroy = deploymentCommand("destroy");

const app = rootCommand.pipe(Command.withSubcommands([run, get, list, cancel, deploy, destroy]));

const rawArguments = process.argv.slice(2);
const jsonRequested = rawArguments.includes("--json");
const defaultFormatter = CliOutput.defaultFormatter({ colors: false });
const jsonFormatter: CliOutput.Formatter = {
  ...defaultFormatter,
  formatHelpDoc: () => "",
  formatErrors: (errors) =>
    jsonLine({
      version: 1,
      event: "error",
      code: "invalid_usage",
      message: errors.map((error) => error.message).join("; "),
    }),
};
const jsonConsole: Console.Console = {
  ...globalThis.console,
  log: (...arguments_: ReadonlyArray<unknown>) => {
    if (arguments_.length === 1 && arguments_[0] === "") return;
    globalThis.console.log(...arguments_);
  },
};

const parsedCommand = Command.run(app, { version: "0.0.1" });
const commandProgram = jsonRequested
  ? parsedCommand.pipe(
      Effect.provide(CliOutput.layer(jsonFormatter)),
      Effect.provideService(Console.Console, jsonConsole),
    )
  : parsedCommand;

const program = commandProgram.pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      if (CliError.isCliError(error)) {
        process.exitCode = 2;
        return;
      }
      const tagged = error as { readonly _tag?: string; readonly message?: string };
      const code =
        tagged._tag === "JobNotFound"
          ? "job_not_found"
          : tagged._tag === "JobNotCancellable"
            ? "job_not_cancellable"
            : tagged._tag === "JobIdempotencyConflict"
              ? "idempotency_conflict"
              : tagged._tag === "InvalidCursor"
                ? "invalid_cursor"
          : tagged._tag === "DeploymentUnavailable"
            ? "deployment_unavailable"
            : tagged._tag === "InvalidUsage"
              ? "invalid_usage"
              : tagged._tag === "InvalidConfiguration"
                ? "invalid_configuration"
                : tagged._tag === "ConfirmationRequired"
                  ? "confirmation_required"
                  : tagged._tag === "GitHubTokenRequired"
                    ? "github_token_required"
                    : tagged._tag === "DeploymentOperationFailure"
                      ? "deployment_failed"
                      : "command_failed";
      const message =
        (tagged._tag === "JobNotFound" || tagged._tag === "JobNotCancellable") && "jobId" in tagged
          ? tagged._tag === "JobNotFound"
            ? `Job ${String(tagged.jobId)} not found`
            : `Job ${String(tagged.jobId)} is not cancellable`
          : tagged.message || "Command failed";
      process.stderr.write(
        jsonRequested
          ? `${jsonLine({ version: 1, event: "error", code, message })}\n`
          : `${message}\n`,
      );
      process.exitCode =
        tagged._tag === "InvalidUsage" ||
        tagged._tag === "InvalidConfiguration" ||
        tagged._tag === "ConfirmationRequired" ||
        tagged._tag === "GitHubTokenRequired"
          ? 2
          : 1;
    }),
  ),
  Effect.provide(
    FIRECLANKER_COMPOSITION === "test" ? DeterministicJobControl : ProductionJobControl,
  ),
  Effect.provide(
    FIRECLANKER_COMPOSITION === "test"
      ? DeterministicDeploymentCore
      : ProductionDeploymentCore,
  ),
  Effect.provide(PlatformFileSystemProcess),
  Effect.provide(PlatformConfigurationSource),
  Effect.provide(PlatformTerminalInteraction),
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program);

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, CliError, CliOutput, Command, Flag } from "effect/unstable/cli";
import { FileSystemProcess, InvalidUsage, JobControl } from "./application/services.js";
import { DeterministicJobControl } from "./composition/deterministic.js";
import { ProductionJobControl } from "./composition/production.js";
import { PlatformFileSystemProcess } from "./composition/platform.js";
import {
  CliEventSchema,
  ControlOperationSchema,
  type ControlGetOperation,
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
          instruction: resolvedInstruction,
          repositorySet: [],
        },
        "Invalid run operation",
      )) as ControlRunOperation;
      const manifest = yield* control.submit(operation);
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
        const events = yield* control.watch(operation);
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
      const manifest = yield* control.get(operation);
      if (globals.json) {
        yield* Console.log(
          jsonLine({
            version: 1,
            event: "job-status",
            jobId: manifest.jobId,
            status: manifest.status,
            ...(manifest.outcome === undefined ? {} : { outcome: manifest.outcome }),
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
      yield* Console.log(`Job ${manifest.jobId}\nStatus: ${manifest.status}${renderedOutcome}`);
    }),
);

const list = Command.make("list");
const cancel = Command.make("cancel");
const deploy = Command.make("deploy");
const destroy = Command.make("destroy");

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
          : tagged._tag === "DeploymentUnavailable"
            ? "deployment_unavailable"
            : tagged._tag === "InvalidUsage"
              ? "invalid_usage"
              : "command_failed";
      const message =
        tagged._tag === "JobNotFound" && "jobId" in tagged
          ? `Job ${String(tagged.jobId)} not found`
          : tagged.message || "Command failed";
      process.stderr.write(
        jsonRequested
          ? `${jsonLine({ version: 1, event: "error", code, message })}\n`
          : `${message}\n`,
      );
      process.exitCode = tagged._tag === "InvalidUsage" ? 2 : 1;
    }),
  ),
  Effect.provide(
    FIRECLANKER_COMPOSITION === "test" ? DeterministicJobControl : ProductionJobControl,
  ),
  Effect.provide(PlatformFileSystemProcess),
  Effect.provide(BunServices.layer),
);

BunRuntime.runMain(program);

#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, FileSystem, Option, Result, Stdio, Stream } from "effect"
import { Argument, CliOutput, Command, Flag, Prompt } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  completedJob,
  deploymentPlan,
  getJob,
  listJobs,
  repositorySet,
  renderDeploymentPlan,
  renderJob,
  renderJobList,
  renderSubmitted,
  renderTranscriptEntry,
  submittedJob,
  transcriptFor,
  uncataloguedRepositories,
  type Job,
  type JobStatus
} from "./contract.ts"

const jsonLine = (value: unknown): string => JSON.stringify(value)

const defaultFormatter = CliOutput.defaultFormatter({ colors: false })
const jsonFormatter: CliOutput.Formatter = {
  formatHelpDoc: (doc) => jsonLine({
    type: "help",
    text: defaultFormatter.formatHelpDoc(doc)
  }),
  formatCliError: (error) => jsonLine({
    type: "error",
    code: "invalid_usage",
    message: defaultFormatter.formatCliError(error)
  }),
  formatError: (error) => jsonLine({
    type: "error",
    code: "invalid_usage",
    message: defaultFormatter.formatError(error)
  }),
  formatVersion: (name, version) => jsonLine({ type: "version", name, version }),
  formatErrors: (errors) => jsonLine({
    type: "error",
    code: "invalid_usage",
    message: defaultFormatter.formatErrors(errors)
  })
}
const formatter = process.argv.includes("--json") ? jsonFormatter : defaultFormatter

const emit = (json: boolean, human: string, machine: unknown) =>
  Console.log(json ? jsonLine(machine) : human)

const rejectCommand = Effect.fn(function*(
  json: boolean,
  code: string,
  message: string,
  exitCode: number,
  details: Record<string, unknown> = {}
) {
  yield* Console.error(json
    ? jsonLine({ type: "error", code, message, ...details })
    : `Error: ${message}`)
  process.exitCode = exitCode
})

const rejectUsage = (json: boolean, message: string) =>
  rejectCommand(json, "invalid_usage", message, 2)

const readInstruction = Effect.fn(function*(
  instruction: Option.Option<string>,
  file: Option.Option<string>
) {
  if (Option.isSome(instruction)) return instruction.value

  const path = Option.getOrThrow(file)
  if (path === "-") {
    const stdio = yield* Stdio.Stdio
    const chunks = yield* stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.runCollect
    )
    return chunks.join("")
  }

  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path)
})

const repositoryFromRemote = (remote: string): string | undefined => {
  const match = remote.trim().match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return match === null ? undefined : `${match[1]}/${match[2]}`
}

const inferRepository = Effect.fn(function*() {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const remote = yield* spawner.string(
    ChildProcess.make("git", ["remote", "get-url", "origin"])
  ).pipe(Effect.catch(() => Effect.succeed("")))
  return repositoryFromRemote(remote)
})

const emitWatch = Effect.fn(function*(json: boolean, job: Job) {
  for (const entry of transcriptFor(job.id)) {
    yield* Effect.sleep("3 seconds")
    yield* Console.log(json ? jsonLine(entry) : renderTranscriptEntry(entry))
  }
  const completed = completedJob(job)
  yield* Console.log(json
    ? jsonLine({ type: "job.completed", job: completed })
    : `\nJob succeeded\n${renderJob(completed)}`)
})

const watchJob = (json: boolean, job: Job) => emitWatch(json, job).pipe(
  Effect.onInterrupt(() => Console.log(json
    ? jsonLine({
      type: "watch.detached",
      jobId: job.id,
      resumeCommand: `fireclanker get ${job.id} --watch`
    })
    : `\nStopped watching; Job ${job.id} continues.\nResume: fireclanker get ${job.id} --watch`))
)

const replayTranscript = Effect.fn(function*(json: boolean, job: Job) {
  for (const entry of transcriptFor(job.id)) {
    yield* Console.log(json ? jsonLine(entry) : renderTranscriptEntry(entry))
  }
})

const root = Command.make("fireclanker").pipe(
  Command.withSharedFlags({
    json: Flag.boolean("json").pipe(
      Flag.withDescription("Emit compact JSON objects, one per line")
    )
  }),
  Command.withDescription("Submit and inspect autonomous Jobs")
)

const run = Command.make("run", {
  instruction: Argument.string("instruction").pipe(
    Argument.withDescription("Job instruction; quote it when it contains spaces"),
    Argument.optional
  ),
  file: Flag.string("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Read the Job instruction from a file"),
    Flag.optional
  ),
  repositories: Flag.string("repos").pipe(
    Flag.withDescription("Comma-separated Repository Set: owner/name,owner/name"),
    Flag.optional
  ),
  watch: Flag.boolean("watch").pipe(
    Flag.withAlias("w"),
    Flag.withDescription("Follow the Execution Transcript until the Job finishes")
  )
}, Effect.fn(function*({ file, instruction, repositories, watch }) {
  const { json } = yield* root
  const hasInstruction = Option.isSome(instruction)
  const hasFile = Option.isSome(file)

  if (hasInstruction === hasFile) {
    return yield* rejectUsage(json, "Pass exactly one instruction source: positional text or --file.")
  }

  const instructionResult = yield* Effect.result(readInstruction(instruction, file))
  if (Result.isFailure(instructionResult)) {
    return yield* rejectCommand(
      json,
      "instruction_unreadable",
      `Could not read the instruction from ${Option.getOrElse(file, () => "the selected source")}.`,
      1
    )
  }
  const instructionText = instructionResult.success
  const inferredRepository = Option.isSome(repositories)
    ? undefined
    : yield* inferRepository()
  const repositoriesForJob = repositorySet(
    Option.getOrUndefined(repositories),
    inferredRepository
  )
  const uncatalogued = uncataloguedRepositories(repositoriesForJob)
  if (uncatalogued.length > 0) {
    return yield* rejectCommand(
      json,
      "repository_not_catalogued",
      `Repository Set members are not in the Repository Catalog: ${uncatalogued.join(", ")}.`,
      1,
      { repositories: uncatalogued }
    )
  }

  const job = {
    ...submittedJob,
    instruction: instructionText,
    repositories: repositoriesForJob
  }

  yield* emit(json, renderSubmitted(job), { type: "job.submitted", job })
  if (watch) yield* watchJob(json, job)
})).pipe(
  Command.withDescription("Submit a Job; detach after acknowledgement unless --watch is set"),
  Command.withExamples([
    { command: "fireclanker run \"Fix the failing build\"", description: "Submit and detach" },
    { command: "fireclanker run --file instruction.md --watch", description: "Submit and follow the transcript" }
  ])
)

const get = Command.make("get", {
  id: Argument.string("job-id").pipe(Argument.withDescription("Job ID")),
  watch: Flag.boolean("watch").pipe(
    Flag.withAlias("w"),
    Flag.withDescription("Replay the retained Execution Transcript, then follow until terminal")
  )
}, Effect.fn(function*({ id, watch }) {
  const { json } = yield* root
  const job = getJob(id)
  if (job === undefined) {
    return yield* rejectCommand(
      json,
      "job_not_found",
      `Job ${id} was not found.`,
      1,
      { jobId: id }
    )
  }
  yield* emit(json, renderJob(job), { type: "job.snapshot", job })
  if (watch) {
    if (job.status === "queued" || job.status === "running") {
      yield* watchJob(json, job)
    } else {
      yield* replayTranscript(json, job)
      if (job.status === "failed" || job.status === "cancelled") {
        process.exitCode = 1
      }
    }
  }
})).pipe(
  Command.withDescription("Inspect a Job and optionally follow its Execution Transcript")
)

const list = Command.make("list", {
  status: Flag.choice("status", ["all", "queued", "running", "succeeded", "failed", "cancelled"] as const).pipe(
    Flag.withDescription("Filter by Job Status"),
    Flag.withDefault("all")
  ),
  limit: Flag.integer("limit").pipe(
    Flag.withAlias("n"),
    Flag.withDescription("Maximum number of Jobs to return"),
    Flag.withDefault(20)
  ),
  cursor: Flag.string("cursor").pipe(
    Flag.withDescription("Opaque cursor returned by the previous page"),
    Flag.optional
  )
}, Effect.fn(function*({ cursor, limit, status }) {
  const { json } = yield* root
  const page = listJobs(
    status as JobStatus | "all",
    limit,
    Option.getOrUndefined(cursor)
  )
  if (page === undefined) {
    return yield* rejectCommand(
      json,
      "invalid_cursor",
      "The list cursor is invalid or expired.",
      1
    )
  }

  const nextCommand = page.nextCursor === null
    ? ""
    : `\n\nNext: fireclanker list --limit ${limit}${status === "all" ? "" : ` --status ${status}`} --cursor ${page.nextCursor}`
  yield* emit(
    json,
    `${renderJobList(page.jobs)}${nextCommand}`,
    { type: "job.list", jobs: page.jobs, nextCursor: page.nextCursor }
  )
})).pipe(
  Command.withDescription("List Jobs newest first")
)

const cancel = Command.make("cancel", {
  id: Argument.string("job-id").pipe(Argument.withDescription("Job ID"))
}, Effect.fn(function*({ id }) {
  const { json } = yield* root
  const job = getJob(id)
  if (job === undefined) {
    return yield* rejectCommand(
      json,
      "job_not_found",
      `Job ${id} was not found.`,
      1,
      { jobId: id }
    )
  }
  const alreadyCancelled = job.status === "cancelled"
  const cancellable = job.status === "queued" || job.status === "running"

  if (alreadyCancelled) {
    return yield* emit(
      json,
      `Job ${id} is already cancelled; no change was needed.`,
      { type: "job.cancelled", job, alreadyCancelled: true }
    )
  }

  if (!cancellable) {
    return yield* rejectCommand(
      json,
      "job_not_cancellable",
      `Job ${id} is already ${job.status}; no cancellation was requested.`,
      1,
      { jobId: id, status: job.status, reason: "terminal_status" }
    )
  }

  yield* emit(
    json,
    `Cancellation requested for Job ${id}.\nStatus: cancelled`,
    { type: "job.cancelled", job: { ...job, status: "cancelled" } }
  )
})).pipe(
  Command.withDescription("Cancel a queued or running Job")
)

const deploy = Command.make("deploy", {
  config: Flag.file("config", { mustExist: false }).pipe(
    Flag.withAlias("c"),
    Flag.withDescription("Deployment configuration file"),
    Flag.withDefault("fireclanker.config.ts")
  ),
  yes: Flag.boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Apply the deployment plan without prompting")
  )
}, Effect.fn(function*({ config, yes }) {
  const { json } = yield* root
  const plan = { ...deploymentPlan, config }
  yield* emit(json, renderDeploymentPlan(config), plan)

  const interactive = process.stdin.isTTY === true
  if (!yes && (json || !interactive)) {
    return yield* rejectCommand(
      json,
      "confirmation_required",
      "Non-interactive deployment requires --yes.",
      2
    )
  }

  const confirmed = yes || (yield* Prompt.run(Prompt.confirm({
    message: "Apply this deployment plan?",
    initial: false
  })))
  if (!confirmed) {
    yield* emit(json, "Deployment cancelled; no changes were made.", { type: "deployment.cancelled" })
    return
  }

  yield* emit(
    json,
    "Deploying dev to AWS account 123456789012 in eu-central-1…",
    { type: "deployment.started", stage: plan.stage, awsRegion: plan.awsRegion }
  )
  yield* Effect.sleep("180 millis")
  yield* emit(
    json,
    "Deployment complete\nEndpoint: https://fireclanker.dev.example.com",
    {
      type: "deployment.completed",
      stage: plan.stage,
      endpoint: "https://fireclanker.dev.example.com"
    }
  )
})).pipe(
  Command.withDescription("Plan and deploy Fireclanker using ambient AWS credentials")
)

root.pipe(
  Command.withSubcommands([run, get, list, cancel, deploy]),
  Command.run({ version: "0.0.0-prototype" }),
  Effect.provideService(CliOutput.Formatter, formatter),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain
)

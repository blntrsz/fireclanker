export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled"

export interface Job {
  readonly id: string
  readonly status: JobStatus
  readonly instruction: string
  readonly repositories: ReadonlyArray<string>
  readonly submittedAt: string
  readonly startedAt?: string
  readonly finishedAt?: string
  readonly outcome?:
    | {
      readonly type: "response"
      readonly text: string
    }
    | {
      readonly type: "change_set"
      readonly summary: string
      readonly pullRequests: ReadonlyArray<{
        readonly repository: string
        readonly number: number
        readonly title: string
        readonly url: string
        readonly draft: true
      }>
    }
  readonly failure?: string
}

export interface TranscriptEntry {
  readonly type: "transcript.entry"
  readonly jobId: string
  readonly sequence: number
  readonly timestamp: string
  readonly source: "system" | "agent" | "tool"
  readonly message: string
}

export const submittedJob: Job = {
  id: "job_01JUL13FIRECLANKER",
  status: "queued",
  instruction: "Fix the failing build",
  repositories: ["blntrsz/fireclanker"],
  submittedAt: "2026-07-13T10:20:00Z"
}

const repositoryCatalog = new Set([
  "blntrsz/fireclanker",
  "acme/api",
  "acme/web"
])

export const uncataloguedRepositories = (
  repositories: ReadonlyArray<string>
): ReadonlyArray<string> => repositories.filter((repository) => !repositoryCatalog.has(repository))

const fixtureJobs: ReadonlyArray<Job> = [
  {
    id: "job_01QUEUED",
    status: "queued",
    instruction: "Summarize the open architecture questions",
    repositories: ["blntrsz/fireclanker"],
    submittedAt: "2026-07-13T10:18:00Z"
  },
  {
    id: "job_01RUNNING",
    status: "running",
    instruction: "Fix the failing build",
    repositories: ["blntrsz/fireclanker"],
    submittedAt: "2026-07-13T10:12:00Z",
    startedAt: "2026-07-13T10:13:02Z"
  },
  {
    id: "job_01SUCCEEDED",
    status: "succeeded",
    instruction: "Coordinate the API and web release",
    repositories: ["acme/api", "acme/web"],
    submittedAt: "2026-07-13T09:40:00Z",
    startedAt: "2026-07-13T09:41:10Z",
    finishedAt: "2026-07-13T09:43:25Z",
    outcome: {
      type: "change_set",
      summary: "Updated the API contract and its web client together.",
      pullRequests: [
        {
          repository: "acme/api",
          number: 142,
          title: "Add release metadata to the API",
          url: "https://github.com/acme/api/pull/142",
          draft: true
        },
        {
          repository: "acme/web",
          number: 87,
          title: "Consume release metadata in the web client",
          url: "https://github.com/acme/web/pull/87",
          draft: true
        }
      ]
    }
  },
  {
    id: "job_01FAILED",
    status: "failed",
    instruction: "Run the full release verification",
    repositories: ["acme/api"],
    submittedAt: "2026-07-13T09:20:00Z",
    startedAt: "2026-07-13T09:21:14Z",
    finishedAt: "2026-07-13T09:21:20Z",
    failure: "Pi execution exceeded the configured Job time limit."
  },
  {
    id: "job_01CANCELLED",
    status: "cancelled",
    instruction: "Draft release notes",
    repositories: [],
    submittedAt: "2026-07-13T08:50:00Z",
    finishedAt: "2026-07-13T08:52:03Z"
  }
]

const cursorOffsets: Readonly<Record<string, number>> = {
  cursor_01JUL13_AFTER_1: 1,
  cursor_01JUL13_AFTER_2: 2,
  cursor_01JUL13_AFTER_3: 3,
  cursor_01JUL13_AFTER_4: 4
}

const cursorForOffset = (offset: number): string | null => {
  const cursor = `cursor_01JUL13_AFTER_${offset}`
  return cursor in cursorOffsets ? cursor : null
}

export const listJobs = (
  status: JobStatus | "all",
  limit: number,
  cursor: string | undefined
): { readonly jobs: ReadonlyArray<Job>; readonly nextCursor: string | null } | undefined => {
  const offset = cursor === undefined ? 0 : cursorOffsets[cursor]
  if (offset === undefined) return undefined

  const filtered = fixtureJobs.filter((job) => status === "all" || job.status === status)
  const jobs = filtered.slice(offset, offset + Math.max(0, limit))
  const nextOffset = offset + jobs.length
  return {
    jobs,
    nextCursor: nextOffset < filtered.length ? cursorForOffset(nextOffset) : null
  }
}

export const getJob = (id: string): Job | undefined =>
  fixtureJobs.find((job) => job.id === id)

export const repositorySet = (
  explicitRepositories: string | undefined,
  inferredRepository: string | undefined
): ReadonlyArray<string> => {
  if (explicitRepositories === undefined) {
    return inferredRepository === undefined ? [] : [inferredRepository]
  }
  return [...new Set(explicitRepositories.split(",").map((repository) => repository.trim()).filter(Boolean))]
}

export const transcriptFor = (jobId: string): ReadonlyArray<TranscriptEntry> => [
  {
    type: "transcript.entry",
    jobId,
    sequence: 1,
    timestamp: "2026-07-13T10:13:02Z",
    source: "system",
    message: "MicroVM started; Pi is beginning execution."
  },
  {
    type: "transcript.entry",
    jobId,
    sequence: 2,
    timestamp: "2026-07-13T10:13:08Z",
    source: "agent",
    message: "I found the failing check and am inspecting its configuration."
  },
  {
    type: "transcript.entry",
    jobId,
    sequence: 3,
    timestamp: "2026-07-13T10:13:15Z",
    source: "tool",
    message: "bun test: 42 passed, 0 failed"
  }
]

export const completedJob = (job: Job): Job => ({
  ...job,
  status: "succeeded",
  startedAt: job.startedAt ?? "2026-07-13T10:13:02Z",
  finishedAt: "2026-07-13T10:13:18Z",
  outcome: {
    type: "response",
    text: "The build failure came from a stale generated configuration."
  }
})

const field = (label: string, value: string): string => `  ${label.padEnd(18)}${value}`

export const renderJob = (job: Job): string => {
  const lines = [
    `Job ${job.id}`,
    field("Status", job.status),
    field("Repositories", job.repositories.join(", ") || "none"),
    field("Submitted", job.submittedAt),
    field("Instruction", job.instruction)
  ]

  if (job.startedAt) lines.push(field("Started", job.startedAt))
  if (job.finishedAt) lines.push(field("Finished", job.finishedAt))
  if (job.outcome?.type === "response") {
    lines.push("", "Outcome · Response", job.outcome.text)
  }
  if (job.outcome?.type === "change_set") {
    lines.push("", "Outcome · Change Set", job.outcome.summary, "", "Draft pull requests")
    for (const pullRequest of job.outcome.pullRequests) {
      lines.push(`- ${pullRequest.repository}#${pullRequest.number} · ${pullRequest.title}`, `  ${pullRequest.url}`)
    }
  }
  if (job.failure) lines.push("", "Failure", job.failure)
  return lines.join("\n")
}

export const renderSubmitted = (job: Job): string => [
  "Job submitted",
  field("ID", job.id),
  field("Status", job.status),
  field("Repositories", job.repositories.join(", ") || "none"),
  field("Instruction", job.instruction),
  "",
  `Watch: fireclanker get ${job.id} --watch`
].join("\n")

export const renderJobList = (jobs: ReadonlyArray<Job>): string => {
  if (jobs.length === 0) return "No Jobs found."
  const header = `${"ID".padEnd(22)} ${"STATUS".padEnd(10)} ${"REPOSITORIES".padEnd(32)} INSTRUCTION`
  const rows = jobs.map((job) =>
    `${job.id.padEnd(22)} ${job.status.padEnd(10)} ${(job.repositories.join(",") || "—").padEnd(32)} ${job.instruction}`
  )
  return [header, ...rows].join("\n")
}

export const renderTranscriptEntry = (entry: TranscriptEntry): string =>
  `${entry.timestamp}  ${entry.source.padEnd(6)}  ${entry.message}`

export const deploymentPlan = {
  type: "deployment.plan",
  stage: "dev",
  awsAccount: "123456789012",
  awsRegion: "eu-central-1",
  model: "anthropic.claude-sonnet-5",
  repositoryCount: 3,
  config: "fireclanker.config.ts"
} as const

export const renderDeploymentPlan = (config: string): string => [
  "Deployment plan",
  field("Stage", deploymentPlan.stage),
  field("AWS account", deploymentPlan.awsAccount),
  field("AWS region", deploymentPlan.awsRegion),
  field("Model", deploymentPlan.model),
  field("Repositories", String(deploymentPlan.repositoryCount)),
  field("Config", config)
].join("\n")

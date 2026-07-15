import { Schema } from "effect";

const Version = Schema.Literal(1);
const Timestamp = Schema.String;
export const JobIdSchema = Schema.String.check(Schema.isPattern(/^job-[a-f0-9]{12}$/));
const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/i),
);

export const JobStatusValueSchema = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const JobStatusSchema = Schema.Struct({
  version: Version,
  jobId: JobIdSchema,
  status: JobStatusValueSchema,
  timestamp: Timestamp,
});

export const DeploymentConfigurationSchema = Schema.Struct({
  version: Version,
  name: Schema.String,
  region: Schema.String,
  model: Schema.Literals(["gpt-5.5", "claude-sonnet-5", "claude-opus-4.8"]),
  repositoryCatalog: Schema.Array(RepositoryName),
  retentionDays: Schema.Int.check(Schema.isGreaterThan(0)),
});

export const RepositoryTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("branch"), name: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    number: Schema.Int.check(Schema.isGreaterThan(0)),
    headBranch: Schema.String,
  }),
]);

export const RepositorySetMemberSchema = Schema.Struct({
  repository: RepositoryName,
  target: Schema.optional(RepositoryTargetSchema),
});

export const ControlOperationSchema = Schema.Union([
  Schema.Struct({
    version: Version,
    operation: Schema.Literal("run"),
    jobId: JobIdSchema,
    instruction: Schema.String,
    repositorySet: Schema.Array(RepositorySetMemberSchema),
    submittedBy: Schema.optional(Schema.String),
  }),
  Schema.Struct({ version: Version, operation: Schema.Literal("get"), jobId: JobIdSchema }),
  Schema.Struct({
    version: Version,
    operation: Schema.Literal("transcript"),
    jobId: JobIdSchema,
    cursor: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    version: Version,
    operation: Schema.Literal("list"),
    status: Schema.optional(JobStatusValueSchema),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
    cursor: Schema.optional(Schema.String),
  }),
  Schema.Struct({ version: Version, operation: Schema.Literal("cancel"), jobId: JobIdSchema }),
]);

export const ResponseOutcomeSchema = Schema.Struct({
  version: Version,
  kind: Schema.Literal("response"),
  response: Schema.String,
});

const PullRequestSchema = Schema.Struct({
  repository: RepositoryName,
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String,
  url: Schema.String,
  draft: Schema.Boolean,
});

export const ChangeSetOutcomeSchema = Schema.Struct({
  version: Version,
  kind: Schema.Literal("change-set"),
  summary: Schema.String,
  pullRequests: Schema.Array(PullRequestSchema),
});

export const OutcomeSchema = Schema.Union([ResponseOutcomeSchema, ChangeSetOutcomeSchema]);

export const PublicationPlanSchema = Schema.Struct({
  version: Version,
  summary: Schema.String,
  repositories: Schema.Array(
    Schema.Struct({
      repository: RepositoryName,
      pullRequest: Schema.Struct({ title: Schema.String, description: Schema.String }),
    }),
  ),
});

export const PublicationFailureSchema = Schema.Struct({
  version: Version,
  kind: Schema.Literal("publication-failure"),
  code: Schema.String,
  completed: Schema.Array(PullRequestSchema),
  failedRepository: RepositoryName,
  unattemptedRepositories: Schema.Array(RepositoryName),
});

export const PiCompletionSchema = Schema.Union([
  Schema.Struct({ version: Version, kind: Schema.Literal("response"), response: Schema.String }),
  Schema.Struct({
    version: Version,
    kind: Schema.Literal("publication-plan"),
    plan: PublicationPlanSchema,
  }),
]);

const StatusTransitionSchema = Schema.Struct({
  status: JobStatusValueSchema,
  timestamp: Timestamp,
});

export const JobManifestSchema = Schema.Struct({
  version: Version,
  jobId: JobIdSchema,
  submission: Schema.Struct({
    canonicalHash: Schema.String,
    instruction: Schema.String,
    repositorySet: Schema.Array(RepositorySetMemberSchema),
  }),
  status: JobStatusValueSchema,
  transitions: Schema.Array(StatusTransitionSchema),
  audit: Schema.Struct({ submittedAt: Timestamp, submittedBy: Schema.String }),
  runtime: Schema.Struct({
    writerGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    microvmId: Schema.optional(Schema.String),
  }),
  transcript: Schema.Struct({ highestCursor: Schema.NullOr(Schema.String) }),
  outcome: Schema.optional(OutcomeSchema),
  failure: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  artifacts: Schema.Struct({
    transcript: Schema.optional(Schema.String),
    piSession: Schema.optional(Schema.String),
  }),
});

export const JobListPageSchema = Schema.Struct({
  jobs: Schema.Array(JobManifestSchema),
  nextCursor: Schema.optional(Schema.String),
});

export const ExecutionTranscriptCursorSchema = Schema.Struct({
  version: Version,
  cursor: Schema.String,
});

export const ExecutionTranscriptEventSchema = Schema.Union([
  Schema.Struct({
    version: Version,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    cursor: Schema.String,
    timestamp: Timestamp,
    type: Schema.Literal("status"),
    jobId: JobIdSchema,
    status: JobStatusValueSchema,
  }),
  Schema.Struct({
    version: Version,
    sequence: Schema.Int.check(Schema.isGreaterThan(0)),
    cursor: Schema.String,
    timestamp: Timestamp,
    type: Schema.Literal("outcome"),
    jobId: JobIdSchema,
    outcome: OutcomeSchema,
  }),
]);

export const RuntimeHookPayloadSchema = Schema.Union([
  Schema.Struct({ version: Version, hook: Schema.Literal("ready"), runtimeId: Schema.String }),
  Schema.Struct({
    version: Version,
    hook: Schema.Literal("run"),
    jobId: JobIdSchema,
    manifestLocator: Schema.String,
    writerGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
]);

export const CliEventSchema = Schema.Union([
  Schema.Struct({
    version: Version,
    event: Schema.Literal("job-accepted"),
    jobId: JobIdSchema,
    status: Schema.Literal("queued"),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("job-status"),
    jobId: JobIdSchema,
    status: JobStatusValueSchema,
    timestamp: Schema.optional(Timestamp),
    cursor: Schema.optional(Schema.String),
    outcome: Schema.optional(OutcomeSchema),
    failure: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("outcome"),
    jobId: JobIdSchema,
    outcome: OutcomeSchema,
    timestamp: Schema.optional(Timestamp),
    cursor: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("job-list"),
    jobs: Schema.Array(JobManifestSchema),
    nextCursor: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("job-cancelled"),
    jobId: JobIdSchema,
    status: Schema.Literal("cancelled"),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("error"),
    code: Schema.String,
    message: Schema.String,
  }),
]);

export type JobManifest = typeof JobManifestSchema.Type;
export type ExecutionTranscriptEvent = typeof ExecutionTranscriptEventSchema.Type;
export type PiCompletion = typeof PiCompletionSchema.Type;
export type ControlOperation = typeof ControlOperationSchema.Type;
export type ControlRunOperation = Extract<ControlOperation, { readonly operation: "run" }>;
export type ControlGetOperation = Extract<ControlOperation, { readonly operation: "get" }>;
export type ControlTranscriptOperation = Extract<
  ControlOperation,
  { readonly operation: "transcript" }
>;
export type ControlListOperation = Extract<ControlOperation, { readonly operation: "list" }>;
export type ControlCancelOperation = Extract<ControlOperation, { readonly operation: "cancel" }>;
export type RepositorySetMember = typeof RepositorySetMemberSchema.Type;

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
  target: Schema.optionalKey(RepositoryTargetSchema),
});

export const ControlRunOperationSchema = Schema.Struct({
    version: Version,
    operation: Schema.Literal("run"),
    jobId: JobIdSchema,
    instruction: Schema.String,
    repositorySet: Schema.Array(RepositorySetMemberSchema),
    submittedBy: Schema.optionalKey(Schema.String),
  });
export const ControlGetOperationSchema = Schema.Struct({ version: Version, operation: Schema.Literal("get"), jobId: JobIdSchema });
export const ControlTranscriptOperationSchema = Schema.Struct({
    version: Version,
    operation: Schema.Literal("transcript"),
    jobId: JobIdSchema,
    cursor: Schema.optionalKey(Schema.String),
  });
export const ControlListOperationSchema = Schema.Struct({
    version: Version,
    operation: Schema.Literal("list"),
    status: Schema.optionalKey(JobStatusValueSchema),
    limit: Schema.Int.check(Schema.isGreaterThan(0)),
    cursor: Schema.optionalKey(Schema.String),
  });
export const ControlCancelOperationSchema = Schema.Struct({ version: Version, operation: Schema.Literal("cancel"), jobId: JobIdSchema });

export const ControlOperationSchema = Schema.Union([
  ControlRunOperationSchema,
  ControlGetOperationSchema,
  ControlTranscriptOperationSchema,
  ControlListOperationSchema,
  ControlCancelOperationSchema,
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
  headBranch: Schema.String,
});

export const ChangeSetOutcomeSchema = Schema.Struct({
  version: Version,
  kind: Schema.Literal("change-set"),
  summary: Schema.String,
  pullRequests: Schema.Array(PullRequestSchema),
});

export const PublicationFailureOutcomeSchema = Schema.Struct({
  version: Version,
  kind: Schema.Literal("publication-failure"),
  code: Schema.String,
  message: Schema.String,
  retainedBranches: Schema.Array(Schema.Struct({ repository: RepositoryName, branch: Schema.String })),
  retainedPullRequests: Schema.Array(PullRequestSchema),
  failedRepository: RepositoryName,
  unattemptedRepositories: Schema.Array(RepositoryName),
});

export const OutcomeSchema = Schema.Union([
  ResponseOutcomeSchema,
  ChangeSetOutcomeSchema,
  PublicationFailureOutcomeSchema,
]);

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

export const PublicationFailureSchema = PublicationFailureOutcomeSchema;

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
    microvmId: Schema.optionalKey(Schema.String),
  }),
  transcript: Schema.Struct({ highestCursor: Schema.NullOr(Schema.String) }),
  outcome: Schema.optionalKey(OutcomeSchema),
  failure: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  artifacts: Schema.Struct({
    transcript: Schema.optionalKey(Schema.String),
    piSession: Schema.optionalKey(Schema.String),
  }),
});

export const JobListPageSchema = Schema.Struct({
  jobs: Schema.Array(JobManifestSchema),
  nextCursor: Schema.optionalKey(Schema.String),
});

export interface JobListPage extends Schema.Schema.Type<typeof JobListPageSchema> {}

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
    timestamp: Schema.optionalKey(Timestamp),
    cursor: Schema.optionalKey(Schema.String),
    outcome: Schema.optionalKey(OutcomeSchema),
    failure: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
    manifest: Schema.optionalKey(JobManifestSchema),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("outcome"),
    jobId: JobIdSchema,
    outcome: OutcomeSchema,
    timestamp: Schema.optionalKey(Timestamp),
    cursor: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    version: Version,
    event: Schema.Literal("job-list"),
    jobs: Schema.Array(JobManifestSchema),
    nextCursor: Schema.optionalKey(Schema.String),
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

export interface JobManifest extends Schema.Schema.Type<typeof JobManifestSchema> {}
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
export interface RepositorySetMember extends Schema.Schema.Type<typeof RepositorySetMemberSchema> {}
export type CliEvent = typeof CliEventSchema.Type;

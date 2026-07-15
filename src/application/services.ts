import { Context, Effect, Schema } from "effect";
import type {
  ControlGetOperation,
  ControlListOperation,
  ControlCancelOperation,
  ControlRunOperation,
  ControlTranscriptOperation,
  ExecutionTranscriptEvent,
  JobManifest,
  PiCompletion,
} from "../domain/schemas.js";
import type {
  DeploymentConfiguration,
  DeploymentIdentity,
  DeploymentPlan,
} from "../domain/deployment.js";

export class DeploymentUnavailable extends Schema.TaggedErrorClass<DeploymentUnavailable>()(
  "DeploymentUnavailable",
  { message: Schema.String },
) {}
export class JobNotFound extends Schema.TaggedErrorClass<JobNotFound>()("JobNotFound", {
  jobId: Schema.String,
}) {}
export class JobNotCancellable extends Schema.TaggedErrorClass<JobNotCancellable>()(
  "JobNotCancellable",
  { jobId: Schema.String },
) {}
export class JobIdempotencyConflict extends Schema.TaggedErrorClass<JobIdempotencyConflict>()(
  "JobIdempotencyConflict",
  { jobId: Schema.String, message: Schema.String },
) {}
export class InvalidCursor extends Schema.TaggedErrorClass<InvalidCursor>()("InvalidCursor", {
  message: Schema.String,
}) {}
export class InvalidUsage extends Schema.TaggedErrorClass<InvalidUsage>()("InvalidUsage", {
  message: Schema.String,
}) {}
export class InstructionReadFailure extends Schema.TaggedErrorClass<InstructionReadFailure>()(
  "InstructionReadFailure",
  { path: Schema.String, message: Schema.String },
) {}
export class InvalidConfiguration extends Schema.TaggedErrorClass<InvalidConfiguration>()(
  "InvalidConfiguration",
  { message: Schema.String },
) {}
export class ConfirmationRequired extends Schema.TaggedErrorClass<ConfirmationRequired>()(
  "ConfirmationRequired",
  { message: Schema.String },
) {}
export class GitHubTokenRequired extends Schema.TaggedErrorClass<GitHubTokenRequired>()(
  "GitHubTokenRequired",
  { message: Schema.String },
) {}
export class DeploymentOperationFailure extends Schema.TaggedErrorClass<DeploymentOperationFailure>()(
  "DeploymentOperationFailure",
  { message: Schema.String },
) {}
export class StaleManifest extends Schema.TaggedErrorClass<StaleManifest>()("StaleManifest", {
  jobId: Schema.String,
}) {}
export class ManifestPersistenceError extends Schema.TaggedErrorClass<ManifestPersistenceError>()(
  "ManifestPersistenceError",
  { operation: Schema.String, message: Schema.String },
) {}

type JobControlError =
  | DeploymentUnavailable
  | InvalidConfiguration
  | JobIdempotencyConflict
  | JobNotFound
  | JobNotCancellable
  | InvalidCursor;

export interface JobControlService {
  readonly submit: (
    operation: ControlRunOperation,
    configurationPath?: string,
  ) => Effect.Effect<JobManifest, JobControlError>;
  readonly get: (
    operation: ControlGetOperation,
    configurationPath?: string,
  ) => Effect.Effect<JobManifest, JobControlError>;
  readonly list: (
    operation: ControlListOperation,
    configurationPath?: string,
  ) => Effect.Effect<
    { readonly jobs: ReadonlyArray<JobManifest>; readonly nextCursor?: string | undefined },
    JobControlError
  >;
  readonly cancel: (
    operation: ControlCancelOperation,
    configurationPath?: string,
  ) => Effect.Effect<JobManifest, JobControlError>;
  readonly watch: (
    operation: ControlTranscriptOperation,
    configurationPath?: string,
  ) => Effect.Effect<ReadonlyArray<ExecutionTranscriptEvent>, JobControlError>;
}

export class JobControl extends Context.Service<JobControl, JobControlService>()(
  "fireclanker/JobControl",
) {}

// Production adapters implement these capabilities at the executable composition boundary.
export class Aws extends Context.Service<
  Aws,
  {
    readonly invokeControl: (operation: unknown) => Effect.Effect<unknown>;
  }
>()("fireclanker/Aws") {}
export class GitHubGit extends Context.Service<
  GitHubGit,
  {
    readonly canonicalizeRepository: (repository: string) => Effect.Effect<string>;
  }
>()("fireclanker/GitHubGit") {}
export class Pi extends Context.Service<
  Pi,
  {
    readonly complete: (instruction: string) => Effect.Effect<PiCompletion>;
  }
>()("fireclanker/Pi") {}
export class Time extends Context.Service<Time, { readonly now: Effect.Effect<string> }>()(
  "fireclanker/Time",
) {}
export class TerminalInteraction extends Context.Service<
  TerminalInteraction,
  {
    readonly isInteractive: Effect.Effect<boolean>;
    readonly confirm: (message: string) => Effect.Effect<boolean>;
    readonly readSecret: (message: string) => Effect.Effect<string, GitHubTokenRequired>;
  }
>()("fireclanker/TerminalInteraction") {}
export class FileSystemProcess extends Context.Service<
  FileSystemProcess,
  {
    readonly readInstruction: (path: string) => Effect.Effect<string, InstructionReadFailure>;
  }
>()("fireclanker/FileSystemProcess") {}

export interface DeploymentCoreService {
  readonly resolveIdentity: (
    configuration: DeploymentConfiguration,
  ) => Effect.Effect<DeploymentIdentity, DeploymentOperationFailure>;
  readonly plan: (
    operation: "deploy" | "destroy",
    identity: DeploymentIdentity,
    configuration: DeploymentConfiguration,
    rotateGitHubToken: boolean,
  ) => Effect.Effect<DeploymentPlan, DeploymentOperationFailure>;
  readonly apply: (
    plan: DeploymentPlan,
    configuration: DeploymentConfiguration,
    githubToken: string | undefined,
  ) => Effect.Effect<{ readonly tokenVersion: number }, DeploymentOperationFailure>;
  readonly destroy: (plan: DeploymentPlan) => Effect.Effect<void, DeploymentOperationFailure>;
  readonly verifyControlAlias: (
    identity: DeploymentIdentity,
  ) => Effect.Effect<void, DeploymentOperationFailure>;
}

export class DeploymentCore extends Context.Service<DeploymentCore, DeploymentCoreService>()(
  "fireclanker/DeploymentCore",
) {}

export class ConfigurationSource extends Context.Service<
  ConfigurationSource,
  {
    readonly load: (
      explicitPath: string | undefined,
    ) => Effect.Effect<DeploymentConfiguration, InvalidConfiguration>;
  }
>()("fireclanker/ConfigurationSource") {}

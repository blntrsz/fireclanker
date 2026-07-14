import { Context, Data, Effect } from "effect";
import type {
  ControlGetOperation,
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

export class DeploymentUnavailable extends Data.TaggedError("DeploymentUnavailable")<{
  readonly message: string;
}> {}

export class JobNotFound extends Data.TaggedError("JobNotFound")<{
  readonly jobId: string;
}> {}

export class InvalidUsage extends Data.TaggedError("InvalidUsage")<{
  readonly message: string;
}> {}

export class InstructionReadFailure extends Data.TaggedError("InstructionReadFailure")<{
  readonly path: string;
  readonly message: string;
}> {}

export class InvalidConfiguration extends Data.TaggedError("InvalidConfiguration")<{
  readonly message: string;
}> {}

export class ConfirmationRequired extends Data.TaggedError("ConfirmationRequired")<{
  readonly message: string;
}> {}

export class GitHubTokenRequired extends Data.TaggedError("GitHubTokenRequired")<{
  readonly message: string;
}> {}

export class DeploymentOperationFailure extends Data.TaggedError("DeploymentOperationFailure")<{
  readonly message: string;
}> {}

export interface JobControlService {
  readonly submit: (
    operation: ControlRunOperation,
  ) => Effect.Effect<JobManifest, DeploymentUnavailable>;
  readonly get: (
    operation: ControlGetOperation,
  ) => Effect.Effect<JobManifest, JobNotFound | DeploymentUnavailable>;
  readonly watch: (
    operation: ControlTranscriptOperation,
  ) => Effect.Effect<ReadonlyArray<ExecutionTranscriptEvent>, JobNotFound | DeploymentUnavailable>;
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

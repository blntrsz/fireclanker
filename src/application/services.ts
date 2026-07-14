import { Context, Data, Effect } from "effect";
import type {
  ControlGetOperation,
  ControlRunOperation,
  ControlTranscriptOperation,
  ExecutionTranscriptEvent,
  JobManifest,
  PiCompletion,
} from "../domain/schemas.js";

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
  }
>()("fireclanker/TerminalInteraction") {}
export class FileSystemProcess extends Context.Service<
  FileSystemProcess,
  {
    readonly readInstruction: (path: string) => Effect.Effect<string, InstructionReadFailure>;
  }
>()("fireclanker/FileSystemProcess") {}

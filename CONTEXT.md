# Fireclanker

Fireclanker is an autonomous agent service that accepts delegated work and returns its outcome.

## Language

**Job**:
A durable unit of work submitted to Fireclanker, containing an instruction and a Repository Set. A Job produces an Outcome and retains its interaction history.
_Avoid_: Task, request, assignment

**Outcome**:
The successful result of a Job. It is either a textual Response or a Change Set; repository access permits but does not require changes.
_Avoid_: Result, output

**Repository Catalog**:
The deployment-configured collection of repositories eligible for inclusion in a Job's Repository Set.
_Avoid_: Repository list, workspace

**Repository Set**:
The immutable, equal-peer collection of zero or more catalogued repositories that provides a Job's starting context and supported access boundary. Pi decides which members to materialize in the Job Workspace.
_Avoid_: Focus Repository, primary repository, current repository, target repository

**Repository Target**:
The optional branch or pull request that supplies a Repository Set member's starting publication context. A pull-request target identifies both its head branch and the pull request; a branch target identifies only the branch.

**Job Workspace**:
The isolated filesystem in which one Job may materialize and change Repository Set members. Each member has one unambiguous assigned location.

**Publication Plan**:
Pi's declaration of the repository changes it intends Fireclanker to publish, including proposed pull-request metadata. It exists before any publication attempt.

**Change Set**:
An Outcome coordinating one or more related published pull requests across Repository Set members and a short textual summary. Newly created pull requests are drafts; explicitly updated pull requests preserve their existing review state.
_Avoid_: Pull Request Outcome, result

**Publication Failure**:
A terminally unsuccessful publication that records any retained branches and pull requests together with the failed and unattempted repositories. It is never a Change Set.

**Execution Transcript**:
The durable, observable history of a Job, including agent messages, tool calls, command output, timestamps, and its final Outcome. It excludes hidden model reasoning and redacts credentials known to Fireclanker.
_Avoid_: Session content, logs, history

**Job Status**:
The lifecycle state of a Job: queued, running, succeeded, failed, or cancelled. `queued` means the Job has been durably accepted but execution has not yet been confirmed. `running` begins when execution is confirmed and includes runtime initialization before agent work begins. A Job never pauses or waits for additional input.
_Avoid_: State, phase

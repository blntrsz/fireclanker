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
The configured set of repositories that a Fireclanker deployment may access and use as context for Jobs.
_Avoid_: Repository list, workspace

**Repository Set**:
The zero or more equal-peer repositories that provide starting context for a Job. Every member belongs to the Repository Catalog; Fireclanker may use other catalogued repositories when the instruction requires cross-repository work.
_Avoid_: Focus Repository, primary repository, current repository

**Change Set**:
An Outcome containing one or more related pull requests and a short textual summary of the coordinated changes.
_Avoid_: Pull Request Outcome, result

**Execution Transcript**:
The durable, observable history of a Job, including agent messages, tool calls, command output, timestamps, and its final Outcome. It excludes hidden model reasoning and redacts credentials known to Fireclanker.
_Avoid_: Session content, logs, history

**Job Status**:
The lifecycle state of a Job: queued, running, succeeded, failed, or cancelled. A Job never pauses or waits for additional input.
_Avoid_: State, phase

# Pi embeddable runtime contract

Research date: 2026-07-13

Question: What supported Pi SDK or RPC integration can run a one-shot non-interactive Fireclanker Job with Amazon Bedrock, expose the observable event stream, persist a session artifact, cancel execution, report structured completion or failure, and support Fireclanker-specific repository and publication behavior?

## Scope and source baseline

This note examines the official Pi repository at commit [`0e6909f050eeb15e8f6c05185511f3788357ddb3`](https://github.com/earendil-works/pi/tree/0e6909f050eeb15e8f6c05185511f3788357ddb3), where the published coding-agent package identifies itself as [`@earendil-works/pi-coding-agent` version `0.80.6`](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/package.json#L1-L21). The former `badlogic/pi-mono` URLs currently redirect to this repository. Pi is moving quickly and is still below version 1.0, so an implementation should pin an exact package version and keep contract tests around the behavior below.

Only primary sources were used: Pi's official documentation and source, and AWS's official Bedrock documentation.

## Answer

Use Pi's in-process TypeScript SDK, centered on `createAgentSession()`, as the Fireclanker runtime adapter. It is the documented embedding surface for a Node.js application and directly provides a persistent `SessionManager`, event subscription, cancellation, model selection, controlled tools, resource loading, and access to final messages. Pi's own RPC documentation recommends `AgentSession` for Node.js/TypeScript callers; RPC is the supported alternative when process isolation or a non-TypeScript host is more important ([Pi RPC documentation](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/rpc.md#L1-L18)).

Pi supplies the agent mechanics, but not a complete Fireclanker Job contract. In particular:

- Pi events are an observable live stream, not a durable Fireclanker Execution Transcript. Fireclanker must add Job identity, sequence numbers, receipt timestamps, redaction, and durable storage.
- Pi session JSONL is a useful retained interaction artifact, but it is not the event stream: it stores finalized messages and session entries, not every streaming update.
- `prompt()` completion or `agent_settled` means Pi has stopped automatically, not that a valid Fireclanker Outcome exists. Fireclanker must define and validate its own terminal Outcome.
- Pi cancellation is cooperative. Fireclanker needs a bounded grace period followed by process or MicroVM termination if the agent or a custom tool does not stop.

These are adapter responsibilities, not unsupported Pi workarounds.

## Supported Pi SDK surface

### One-shot setup and Amazon Bedrock

`createAgentSession()` accepts an explicit `cwd`, model, thinking level, tool allowlist, custom tools, resource loader, session manager, and settings manager. Its default persistent session manager is `SessionManager.create(cwd)`, although Fireclanker should pass one explicitly with a Job-scoped artifact directory ([SDK option types](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/sdk.ts#L34-L90), [factory defaults](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/sdk.ts#L167-L184)). `await session.prompt(instruction)` runs the accepted prompt through retries, compaction recovery, tool calls, and queued continuations before resolving.

Pi has a built-in `amazon-bedrock` provider backed by its `bedrock-converse-stream` API. It recognizes stored bearer credentials, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, access-key environment variables, ECS task credentials, and web-identity credentials; actual request signing uses the AWS SDK credential chain ([provider source](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/ai/src/providers/amazon-bedrock.ts#L6-L38)). The Bedrock implementation constructs an AWS `ConverseStreamCommand`, passes the agent's abort signal to `client.send()`, and converts provider failures into an assistant message with `stopReason: "error"` or `"aborted"` plus `errorMessage` ([Bedrock stream source](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/ai/src/api/bedrock-converse-stream.ts#L220-L303)).

For Fireclanker's execution role, AWS documents that `bedrock:InvokeModelWithResponseStream` authorizes both `InvokeModelWithResponseStream` and `ConverseStream`; using an inference profile additionally requires `bedrock:GetInferenceProfile` ([AWS inference prerequisites](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-prereq.html)). The model or inference-profile ID is passed as `modelId`. Pi's pinned built-in catalog contains all three models currently contemplated by the MVP—GPT-5.5, Claude Sonnet 5, and Claude Opus 4.8—under the `amazon-bedrock` provider ([Pi Bedrock model catalog](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/ai/src/providers/amazon-bedrock.models.ts)). Deployment still must validate that the selected model or inference profile is available in the selected AWS Region and account.

### Observable events and the actual terminal boundary

`session.subscribe(listener)` emits the typed `AgentSessionEvent` union. It includes:

- `agent_start`, `agent_end`, and `agent_settled`;
- `turn_start` and `turn_end`;
- `message_start`, `message_update`, and `message_end`;
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`;
- queue, compaction, retry, session-entry, session-info, and thinking-level events.

The authoritative union is in Pi's source ([`AgentSessionEvent`](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/agent-session.ts#L126-L156)); the RPC documentation gives the payload shapes for message and tool progress events ([event protocol](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/rpc.md#L802-L870), [tool events](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/rpc.md#L923-L966)). `toolCallId` correlates tool start, accumulated updates, and completion.

`agent_end` is not a terminal Job signal: a transient failure may be followed by automatic retry, overflow compaction and retry, or a queued continuation. `agent_settled` is emitted only after those session-level continuations are finished and the session becomes idle ([settlement implementation](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/agent-session.ts#L524-L542), [documented meaning](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/rpc.md#L836-L854)). Fireclanker must therefore use `agent_settled` or the fulfilled `prompt()` call as the classification boundary, never the first `agent_end`.

The event objects do not carry a Fireclanker Job ID or a uniform event timestamp, and streaming events can contain model thinking. Fireclanker should synchronously wrap and enqueue each accepted event as `{ jobId, sequence, observedAt, piEvent }`; a single ordered writer should then remove thinking blocks/deltas from the public Execution Transcript, redact configured credentials, and durably append the normalized event independently of Pi's session file. `session.subscribe()` listeners are synchronous and are not an asynchronous durability/backpressure boundary, so the Job must await a writer flush before committing terminal status. Because `tool_execution_update.partialResult` is accumulated output rather than a delta, the transcript mapper should either store replacements or derive deltas to avoid quadratic duplication.

### Session artifact

`SessionManager.create(cwd, sessionDir)` creates a new persistent JSONL session with a versioned header; `session.sessionFile` exposes its path. Session entries form a tree and include finalized user, assistant, tool-result, custom, compaction, model, and thinking-level records ([session format](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/session-format.md#L1-L28), [`SessionManager` API](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/session-format.md#L372-L421)). `AgentSession` persists completed messages on `message_end` ([persistence path](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/agent-session.ts#L571-L618)), and the manager appends JSONL synchronously once an assistant message exists ([file-write behavior](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/session-manager.ts#L940-L972)).

Two consequences matter:

1. The JSONL can be uploaded as the retained Pi session artifact after settlement, but it cannot replace the Execution Transcript because it omits live lifecycle updates.
2. A failure before the first assistant message—for example, no model or credential during prompt preflight—can leave only a prospective `sessionFile` path and no file. Fireclanker must persist such failures in its own Job record and treat the Pi artifact as optional in that case.

Pi writes raw message and tool-result data, with no Fireclanker credential-redaction contract. Uploading the session artifact therefore needs either the same sanitization policy as the Execution Transcript or access controls appropriate for potentially sensitive Job content.

### Cancellation

`await session.abort()` aborts retry, aborts the active agent run, and waits until the session is idle ([SDK cancellation](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/agent-session.ts#L1498-L1512)). The signal propagates to provider streaming and tool execution. Custom `ToolDefinition.execute()` receives an `AbortSignal` and an update callback ([tool contract](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/extensions/types.ts#L437-L483)); Pi's Bedrock provider forwards it to the AWS SDK as shown above.

This is supported graceful cancellation, not a kill guarantee. Every Fireclanker-owned tool must honor the signal, and the Job runner should enforce a short cancellation deadline. If `abort()` has not settled by that deadline, terminate the Pi process or the Job MicroVM. Classify a terminal assistant `stopReason: "aborted"` as cancelled only when Fireclanker has an accepted cancellation or timeout request; otherwise classify it as an execution failure.

### Structured Outcome and Fireclanker hooks

Pi's standard assistant message has `stopReason` values `stop`, `length`, `toolUse`, `error`, and `aborted`, and failures carry `errorMessage` ([session message schema](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/session-format.md#L67-L105)). A successful tool result is not by itself a successful Job, and an individual tool error can be shown back to the model and recovered from. Consequently, do not infer a Fireclanker Outcome merely from process exit code, `prompt()` fulfillment, or the last natural-language message.

The supported extension point for a machine-readable terminal result is a custom tool. A `ToolDefinition` has a TypeBox parameter schema, receives cancellation and progress hooks, returns structured `details`, and signals tool failure by throwing. A result can set `terminate: true` to stop without another model turn when every tool in that batch is terminating ([custom-tool semantics](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/docs/extensions.md#L1865-L1905)); Pi ships an official structured-output example using exactly this pattern ([example source](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/examples/extensions/structured-output.ts#L18-L64)).

Fireclanker should supply an explicit `complete_job` custom tool whose schema is the domain union:

```text
Response  = { kind: "response", text }
ChangeSet = { kind: "change_set", summary, pullRequests[] }
```

The tool should validate repository and publication facts against Fireclanker's own state, capture the Outcome outside the model transcript, return it in `details`, and set `terminate: true`. A Job succeeds only if exactly one valid `complete_job` result was captured and Pi subsequently settled without an accepted cancellation. This also handles the normal `toolUse` stop reason produced when the model terminates through the completion tool.

Pi also supports repository-specific behavior without forking Pi:

- `cwd` anchors built-in file and shell tools in the Focus Repository.
- `tools`/`excludeTools` provide a deterministic allowlist; `customTools` adds Fireclanker-owned operations.
- `DefaultResourceLoader` can inject a controlled system prompt, context files, skills, and inline extensions, and can disable automatic extension/resource discovery ([resource-loader options](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/core/resource-loader.ts#L122-L157)).
- Custom tools can expose the Repository Catalog, perform idempotent publication through Fireclanker, and stream publication progress through ordinary Pi tool events.

The isolated multi-repository workspace should be prepared by Fireclanker before starting Pi. Publication and final Change Set construction should remain in Fireclanker-owned custom tools or a host postprocessor rather than being inferred from arbitrary `git`/`gh` shell output. Whether draft pull requests are created during the Pi run or after it is a separate repository/publication workflow decision; both are supported by this runtime seam.

## Supported alternatives

| Integration | Supported capabilities | Limits for Fireclanker | Assessment |
| --- | --- | --- | --- |
| In-process SDK (`createAgentSession`) | Typed events and state, persistent `SessionManager`, direct `abort()`, explicit model/tools/resources, inline custom tools | Pi failure still must be mapped to Fireclanker status; same-process fatal faults share the runner | **Recommended** for the TypeScript/Effect Job runtime |
| `RpcClient` / `pi --mode rpc` | Supported JSONL command/response/event protocol; `prompt`, `abort`, `get_state`, `get_messages`, persistent `--session-dir`; typed `RpcClient` is exported from the main package ([export](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/index.ts#L324-L342)) | Extra subprocess/protocol/backpressure lifecycle; Fireclanker extensions must be packaged/loaded into the child; events have no request IDs | Good fallback if a separate Pi process is desired |
| `pi --mode json "prompt"` | One-shot process and JSON event output; session persistence remains enabled unless `--no-session` is used | No bidirectional abort command; the caller must signal/kill the process; JSON mode does not itself provide a Fireclanker terminal-result schema | Useful diagnostic/CLI integration, not the service adapter |
| `pi -p "prompt"` | One-shot final text; returns nonzero on terminal assistant `error`/`aborted` in the pinned source ([print-mode source](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/modes/print-mode.ts#L110-L145)) | No observable event stream or structured Outcome | Insufficient |

RPC is fully viable if chosen. Its strict LF-delimited JSON protocol streams responses and events independently; prompt success means only that the prompt was accepted, while later failures arrive in the event/message stream. The command union includes `abort`, state and session queries, and the response union has structured command errors ([RPC types](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/modes/rpc/rpc-types.ts#L20-L72), [responses](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/modes/rpc/rpc-types.ts#L94-L123)). The official `RpcClient` can subscribe, abort, and wait specifically for `agent_settled` ([client API](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/modes/rpc/rpc-client.ts#L168-L220), [settlement wait](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/coding-agent/src/modes/rpc/rpc-client.ts#L443-L490)). If RPC is used, omit `--no-session`, set an explicit `--session-dir`, load only the Fireclanker extension package, and treat child exit or malformed JSONL as an infrastructure failure distinct from a model failure.

## Recommended Fireclanker runtime contract

The following is a recommendation derived from the supported APIs above, not an API supplied by Pi:

```typescript
type PiJobResult =
  | { kind: "completed"; outcome: Outcome; sessionArtifact?: string }
  | { kind: "cancelled"; reason: "requested" | "timeout"; sessionArtifact?: string }
  | {
      kind: "failed";
      stage: "bootstrap" | "preflight" | "agent" | "tool" | "artifact";
      message: string;
      retryable: boolean;
      sessionArtifact?: string;
    };

interface PiJobRuntime {
  run(job: Job, events: ExecutionTranscriptSink, signal: AbortSignal): Promise<PiJobResult>;
}
```

Its one-shot lifecycle should be:

1. Fireclanker creates the isolated Repository Catalog workspace, with the Focus Repository as `cwd`, and a Job-scoped session directory.
2. Resolve one explicit `amazon-bedrock` model selected at deployment. Do not allow per-Job model fallback or model cycling.
3. Construct controlled settings/resources and `SessionManager.create(cwd, jobSessionDir)`, then call `createAgentSession()` with an explicit tool allowlist plus Fireclanker's catalog/publication and `complete_job` tools. Treat extension-load diagnostics as bootstrap failure.
4. Subscribe before prompting. Normalize, timestamp, sequence, and enqueue events; have one writer redact, filter thinking, and durably append them to the Execution Transcript sink. Flush the writer before terminal status.
5. Call `session.prompt(job.instruction)` once. On Job cancellation or timeout, call `session.abort()` once, wait for a bounded grace interval, then force termination if necessary.
6. At settlement, require the captured `complete_job` value for success. Otherwise map `aborted` with a cancellation request to cancelled; map `error`, `length`, missing Outcome, invalid Outcome, extension failure, or thrown runtime/preflight errors to failed. Do not fail merely because an intermediate tool result had `isError: true` if the agent later recovered and completed.
7. Upload the Pi JSONL session artifact if it exists, then dispose the session. The Fireclanker Job record and transcript remain authoritative even if artifact upload fails; the final specification must decide whether artifact-upload failure downgrades the Job or is recorded as a secondary diagnostic.

## Remaining uncertainties and contract tests

- **Pinning and upgrades:** the examined Pi API is pre-1.0 and its upstream repository/package scope recently changed. Pin `0.80.6` initially and test event shapes, settlement, session creation, and cancellation before every upgrade.
- **Bedrock timeout event:** AWS's official streaming response documents `modelTimeoutException` as a possible stream member ([AWS `ResponseStream`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ResponseStream.html)); the pinned Pi handler explicitly branches on internal-server, model-stream, validation, throttling, and service-unavailable members but not `modelTimeoutException` ([Pi handler](https://github.com/earendil-works/pi/blob/0e6909f050eeb15e8f6c05185511f3788357ddb3/packages/ai/src/api/bedrock-converse-stream.ts#L250-L280)). Verify the observed terminal event/error on each selected model and report upstream if it is not surfaced.
- **Cancellation coverage:** contract-test cancellation during Bedrock streaming, built-in `bash`, each Fireclanker custom tool, compaction, retry delay, and publication. Test the forced-termination fallback.
- **Retry ownership:** Pi emits its own model retry and overflow-recovery events, and the AWS SDK may retry transport calls. The reliability decision must explicitly configure those layers so they are not confused with retrying a Fireclanker Job after Pi has begun.
- **Structured completion adherence:** a schema does not guarantee the model calls `complete_job`. Test all three deployment-selectable models and preserve the missing/duplicate completion path as a deterministic failure.
- **Artifact sanitization and durability:** determine whether the retained Pi session is private raw evidence or a redacted user-visible artifact. Test early preflight failure, abrupt MicroVM termination, partial JSONL, redaction, and upload failure.
- **Repository/publication ownership:** this runtime supports either in-run publication tools or host-side publication after Pi settles. The repository execution and Change Set publication decision must choose the atomicity and idempotency boundary; it need not change the SDK choice.

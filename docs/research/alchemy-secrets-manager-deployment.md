# Alchemy and a deploy-supplied GitHub PAT

Research target: the pinned `alchemy-effect` revision `c999680eedb38aa1e311c65d8dd9ef67c785b9b8`.

## Conclusion

Alchemy can create and own the AWS Secrets Manager secret, but Fireclanker should **not** pass the GitHub PAT as `AWS.SecretsManager.Secret({ secretString: ... })` at this pinned revision. Although the API requires `Redacted<string>` and the normal plan UI does not print resource properties, Alchemy deliberately unwraps `Redacted` values when persisting state. The PAT would therefore be recoverable in plaintext from Alchemy state.

The safe deployment shape is:

1. Fireclanker's CLI reads the PAT from either a hidden terminal prompt or an explicit stdin mode. It must not accept the PAT as an argv value.
2. Alchemy creates the secret **without** `secretString` or `secretBinary`, and returns only its ARN/name as deployment output.
3. After the Alchemy deployment succeeds, the CLI calls AWS Secrets Manager `PutSecretValue` directly with the in-memory PAT and the returned ARN. The CLI then discards the value and prints only metadata.

This keeps the plaintext out of source, argv, Alchemy resource props, plans, stack outputs, and persisted Alchemy state. It still necessarily exists briefly in the Fireclanker CLI process and in the TLS-protected request to AWS.

## What the pinned Alchemy API supports

`AWS.SecretsManager.Secret` is the only Secrets Manager lifecycle resource. Its props include `secretString?: Redacted.Redacted<string>`, `secretBinary?: Redacted.Redacted<Uint8Array>`, and `generateSecretString`; there is no separate `SecretVersion` resource exported from the provider. On create it calls `CreateSecret`; on reconciliation it calls `UpdateSecret`, and its persisted attributes contain only ARN, name, current version ID, description, KMS key ID, and tags. [Secret resource source](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/SecretsManager/Secret.ts) [Secrets Manager exports](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/SecretsManager/index.ts)

The expected direct-value form is therefore:

```ts
const githubToken = yield* Config.redacted("GITHUB_TOKEN")

const secret = yield* AWS.SecretsManager.Secret("GitHubToken", {
  secretString: githubToken,
})
```

Equivalently, a custom CLI could wrap a prompt/stdin string with `Redacted.make(value)`. Alchemy resolves `Config.redacted` during planning so the concrete `Redacted` value reaches diffing and the provider. [Plan input resolution](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/Plan.ts#L382-L401) [Alchemy Secrets Manager guide](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/website/src/content/docs/aws/security/secrets-env.mdx#L112-L131)

Alchemy also exposes `PutSecretValue`, but it is a **runtime binding**, not a deploy-time `SecretVersion` resource. It binds a Lambda host to `secretsmanager:PutSecretValue` and `secretsmanager:DescribeSecret` on one managed secret, then returns a runtime function that calls the AWS API. It is not the appropriate mechanism for the deploy CLI to inject the initial PAT. [PutSecretValue binding](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/SecretsManager/PutSecretValue.ts) [PutSecretValue HTTP implementation](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/SecretsManager/PutSecretValueHttp.ts)

## Where the plaintext goes

### Persisted state: plaintext is present

The documentation says wrapping a value in `Redacted` keeps it out of state. That is not true of the pinned implementation. `encodeState` explicitly calls `Redacted.value(value)` and serializes the result as `{"__redacted__": <inner>}` so it can reconstruct the original value later. [State encoding source](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/State/StateEncoding.ts#L43-L69)

`localState()` writes that encoded object as ordinary pretty-printed JSON beneath `.alchemy/state`; there is no encryption in the local-state writer. The HTTP state store sends the same encoded payload to its backend. [Local-state writer](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/State/LocalState.ts#L128-L141) [HTTP-state writer](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/State/HttpStateStore.ts#L138-L153)

Tests confirm that resource props and outputs retain an unwrap-able `Redacted` containing the original secret across deploys. This persistence is required so Alchemy can distinguish an unchanged secret from a changed one. [Redacted state tests](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/test/apply.test.ts#L4613-L4740)

### Plan: hidden in the UI, present in memory

The resolved plan model retains an unwrap-able `Redacted` containing the plaintext; tests explicitly call `Redacted.value` on plan props. [Redacted plan tests](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/test/plan.test.ts#L2666-L2740)

The standard non-TUI plan logger prints resource identifiers and actions, not property values, so it does not normally disclose the PAT to terminal output. That display behavior is not a storage guarantee: custom inspection, error handling, or serialization can still access the in-memory value. [Plan logger](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/Cli/LoggingCli.ts#L60-L90)

### Stack/resource output

The `Secret` resource's own attributes do not contain the secret value, so returning its ARN/name is safe. However, returning a `Redacted` PAT as a stack output is unsafe because `localState.setOutput` passes outputs through the same plaintext-preserving `encodeState` routine. [Secret attributes](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/SecretsManager/Secret.ts#L56-L74) [Stack-output persistence](https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/State/LocalState.ts#L174-L185)

## Recommended CLI contract

- Interactive: prompt only when stdin is a TTY; disable terminal echo while reading; restore terminal settings in a `finally` path; reject an empty value.
- Automation: require an explicit `--github-token-stdin`; read exactly one value from stdin, trim only the trailing line ending, and reject a TTY in this mode to catch accidental visible entry.
- Never accept `--github-token VALUE`, put the token in an environment variable as the primary documented path, include it in structured logs/errors, return it from the Alchemy stack, or pass it as an Alchemy resource prop.
- Invoke `PutSecretValue` after a successful infrastructure apply. On a retry, another `PutSecretValue` call creates a new current version; a future implementation may supply an idempotency token if it needs retry deduplication.
- If Alchemy owns deletion of the empty secret, a failed value write should leave the deployment visibly incomplete and return a retryable error; it should not print the PAT or silently report success.

The key distinction is that `Redacted` is a logging/display wrapper in this revision, not encryption and not omission from state.

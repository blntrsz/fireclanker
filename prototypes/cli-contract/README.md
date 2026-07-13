# Fireclanker CLI contract prototype

> THROWAWAY PROTOTYPE — this is not an implementation of Fireclanker.

## Question

What exact command surface, arguments, human-readable output, machine-readable
output, and interaction behavior make detached-by-default submission,
Repository Set selection, `--watch`, inspection, listing, cancellation, and
deployment coherent for the MVP?

The prototype uses Effect CLI and fixture data. It performs no network calls and
persists nothing. Its purpose is to make the proposed contract runnable enough
to react to before the contract is captured in the MVP specification.

## Run it

```sh
bun run prototype:cli --help
```

Useful paths through the prototype:

```sh
bun run prototype:cli run "Explain the failing build"
bun run prototype:cli run "Coordinate a release" --repos acme/api,acme/web
bun run prototype:cli run --file instruction.md
printf 'Explain the failing build\n' | bun run prototype:cli run --file -
bun run prototype:cli run "Fix the failing build" --watch
bun run prototype:cli get job_01RUNNING --watch
bun run prototype:cli get job_01SUCCEEDED
bun run prototype:cli list
bun run prototype:cli list --limit 2
bun run prototype:cli cancel job_01RUNNING
bun run prototype:cli --json list
bun run prototype:cli --json get job_01RUNNING --watch
bun run prototype:cli deploy
bun run prototype:cli --json deploy --yes
```

`job_01QUEUED`, `job_01RUNNING`, `job_01SUCCEEDED`, `job_01FAILED`, and
`job_01CANCELLED` are recognized fixture IDs. Other IDs return `job_not_found`.

Machine-readable output is one compact JSON object per line. Unary commands emit
one line; watched commands emit an NDJSON event stream. Structured errors use
the same format on stderr. Human decoration is suppressed, and the CLI never
prompts in JSON or non-interactive mode, so `deploy` requires `--yes` there.

When `--repos` is omitted, `run` infers a singleton Repository Set from the
current checkout's GitHub `origin`. If no such checkout exists, the Repository
Set is empty.

Every Repository Set member must exist in the deployment's Repository Catalog;
otherwise `run` rejects the submission before creating a Job.

## Compile one executable

```sh
bun run prototype:cli:build
./prototypes/cli-contract/fireclanker-prototype --help
```

The generated executable is ignored by Git.

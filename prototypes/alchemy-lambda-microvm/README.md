# PROTOTYPE — Alchemy Lambda MicroVM deployment path

This throwaway prototype answers one question: can Alchemy `2.0.0-beta.61`
from the exact pinned `c999680e` source checkout deploy an
ARM64 Lambda MicroVM image to the Granted `sandbox` account in `us-east-1`, run
one no-ingress Job with per-Job `/run` initialization, observe readiness and
CloudWatch logs, and terminate it without leaking a MicroVM?

Run the complete deploy → Job → log verification → destroy cycle with:

```sh
bun run prototype
```

The command installs that checkout's frozen dependencies, assumes the Granted
`sandbox` profile, creates a disposable Alchemy assets bucket when needed, uses
a dedicated Wayfinder stage, and destroys the prototype stack and bucket even
when the Job exercise fails. It requires Granted's `assume` command and access
to the `sandbox` profile.

## Observed result

Verified twice on 2026-07-13. The final clean run built image version `1.0` in
about 130 seconds, launched one 512 MiB ARM64 MicroVM, and observed these state
transitions:

```text
PENDING (320 ms) -> RUNNING (2,695 ms) -> TERMINATING (3,076 ms) -> TERMINATED (5,247 ms)
```

The `/run` hook received the Job-specific 83-byte payload and emitted a marker
to the requested CloudWatch log stream. The launch reported the AWS-managed
`NO_INGRESS` connector. AWS still returned an endpoint object and defaulted
egress to `INTERNET_EGRESS`, so no ingress must not be described as full network
isolation.

## Compatibility findings

- Granted's exported credentials were sufficient, but this pinned Alchemy
  revision stalled while discovering the account through STS unless
  `AWS_ACCOUNT_ID` was also supplied.
- Alchemy requires its tagged account-regional S3 assets bucket before it can
  upload the external image build context. The prototype creates and removes
  that bucket through the pinned bootstrap implementation.
- Enabling the per-MicroVM `/run` hook also requires the image `/ready` hook;
  AWS rejects the image configuration otherwise.
- AWS wraps `runHookPayload` in a JSON envelope containing `microvmId`; the
  application must parse the outer object and then the serialized payload.
- Image deletion took about 70 seconds. One earlier cleanup received a
  transient HTML `502 Bad Gateway`; the prototype retries stack destruction.
- The source commit and the published package carrying the same beta version
  were not behaviorally equivalent during this experiment. This artifact uses
  the exact source checkout and Alchemy's Core adapter, leaving the production
  invocation seam to the deployment-contract decision.

This directory is a primary-source experiment, not production Fireclanker
code.

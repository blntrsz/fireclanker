# Alchemy and AWS Lambda MicroVM operating envelope

Research date: 2026-07-13

This note resolves the Wayfinder question: what current Alchemy and AWS Lambda
MicroVM capabilities and constraints bound Fireclanker's Job runtime?

## Conclusion for Fireclanker

Lambda MicroVMs fit the intended one-fresh-environment-per-Job model, but they
set hard MVP boundaries:

- A Job can exist for at most 8 hours, including time spent suspended.
- The service currently supports ARM64 only. Fireclanker's image, Pi, and every
  native dependency must therefore run on Linux/aarch64.
- A MicroVM has a configurable 0.5–8 GB / 0.25–4 vCPU baseline, can burst
  vertically to four times that baseline, and has 8–32 GB of local disk
  depending on its baseline size.
- The MicroVM's disk and memory survive suspend/resume but not termination.
  The Execution Transcript, Job Status, and Outcome therefore need durable
  storage outside the MicroVM before it is terminated.
- Lambda measures idleness only by inbound proxy traffic. A one-shot Pi process
  doing work without inbound requests can look idle, so Fireclanker must omit
  automatic suspension or set an idle window longer than the Job limit.
- Public internet egress is available by default. Ingress can be disabled;
  otherwise it is a dedicated TLS endpoint requiring a short-lived,
  MicroVM-and-port-scoped JWE token. VPC egress requires a Lambda Network
  Connector.
- Default account capacity is memory-based and regional. In Europe (Ireland),
  the published default is 400 GB of allocated baseline memory across running
  and suspended MicroVMs, burstable to four times that quota. At the 2 GB
  default size that is 200 MicroVMs before burst capacity, subject to the
  account's actual Service Quotas.
- Lambda MicroVMs are available only in five Regions today: `us-east-1`,
  `us-east-2`, `us-west-2`, `ap-northeast-1`, and `eu-west-1`.
- Alchemy support is new and beta-only. The checked-out upstream `main` still
  reports package version `2.0.0-beta.61`, and its docs still describe Lambda
  MicroVMs as a preview requiring account onboarding. Fireclanker should pin an
  exact Alchemy commit and prove deployment in its target account and Region
  before treating the runtime choice as implementation-ready.

The AWS constraints above come from the [Lambda MicroVM developer guide],
[MicroVM image sizing], [Lambda quotas], and the [regional launch notice].

## AWS runtime resources

Lambda uses a baseline/peak model. vCPU is fixed at one vCPU per 2 GB of
memory; the service vertically scales a MicroVM up to four times its baseline
when it consumes more resources. Baseline resources are billed for every
running second, while above-baseline resources are billed only while consumed.

| Baseline | Automatic peak | Maximum local disk | Endpoint bandwidth |
| --- | --- | --- | --- |
| 0.5 GB / 0.25 vCPU | 2 GB / 1 vCPU | 8 GB | 1 MB/s |
| 1 GB / 0.5 vCPU | 4 GB / 2 vCPU | 8 GB | 2 MB/s |
| 2 GB / 1 vCPU (default) | 8 GB / 4 vCPU | 8 GB | 4 MB/s |
| 4 GB / 2 vCPU | 16 GB / 8 vCPU | 16 GB | 8 MB/s |
| 8 GB / 4 vCPU | 32 GB / 16 vCPU | 32 GB | 16 MB/s |

The size and disk table is published in [MicroVM image sizing]; endpoint
bandwidth is published in [MicroVM networking]. The API's only valid CPU
architecture is `ARM_64`, also called out in [Lambda quotas].

The platform publishes fixed per-MicroVM proxy limits of 8, 16, 32, 64, and
128 concurrent connections at 1, 2, 4, 8, and 16 vCPU respectively. Published
request-rate limits are 40 requests/s at 4 vCPU / 8 GB and 160 requests/s at
16 vCPU / 32 GB. These are endpoint limits, not useful Job parallelism inside a
single one-shot Fireclanker runtime.

## Lifecycle and Job execution

The runtime state machine is:

`PENDING -> RUNNING -> SUSPENDING -> SUSPENDED -> RUNNING`, followed by
`TERMINATING -> TERMINATED`.

`RunMicrovm` is asynchronous: it initially returns a MicroVM in `PENDING`.
AWS warns that `GetMicrovm.state` is eventually consistent and recommends
determining readiness by successfully connecting to the endpoint. The maximum
duration is 1–28,800 seconds and covers the entire existence of the MicroVM,
not just CPU-active time. See [running and using MicroVMs] and the
[RunMicrovm API].

Suspend can be explicit or idle-policy-driven. Suspend preserves the full
memory and disk checkpoint; resume restores it. Lifecycle hooks exist for:

- image build: `/ready`, `/validate`;
- instance runtime: `/run`, `/resume`, `/suspend`, `/terminate`.

The `/run` hook is the right place to establish per-Job uniqueness, fetch
short-lived credentials or secret references, and start Pi. The `/resume` hook
must refresh expired credentials and connections. The `/suspend` and
`/terminate` hooks are opportunities to flush state, but durable Job state
should not depend on a terminal hook being the sole copy.

An idle policy's minimum idle duration is 60 seconds, and suspended retention
is at least 0 seconds. Crucially, idleness means *absence of inbound traffic at
the Lambda proxy endpoint*, not absence of CPU or process activity. AWS
explicitly tells asynchronous applications that do not use the endpoint to
disable automatic suspension or choose a suitable idle duration. This makes
automatic idle suspend unsafe for Fireclanker's one-shot asynchronous Job
unless the control plane deliberately keeps endpoint traffic flowing.

`runHookPayload` is documented as a 16 KB per-MicroVM initialization payload,
but the current API reference simultaneously declares a 4,096-character
schema maximum. Until AWS resolves that inconsistency, Fireclanker should keep
the payload within 4,096 characters and pass identifiers or secret references,
not an entire Job specification or credentials.

Termination releases compute and stops instance charges. Because AWS only
documents local disk preservation through suspend/resume and termination
releases the instance, this note infers that all per-Job filesystem state is
ephemeral at termination. Anything needed for the Execution Transcript or
Outcome must be uploaded before teardown.

## Networking

Network connectors are selected at `RunMicrovm` time and cannot change while
the MicroVM is running.

Ingress uses a unique service-managed HTTPS endpoint. Supported protocols are
HTTP/1.1, HTTP/2, WebSockets, gRPC, and server-sent events. Port 8080 is the
default, with another port selected using `X-aws-proxy-port` or the WebSocket
subprotocol. Every request requires an encrypted JWE auth token scoped to one
MicroVM, an allowed port set, and an expiry. Endpoint token lifetime is 1–60
minutes. Shell access has a separate token and requires launching with the
`SHELL_INGRESS` connector. Fireclanker's production Job runtime should use
`NO_INGRESS` unless the chosen control-plane protocol requires inbound calls;
shell ingress is a debugging capability, not a standing production path.

Egress defaults to the public internet. A customer-managed VPC egress connector
routes traffic through selected subnets and security groups and may use IPv4
or dual-stack networking. Connector creation provisions ENIs asynchronously;
the connector must reach `ACTIVE` before use. A connector is reusable across
MicroVMs, but AWS warns not to update or delete it while any attached MicroVM
is running.

The network connector operator role needs `ec2:CreateNetworkInterface` on
network interfaces, subnets, and security groups, plus conditional
`ec2:CreateTags` for Lambda-managed ENIs. See [MicroVM networking].

## Images, snapshots, and storage

A MicroVM image is a versioned Firecracker snapshot. AWS retrieves an S3 build
artifact, runs its root `Dockerfile` on a Lambda-managed Amazon Linux 2023
MicroVM base, starts `ENTRYPOINT`/`CMD`, waits for readiness, and snapshots:

- all running process memory;
- the root filesystem, including build-time writes;
- open network connections and file descriptors.

Every MicroVM from the same image version begins with that identical state.
IDs, secrets, random seeds, cached credentials, and live connections created
during build must not be assumed unique or fresh. Generate or refresh them in
`/run` and `/resume`. AWS recommends its
`public.ecr.aws/lambda/microvms:al2023-minimal` container base, including its
snapshot-safe OpenSSL; a custom Linux base must be architecture-compatible,
reachable by the build infrastructure, and snapshot-compatible. Private ECR
needs additional build-role permissions. See [working with snapshots] and
[MicroVM images].

Updating an image creates a new version. A successful version can be marked
`ACTIVE` or `INACTIVE`; `RunMicrovm` can pin a version or default to the latest
active version. Managed MicroVM bases age through `AVAILABLE`, 60 days of
`DEPRECATED`, 30 days of `EXPIRING`, then `EXPIRED`; a `RECALLED` base becomes
unavailable immediately. Fireclanker therefore needs a rebuild/roll-forward
process and must not assume an old image remains runnable indefinitely.

## IAM boundaries

AWS separates three roles/principals:

1. The deployment/control-plane principal calls MicroVM image, instance,
   connector, token, and lifecycle APIs.
2. The build role reads the S3 artifact, optionally reads private ECR layers,
   and writes build logs.
3. The execution role is assumed inside a running MicroVM and grants runtime
   access to CloudWatch and any other AWS service Fireclanker deliberately
   exposes.

Build and execution roles are optional in raw AWS APIs, but omitting them also
removes their corresponding AWS access and CloudWatch logging. Both trust
`lambda.amazonaws.com` for `sts:AssumeRole` and `sts:TagSession`. The operator
actions include the image CRUD/version APIs, `Run/Get/ListMicrovm`,
`Suspend/Resume/TerminateMicrovm`, and auth-token creation. See
[MicroVM security and permissions].

Per-Job GitHub/model secrets should not be image environment variables: those
are set at image-build time and shared by every MicroVM from the image. Prefer
the execution role for AWS access and use the `/run` payload only for a Job ID,
signed reference, or secret-store path. This boundary also avoids snapshotting
long-lived secrets into every Job runtime.

## Regional quotas and API rates

Published defaults are per account and Region unless noted:

| Resource or operation | Default |
| --- | --- |
| Allocated baseline memory across running + suspended MicroVMs | 1,024 GB in `us-east-1`, `us-east-2`, `us-west-2`, and `ap-northeast-1`; 400 GB in other supported Regions; burstable to 4x; adjustable |
| MicroVM images | 100; adjustable |
| Versions per image | 50; adjustable |
| Concurrent image builds | 10 in the four 1,024 GB Regions; 5 in other supported Regions; adjustable |
| Network connectors | 1,000; not adjustable |
| `RunMicrovm` | 5 TPS, burst 5; adjustable |
| `ResumeMicrovm` | 5 TPS, burst 5; adjustable |
| `SuspendMicrovm` | 2 TPS, burst 2; adjustable |
| `TerminateMicrovm` | 10 TPS, burst 10; adjustable |
| `GetMicrovm` | 100 TPS, burst 100; adjustable |
| `CreateMicrovmAuthToken` | 50 TPS, burst 50; adjustable |
| `CreateMicrovmShellAuthToken` | 5 TPS, burst 5; adjustable |
| Maximum MicroVM existence | 8 hours; not adjustable |

New AWS accounts may receive smaller initial quotas. Fireclanker's own
concurrency limit must stay below both its chosen product limit and the actual
regional memory quota. The 5 TPS `RunMicrovm` rate also means a burst queue must
drain launches with throttling retries and jitter rather than starting every
queued Job simultaneously. See [Lambda quotas].

## Pricing envelope

MicroVM pricing has four components:

- per-second vCPU and memory while running, including the configured baseline
  even when underused and measured above-baseline consumption during bursts;
- snapshot reads on launch/resume and writes on suspend;
- snapshot storage for images and suspended instances;
- standard AWS data transfer, including transfer between MicroVMs and a VPC.

There are no instance compute charges while suspended and no instance charges
after termination. Image storage has a one-week minimum retention period.

AWS's current US East (N. Virginia), ARM example uses
`$0.0000276944/vCPU-second`, `$0.0000036667/GB-second`, `$0.00155/GB` snapshot
read, `$0.0038/GB` snapshot write, and `$0.08/GB-month` snapshot storage. These
are example-region rates, not a universal fixed price. AWS's directly
comparable CI/CD example—10,000 one-shot ten-minute Jobs at an 8 GB / 4 vCPU
baseline, spending 10% at the 32 GB / 16 vCPU peak—totals `$1,124.03`, or about
`$0.112` per Job, before other AWS services and material data transfer. See
[Lambda pricing].

For Fireclanker, the main cost controls are a small baseline, immediate
termination after durable finalization, no suspend/resume for one-shot Jobs,
small images, and an explicit concurrency cap. Launches still incur snapshot
read charges even when Jobs fail before Pi starts.

## Alchemy support at the checked-out revision

The repository is checked out as the `.agents/alchemy-effect` submodule at
commit `c999680eedb38aa1e311c65d8dd9ef67c785b9b8`. Its package still identifies
as `2.0.0-beta.61`; Lambda MicroVM support first arrived in beta.60. The stable
`latest` npm line remains 0.x, while 2.x is published under `next`. Fireclanker
must therefore pin the beta/commit rather than request an unconstrained
`latest` version.

Alchemy provides:

- `AWS.Lambda.MicrovmImage` with three build modes: Effectful TypeScript
  (`main`, Node or Bun), an external Docker build context, or a prebuilt S3/ECR
  artifact;
- server-side builds and an automatically bootstrapped S3 Assets bucket for
  Effectful/external modes;
- automatic S3 and CloudWatch grants when an Alchemy `Role` is passed as the
  build role;
- image sizing, base pinning, OS capabilities, lifecycle hooks, environment,
  logging, and image-level egress connector configuration;
- typed runtime bindings for run/get/list, auth tokens, suspend/resume,
  terminate, and image/version inspection;
- automatic, image-scoped IAM grants for those runtime bindings, including
  `lambda:PassNetworkConnector` for `RunMicrovm`;
- a typed Effect RPC/fetch server and `connectMicrovm` client for Effectful
  images;
- forwarding of the raw AWS `RunMicrovm` request except for the injected image
  identifier, so Fireclanker can still supply execution role, version, network
  connectors, logging, duration, idle policy, and `/run` payload.

See the exact checked-out [Alchemy MicroVM image source], [runtime binding
source], and [Alchemy MicroVM guide].

### Current Alchemy hazards

These findings are from the source at the pinned commit, not inferred from the
public guide:

1. **External-context changes can be missed.** The provider computes an
   external context's build identity from each file's path and byte length, not
   its bytes. Editing a file without changing its length leaves the identity
   unchanged, so reconcile can skip the image rebuild. Prebuilt artifacts are
   similarly identified by URI rather than object contents. Until fixed,
   Fireclanker should use content-addressed prebuilt artifact URIs, Effectful
   mode, or another explicit rebuild trigger; it should not trust an in-place
   external-context edit to deploy.
2. **Image deletion is destructive to active Jobs.** Alchemy's delete provider
   enumerates and terminates all `PENDING`, `RUNNING`, `SUSPENDING`, and
   `SUSPENDED` MicroVMs from the image before deleting it. Renaming an image is
   a replacement. Deployment/nuke procedures must prevent deleting an image
   version while it backs live Jobs.
3. **Build waits are bounded at about 12 minutes.** The provider polls every 10
   seconds for 72 recurrences. A slow but valid image build can therefore fail
   the Alchemy deployment even though AWS continues building it.
4. **Preview status is contradictory.** Current Alchemy docs say the AWS
   account must be preview-onboarded, while AWS's June 2026 launch notice and
   product docs describe the service as available without a preview caveat.
   Target-account deployment is the authoritative check.
5. **Runtime cleanup is application-owned.** Alchemy's own example wraps every
   launched MicroVM in `Effect.ensuring(TerminateMicrovm(...))`. Fireclanker's
   durable control plane still needs a periodic reconciler for leaked MicroVMs
   because a process crash can bypass an in-process finalizer.

The first three hazards are visible in the checked-out [Alchemy MicroVM
provider source].

## Decisions this unlocks

The remaining architecture tickets can now assume the following facts:

- A Fireclanker Job timeout must be at most 8 hours.
- The runtime image is ARM64 Linux and needs external durability.
- The likely one-shot policy is no ingress, public egress, no automatic idle
  suspend, immediate terminate after durable finalization, and explicit leaked
  MicroVM reconciliation. These are architectural choices to confirm, not part
  of this research ticket's decision.
- Per-Job configuration belongs in a small `/run` payload plus an execution
  role/secret reference, never image-level environment.
- Deployment must pin and validate Alchemy, choose one of five Regions, and
  protect live image versions from destructive deletion.
- Before the design is implementation-ready, a minimal target-account
  deployment should validate current service access and the Alchemy provider's
  build/run/terminate path.

[Alchemy MicroVM guide]: https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/website/src/content/docs/aws/compute/microvms.mdx
[Alchemy MicroVM image source]: https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/Lambda/MicrovmImage.ts
[Alchemy MicroVM provider source]: https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/Lambda/MicrovmProvider.ts
[runtime binding source]: https://github.com/alchemy-run/alchemy-effect/blob/c999680eedb38aa1e311c65d8dd9ef67c785b9b8/packages/alchemy/src/AWS/Lambda/MicrovmBinding.ts
[Lambda MicroVM developer guide]: https://docs.aws.amazon.com/lambda/latest/dg/lambda-microvms-guide.html
[MicroVM image sizing]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
[Lambda quotas]: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
[regional launch notice]: https://aws.amazon.com/about-aws/whats-new/2026/06/aws-lambda-microvms/
[running and using MicroVMs]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html
[RunMicrovm API]: https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html
[MicroVM networking]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html
[working with snapshots]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images-snapshots.html
[MicroVM images]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-images.html
[MicroVM security and permissions]: https://docs.aws.amazon.com/lambda/latest/dg/microvms-security.html
[Lambda pricing]: https://aws.amazon.com/lambda/pricing/

# GitHub publication operating envelope

## Question and fixed context

What constraints do a least-privilege GitHub token and GitHub APIs impose on cloning repositories from the Repository Catalog and publishing a cross-repository Change Set from an isolated Job runtime?

This note assumes the MVP decisions already recorded by **Specify the Fireclanker MVP**: a deployment uses one GitHub token, a GitHub App is deferred, a successful Change Set contains one or more draft pull requests, Fireclanker never merges or approves them, and it does not automatically close or roll back partially published pull requests.

## Recommended MVP envelope

Use one manually provisioned, expiring **fine-grained personal access token (PAT)** belonging to a dedicated GitHub machine user that is a member of one GitHub organization. Limit the token to the Repository Catalog's explicitly selected repositories and grant only:

- **Contents: write**, which includes read, for HTTPS clone/fetch and branch push.
- **Pull requests: write** for listing, creating, and inspecting draft pull requests.
- **Workflows: write** only if Jobs are allowed to add or change files under `.github/workflows/`; otherwise reject such a Change Set before publication.

Do not grant administration, issues, checks, actions, organization, or account permissions. Treat repositories owned by another organization, repositories where the machine user is only an outside collaborator, and uncatalogued repositories as unsupported in the single-token MVP.

For each changed repository, use local Git for commits and HTTPS push, then use the REST API to create a draft pull request in that same repository. Use a deterministic branch name derived from the Job ID, such as `fireclanker/job-<job-id>`, and record the repository, base ref and SHA, branch, expected head SHA, and pull-request number/URL in a durable publication journal. Publish changed repositories serially in stable order. Reconcile every ambiguous write by reading GitHub state before repeating it.

If a permanent failure occurs after earlier draft pull requests were created, stop publishing further repositories, leave the already-created drafts and branches intact, mark the Job failed, and expose all published links plus the failure in the Execution Transcript. A partial set of drafts is not a successful Change Set. The MVP should not automatically resume publication after Pi has begun; the deterministic identifiers and journal support in-attempt reconciliation and operator diagnosis, not a hidden post-execution Job retry.

## Documented constraints

### Token identity, repository scope, and permissions

**Fact.** A fine-grained PAT acts with the token owner's access, narrowed by the token's own permissions; it cannot grant access the owner lacks. It is limited to resources owned by one selected user or organization and can be limited to selected repositories. Both fine-grained and classic PATs are tied to their creating user and become inactive if that user loses access. GitHub recommends fine-grained PATs where possible and says long-lived organization integrations should use a GitHub App. ([Managing personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#about-personal-access-tokens))

**Fact.** Fine-grained PATs currently cannot access multiple organizations at once and cannot contribute where the user is an outside or repository collaborator. By contrast, a classic PAT's broad `repo` scope can reach every repository its owner can access. ([Fine-grained PAT limitations](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#fine-grained-personal-access-tokens-limitations), [classic PAT warning](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic))

**Fact.** GitHub supports machine-user accounts for automation. For multi-repository access, GitHub documents adding the machine user as a collaborator or organization team member; a machine user consumes an Enterprise seat. Account creation itself must not be automated. ([Types of GitHub accounts](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts#user-accounts), [machine users](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys#machine-users))

**Fact.** Creating a pull request in an organization-owned repository requires the caller to be an organization member and to have write access to the head branch. The create-pull-request endpoint requires **Pull requests: write** and accepts `draft: true`. ([Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request))

**Fact.** GitHub's reference-creation and reference-update endpoints require **Contents: write**; **Workflows: write** is additionally applicable when workflow files are involved. GitHub's own fine-grained-token template for updating code and opening a pull request combines `contents=write`, `pull_requests=write`, and `workflows=write`, and says to remove workflow permission if workflow editing is unnecessary. ([Create/update Git references](https://docs.github.com/en/rest/git/refs), [fine-grained PAT permission templates](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters))

**Fact.** Organizations can block fine-grained PATs, require administrator approval, and enforce a maximum token lifetime. A pending token can read only public resources until approved. ([Creating a fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token), [organization PAT policy](https://docs.github.com/en/organizations/managing-programmatic-access-to-your-organization/setting-a-personal-access-token-policy-for-your-organization))

**Fact.** An Enterprise Cloud organization IP allow list applies to PAT-authenticated web, API, and Git access. Therefore an isolated runtime with non-allow-listed egress cannot clone, push, or call the REST API even if the token permissions are correct. ([Managing allowed IP addresses](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/managing-allowed-ip-addresses-for-your-organization#about-allowed-ip-addresses))

**Recommendation.** Constrain one deployment's Repository Catalog to repositories owned by one organization, and make the machine user a minimal organization member rather than an outside collaborator. At deployment and before starting a Job, validate token identity, expiry, organization approval, selected-repository access, repository default branch, archived state, and effective push/PR capability. If an organization enforces an IP allow list, deployment must provide stable allow-listed egress or reject that catalog configuration.

### Clone, branch, commit, push, and pull-request mechanics

**Fact.** A PAT can replace a password for Git operations over HTTPS. A username must still be supplied, but the token—not that username—authenticates the operation; PATs do not authenticate SSH remotes. ([Using a PAT on the command line](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#using-a-personal-access-token-on-the-command-line))

**Fact.** The REST pull-request endpoint is scoped to one `{owner}/{repo}`, compares one `head` with one `base`, and returns `201` on creation. Listing pull requests can filter by `head` in `owner:branch` form and by `base`. ([Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request), [List pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests))

**Fact.** Repository rules can restrict branch creation and updates, require signed commits, restrict file paths or metadata, and block force pushes. Token permission alone does not bypass these rules; bypass is granted separately to configured actors. ([Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets))

**Inference.** GitHub has no single pull request spanning unrelated destination repositories: each changed Repository Catalog entry needs its own branch and pull request. The Change Set is Fireclanker's coordination record over those independent GitHub objects.

**Recommendation.** Clone only Repository Catalog entries the Job actually needs, always with canonical HTTPS remotes. Supply the PAT through an ephemeral credential helper or `GIT_ASKPASS` with terminal prompts disabled; never embed it in a remote URL, command argument, repository config, commit, or transcript. GitHub explicitly advises against passing a PAT as plaintext on the command line and recommends a secret manager. ([Keeping API credentials secure](https://docs.github.com/en/rest/authentication/keeping-your-api-credentials-secure#store-your-authentication-credentials-securely))

**Recommendation.** Make and validate all local changes before the first remote mutation. For every changed repository:

1. Record the exact base branch and base SHA used by Pi.
2. Configure explicit bot author/committer identity, create the commit(s), and record the expected head SHA.
3. Push `HEAD` to the deterministic Job branch without force.
4. Create a pull request with that branch as `head`, the recorded base branch as `base`, and `draft: true`.
5. Include the Job ID and a machine-readable Job marker in the pull-request body, then journal the returned number and URL.

Repositories whose rules reject this flow are not compatible Repository Catalog entries until their rules or the publication identity are deliberately changed. Do not grant administration merely to bypass repository policy.

### Authorship and attribution

**Fact.** Authentication identity and Git commit identity are separate. Git's configured username is visible on command-line commits and is not the GitHub username. GitHub associates command-line commits with an account through an email connected to that account, including its GitHub-provided `noreply` address. ([Setting the Git username](https://docs.github.com/en/get-started/git-basics/setting-your-username-in-git), [commit email attribution](https://docs.github.com/en/account-and-profile/concepts/email-addresses#commit-email-addresses))

**Fact.** A PAT acts on behalf of the user who created it, so GitHub API objects created with the PAT, including pull requests, are actions of that machine-user account. ([About PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#about-personal-access-tokens), [user accounts and attribution](https://docs.github.com/en/get-started/learning-about-github/types-of-github-accounts#user-accounts))

**Recommendation.** Set both Git author and committer to a stable Fireclanker machine-user name and that account's ID-based GitHub `noreply` email. The PR author is necessarily the same machine user. Put the Job ID and submitting AWS IAM principal in the PR body and Execution Transcript for provenance. Do not impersonate the submitter as commit author or add `Co-authored-by` unless Fireclanker has an explicit, verified mapping to an email associated with that person's GitHub account; GitHub requires such an email for co-author attribution. ([Creating a commit with multiple authors](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors#required-co-author-information))

**Recommendation.** Commit signing is not implied by PAT authentication. If a catalogued repository requires signed commits on the Job branch, Fireclanker must later add a protected signing-key flow or declare the repository incompatible; silently weakening the ruleset is outside the least-privilege envelope.

### Idempotency, retries, and reconciliation

**Fact.** Creating a reference is a `POST` that returns `201`, `409`, or `422`; creating a pull request is a `POST` that returns `201`, `403`, or `422`. Neither documented request accepts an idempotency key. The API does expose reads for a named reference and for pull requests filtered by head/base. Updating a reference without `force` enforces a fast-forward update; `force: true` permits overwriting work. ([Git references endpoints](https://docs.github.com/en/rest/git/refs), [Pull requests endpoints](https://docs.github.com/en/rest/pulls/pulls))

**Inference.** A client timeout or lost response after a successful `POST` leaves an ambiguous outcome. Blindly repeating creation is unsafe; the only available idempotency is application-level identity plus read-after-write reconciliation.

**Recommendation.** Use `(repository, Job ID)` as the publication identity and apply these rules:

- Before push, read `refs/heads/fireclanker/job-<job-id>`. If absent, push. If present at the expected head SHA, treat push as complete. If present at another SHA, fail with a collision; never force it.
- Before PR creation, list pull requests for the exact head owner/branch and base. Reuse the one whose body carries the same Job marker. If more than one matches or metadata conflicts, fail for operator review.
- After any connection loss or 5xx from push or PR creation, perform the same reads before retrying. Record reconciliation decisions in the Execution Transcript.
- Retry only transport failures, 5xx responses, and documented rate-limit responses. Do not retry authentication/authorization, validation, rule, archived-repository, or branch-collision failures without a state change.
- Bound retries by the Job time limit. A publication retry repeats only the failed remote operation; it never reruns Pi or regenerates commits.

**Fact.** GitHub recommends serial API requests, at least a one-second pause between many mutative requests, and specific handling for primary and secondary limits: honor `Retry-After`; if `X-RateLimit-Remaining` is zero, wait until `X-RateLimit-Reset`; otherwise wait at least one minute and use increasing backoff, then stop after a bounded number of retries. Continuing while rate-limited can result in an integration ban. PAT-authenticated REST requests share the user's primary rate limit, normally 5,000 requests per hour. ([REST API best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api), [REST API rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api))

**Recommendation.** Because concurrent isolated Jobs share one PAT and therefore one actor and rate budget, coordinate mutative GitHub operations through a deployment-level limiter or queue rather than relying only on per-runtime backoff. Persist response status, GitHub request ID, rate-limit headers, and sanitized error bodies in the Execution Transcript.

### Partial multi-repository publication

**Inference.** GitHub exposes independent repository-scoped branch and pull-request mutations and no transaction across repositories. Once a draft is created, a later repository failure cannot atomically undo it.

**Recommendation.** Separate local preparation from publication, then publish serially in a deterministic repository order. After each successful push and PR creation, durably append the publication journal before moving to the next repository. On terminal failure, fail fast to minimize the partial surface. Do not report a Change Set Outcome unless every intended draft pull request exists and matches its expected branch head. Preserve already-created drafts and branches, because automatic rollback/closure is outside the map's destination and rollback itself can fail. The Execution Transcript must identify:

- the intended repository set and order;
- every repository's base SHA and expected head SHA;
- every created branch and draft pull-request URL;
- the first terminal failure and whether its final remote state was reconciled;
- the precise manual recovery choices: retain, close, or supersede each partial draft.

## Boundaries and unresolved facts

- **Repository ownership boundary:** one fine-grained PAT cannot satisfy a Repository Catalog spanning multiple organizations. Supporting that requires multiple owner-scoped credentials or the deferred GitHub App design; do not fall back to a classic `repo` token because it defeats repository-level least privilege.
- **Workflow edits:** the product specification must say whether `.github/workflows/**` changes are allowed. Allowing them requires **Workflows: write** and may trigger repository automation; disallowing them preserves a narrower token.
- **Rules and signing:** enrollment needs a compatibility check for branch-name restrictions, push rules, required signed commits, and any machine-user bypass. GitHub's rules can change after enrollment, so the push remains the authoritative check.
- **Network policy:** organizations with IP allow lists require stable, allow-listed AWS egress. Whether the chosen Lambda MicroVM networking supplies that is an infrastructure decision, not answered by GitHub's API documentation.
- **Submodules, Git LFS, and Packages:** this research establishes ordinary Git repository access only. A submodule can point outside the Repository Catalog, and fine-grained PATs do not support Packages. The MVP should either reject these dependencies initially or investigate and specify them separately before promising transparent clones.
- **Crash recovery:** the current map says Jobs are automatically retried only before Pi begins. Therefore durable journal data is for observability and same-attempt reconciliation. Resuming publication in a replacement runtime after Pi or the original runtime has ended would be a new lifecycle decision.

## Decision handoff

The downstream workflow decision can safely assume: one organization-scoped machine-user fine-grained PAT; selected Repository Catalog entries; `contents:write` plus `pull_requests:write`; optional `workflows:write`; HTTPS Git plus REST draft-PR creation; one deterministic branch and PR per changed repository; bot-authored commits with explicit Job/IAM provenance; serial, journaled publication; read-after-write idempotency; and failed Jobs that retain and expose any partial drafts.

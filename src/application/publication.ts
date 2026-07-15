import { Effect } from "effect";
import type { PiCompletion } from "../domain/schemas.js";

export interface PublishedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly headBranch: string;
}

export interface PublicationPlanEntry {
  readonly repository: string;
  readonly pullRequest: { readonly title: string; readonly description: string };
}

export interface PublicationPlan {
  readonly version: 1;
  readonly summary: string;
  readonly repositories: ReadonlyArray<PublicationPlanEntry>;
}

export interface ChangeSetOutcome {
  readonly version: 1;
  readonly kind: "change-set";
  readonly summary: string;
  readonly pullRequests: ReadonlyArray<PublishedPullRequest>;
}

export interface PublicationFailureOutcome {
  readonly version: 1;
  readonly kind: "publication-failure";
  readonly code: string;
  readonly message: string;
  readonly retainedBranches: ReadonlyArray<{ readonly repository: string; readonly branch: string }>;
  readonly retainedPullRequests: ReadonlyArray<PublishedPullRequest>;
  readonly failedRepository: string;
  readonly unattemptedRepositories: ReadonlyArray<string>;
}

export interface RepositoryPublicationService {
  readonly publish: (
    entry: PublicationPlanEntry,
    position: number,
    plan: PublicationPlan,
  ) => Effect.Effect<PublishedPullRequest, Error>;
}

export type PublicationResult = ChangeSetOutcome | PublicationFailureOutcome;

export const expectedPublicationBranch = (repository: string) =>
  `fireclanker/${repository.replaceAll(/[^a-z0-9._-]+/gi, "-").toLowerCase()}`;

const changeSet = (
  plan: PublicationPlan,
  pullRequests: ReadonlyArray<PublishedPullRequest>,
): ChangeSetOutcome => ({
  version: 1,
  kind: "change-set",
  summary: plan.summary,
  pullRequests,
});

const publicationFailure = ({
  cause,
  failedRepository,
  plan,
  retainedPullRequests,
}: {
  readonly cause: unknown;
  readonly failedRepository: string;
  readonly plan: PublicationPlan;
  readonly retainedPullRequests: ReadonlyArray<PublishedPullRequest>;
}): PublicationFailureOutcome => ({
  version: 1,
  kind: "publication-failure",
  code: "publication_failed",
  message: cause instanceof Error ? cause.message : "Repository publication failed",
  retainedBranches: retainedPullRequests.map((pullRequest) => ({
    repository: pullRequest.repository,
    branch: pullRequest.headBranch,
  })),
  retainedPullRequests,
  failedRepository,
  unattemptedRepositories: plan.repositories
    .slice(plan.repositories.findIndex((entry) => entry.repository === failedRepository) + 1)
    .map((entry) => entry.repository),
});

export const publishPublicationPlan = (
  plan: PublicationPlan,
  publisher: RepositoryPublicationService,
) => Effect.gen(function* () {
  const retainedPullRequests: PublishedPullRequest[] = [];
  const seen = new Set<string>();

  for (const [position, entry] of Array.from(plan.repositories.entries())) {
    if (seen.has(entry.repository)) {
      return publicationFailure({
        cause: new Error(`Duplicate repository in Publication Plan: ${entry.repository}`),
        failedRepository: entry.repository,
        plan,
        retainedPullRequests,
      });
    }
    seen.add(entry.repository);

    const pullRequest = yield* publisher.publish(entry, position, plan).pipe(
      Effect.catch((cause: unknown) => Effect.succeed(publicationFailure({
        cause,
        failedRepository: entry.repository,
        plan,
        retainedPullRequests,
      }))),
    );
    if (!("repository" in pullRequest)) return pullRequest;
    if (pullRequest.repository !== entry.repository || pullRequest.headBranch !== expectedPublicationBranch(entry.repository)) {
      return publicationFailure({
        cause: new Error(`Unexpected pull request head for ${entry.repository}`),
        failedRepository: entry.repository,
        plan,
        retainedPullRequests,
      });
    }
    retainedPullRequests.push(pullRequest);
  }

  return changeSet(plan, retainedPullRequests);
});

export const completionOutcome = (
  completion: PiCompletion,
  publisher: RepositoryPublicationService,
): Effect.Effect<PublicationResult | Extract<PiCompletion, { readonly kind: "response" }>> =>
  completion.kind === "response" ? Effect.succeed(completion) : publishPublicationPlan(completion.plan, publisher);

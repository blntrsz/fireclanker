import { Schema } from "effect";
import type { PublicationPlanSchema, RepositorySetMember } from "./schemas.js";

export type PublicationPlan = Schema.Schema.Type<typeof PublicationPlanSchema>;
export type PlannedRepository = PublicationPlan["repositories"][number];

export interface TargetPullRequest {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly url: string;
  readonly writable: boolean;
}

export interface RepositoryPublicationState {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly branches: ReadonlySet<string>;
  readonly openPullRequests: ReadonlyArray<TargetPullRequest>;
  readonly nextPullRequestNumber: number;
}

export type PublicationAction = "reused" | "created" | "updated";

export interface PublishedPullRequest {
  readonly repository: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly draft: boolean;
  readonly action: PublicationAction;
}

export interface PublicationDecision {
  readonly branch: string;
  readonly pullRequest: PublishedPullRequest;
  readonly title: string;
  readonly description: string;
}

export class InvalidRepositoryTarget extends Schema.TaggedErrorClass<InvalidRepositoryTarget>()(
  "InvalidRepositoryTarget",
  { repository: Schema.String, message: Schema.String },
) {}

const provenance = (repository: string) =>
  `\n\n---\nPublished by Fireclanker for ${repository}. Review and merge remain human decisions.`;

const withProvenance = (description: string, repository: string) =>
  `${description}${provenance(repository)}`;

const invalidTarget = (repository: string, message: string) =>
  new InvalidRepositoryTarget({ repository, message });

const branchTarget = (
  member: RepositorySetMember,
  planned: PlannedRepository,
  state: RepositoryPublicationState,
): PublicationDecision | InvalidRepositoryTarget => {
  const target = member.target;
  if (target?.kind !== "branch") {
    return invalidTarget(member.repository, "Branch Repository Target is required");
  }
  const branch = target.name;
  if (branch === state.defaultBranch) {
    return invalidTarget(
      member.repository,
      "Branch Repository Target must not be the default branch",
    );
  }
  if (!state.branches.has(branch)) {
    return invalidTarget(member.repository, `Branch Repository Target ${branch} does not exist`);
  }
  const existing = state.openPullRequests.find(
    (pullRequest) =>
      pullRequest.headBranch === branch &&
      pullRequest.baseBranch === state.defaultBranch &&
      pullRequest.state === "open",
  );
  if (existing !== undefined) {
    return {
      branch,
      title: existing.title,
      description: existing.description,
      pullRequest: {
        repository: member.repository,
        number: existing.number,
        title: existing.title,
        url: existing.url,
        draft: existing.draft,
        action: "reused",
      },
    };
  }
  return {
    branch,
    title: planned.pullRequest.title,
    description: withProvenance(planned.pullRequest.description, member.repository),
    pullRequest: {
      repository: member.repository,
      number: state.nextPullRequestNumber,
      title: planned.pullRequest.title,
      url: `https://github.com/${member.repository}/pull/${state.nextPullRequestNumber}`,
      draft: true,
      action: "created",
    },
  };
};

const pullRequestTarget = (
  member: RepositorySetMember,
  planned: PlannedRepository,
  state: RepositoryPublicationState,
): PublicationDecision | InvalidRepositoryTarget => {
  if (member.target?.kind !== "pull-request") return branchTarget(member, planned, state);
  const target = member.target;
  const existing = state.openPullRequests.find(
    (pullRequest) => pullRequest.number === target.number,
  );
  if (existing === undefined || existing.state !== "open") {
    return invalidTarget(
      member.repository,
      `Pull-request Repository Target #${target.number} is not open`,
    );
  }
  if (!existing.writable || existing.headBranch !== target.headBranch) {
    return invalidTarget(
      member.repository,
      `Pull-request Repository Target #${target.number} is not writable`,
    );
  }
  return {
    branch: existing.headBranch,
    title: existing.title,
    description: withProvenance(planned.pullRequest.description, member.repository),
    pullRequest: {
      repository: member.repository,
      number: existing.number,
      title: existing.title,
      url: existing.url,
      draft: existing.draft,
      action: "updated",
    },
  };
};

export const decideRepositoryPublication = (
  member: RepositorySetMember,
  planned: PlannedRepository,
  state: RepositoryPublicationState,
): PublicationDecision | InvalidRepositoryTarget =>
  member.target?.kind === "pull-request"
    ? pullRequestTarget(member, planned, state)
    : branchTarget(member, planned, state);

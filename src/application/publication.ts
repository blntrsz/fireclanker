import { Cause, Effect, Exit, Result, Schema } from "effect";
import {
  ChangeSetOutcomeSchema,
  PublicationFailureSchema,
  PublicationPlanSchema,
  type ChangeSetOutcome,
  type PublicationFailure,
  type PublicationPlan,
  type PullRequest,
  type RepositorySetMember,
} from "../domain/schemas.js";
import { InvalidUsage, ManifestPersistenceError } from "./services.js";

export interface RepositoryPublication {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly pullRequest: PullRequest;
}

export interface PublicationJournalEntry {
  readonly repository: string;
  readonly order: number;
  readonly phase: "planned" | "branch-retained" | "pull-request-retained" | "failed" | "unattempted";
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
  readonly pullRequest?: PullRequest | undefined;
  readonly message?: string | undefined;
}

export interface RepositoryPublisher {
  readonly publish: (
    entry: PublicationPlan["repositories"][number],
    order: number,
  ) => Effect.Effect<RepositoryPublication, ManifestPersistenceError>;
}

export interface PublicationResult {
  readonly outcome?: ChangeSetOutcome | undefined;
  readonly failure?: PublicationFailure | undefined;
  readonly journal: ReadonlyArray<PublicationJournalEntry>;
}

const unique = (values: ReadonlyArray<string>) => new Set(values).size === values.length;

export const validatePublicationPlanOrder = (
  plan: PublicationPlan,
  repositorySet: ReadonlyArray<RepositorySetMember>,
): Effect.Effect<PublicationPlan, InvalidUsage> =>
  Effect.gen(function* () {
    const planned = plan.repositories.map((entry) => entry.repository);
    if (!unique(planned)) {
      return yield* new InvalidUsage({ message: "Publication Plan contains duplicate repositories" });
    }
    const allowed = new Set(repositorySet.map((member) => member.repository));
    const unknown = planned.find((repository) => !allowed.has(repository));
    if (unknown !== undefined) {
      return yield* new InvalidUsage({
        message: `Publication Plan repository ${unknown} is not in the Repository Set`,
      });
    }
    return plan;
  });

export const publishPublicationPlan = (
  rawPlan: PublicationPlan,
  repositorySet: ReadonlyArray<RepositorySetMember>,
  publisher: RepositoryPublisher,
): Effect.Effect<PublicationResult, InvalidUsage> =>
  Effect.gen(function* () {
    const plan = yield* validatePublicationPlanOrder(rawPlan, repositorySet);
    const journal: PublicationJournalEntry[] = plan.repositories.map((entry, order) => ({
      repository: entry.repository,
      order,
      phase: "planned" as const,
    }));
    const retained: RepositoryPublication[] = [];

    for (const [order, entry] of plan.repositories.entries()) {
      const published = yield* Effect.exit(publisher.publish(entry, order));
      if (Exit.isFailure(published)) {
        const error = Result.getOrUndefined(Cause.findError(published.cause)) ?? new ManifestPersistenceError({
          operation: "publish",
          message: "Repository publication failed",
        });
        journal[order] = {
          repository: entry.repository,
          order,
          phase: "failed",
          message: error.message,
        };
        for (const [unattemptedOrder, unattempted] of plan.repositories.slice(order + 1).entries()) {
          journal[order + 1 + unattemptedOrder] = {
            repository: unattempted.repository,
            order: order + 1 + unattemptedOrder,
            phase: "unattempted",
          };
        }
        const failure = PublicationFailureSchema.make({
          version: 1,
          kind: "publication-failure",
          code: "repository_publication_failed",
          message: error.message,
          retainedBranches: retained.map(({ repository, branch, commit }) => ({ repository, branch, commit })),
          pullRequests: retained.map(({ pullRequest }) => pullRequest),
          failedRepository: entry.repository,
          unattemptedRepositories: plan.repositories.slice(order + 1).map(({ repository }) => repository),
        });
        return { failure, journal };
      }
      retained.push(published.value);
      journal[order] = {
        repository: entry.repository,
        order,
        phase: "pull-request-retained",
        branch: published.value.branch,
        commit: published.value.commit,
        pullRequest: published.value.pullRequest,
      };
    }

    const outcome = ChangeSetOutcomeSchema.make({
      version: 1,
      kind: "change-set",
      summary: plan.summary,
      pullRequests: retained.map(({ pullRequest }) => pullRequest),
    });
    return { outcome, journal };
  });

export const decodePublicationPlan = (input: unknown) =>
  Schema.decodeUnknownEffect(PublicationPlanSchema, { onExcessProperty: "error" })(input);

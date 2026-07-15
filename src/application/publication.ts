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
  readonly baseSha?: string | undefined;
  readonly expectedHeadSha?: string | undefined;
  readonly deterministicBranch?: string | undefined;
}

export interface PublicationJournalEntry {
  readonly repository: string;
  readonly order: number;
  readonly phase: "planned" | "rebased" | "branch-retained" | "pull-request-retained" | "reconciled" | "failed" | "unattempted";
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
  readonly baseSha?: string | undefined;
  readonly expectedHeadSha?: string | undefined;
  readonly deterministicBranch?: string | undefined;
  readonly pullRequest?: PullRequest | undefined;
  readonly pullRequestIdentity?: string | undefined;
  readonly message?: string | undefined;
}


export type PublicationWriteResult =
  | { readonly kind: "success"; readonly pullRequest: PullRequest }
  | { readonly kind: "ambiguous"; readonly message: string };

export type PublicationRebaseResult =
  | { readonly kind: "clean"; readonly baseSha: string; readonly expectedHeadSha: string }
  | { readonly kind: "conflict"; readonly baseSha: string; readonly message: string }
  | { readonly kind: "advanced"; readonly baseSha: string; readonly message: string };

export interface PreparedRepositoryPublication {
  readonly repository: string;
  readonly branch: string;
  readonly commit: string;
  readonly baseSha: string;
  readonly expectedHeadSha: string;
  readonly deterministicBranch: string;
}

export interface ReconciledPublication {
  readonly expectedHeadPresent: boolean;
  readonly branchHeadSha?: string | undefined;
  readonly pullRequest?: PullRequest | undefined;
}

export interface SafeRepositoryPublisher {
  readonly rebase: (
    entry: PublicationPlan["repositories"][number],
    order: number,
  ) => Effect.Effect<PublicationRebaseResult, ManifestPersistenceError>;
  readonly resolveConflict: (
    entry: PublicationPlan["repositories"][number],
    order: number,
    conflict: Extract<PublicationRebaseResult, { readonly kind: "conflict" }>,
  ) => Effect.Effect<PublicationRebaseResult, ManifestPersistenceError>;
  readonly write: (
    prepared: PreparedRepositoryPublication,
    entry: PublicationPlan["repositories"][number],
    order: number,
  ) => Effect.Effect<PublicationWriteResult, ManifestPersistenceError>;
  readonly reconcile: (
    prepared: PreparedRepositoryPublication,
    entry: PublicationPlan["repositories"][number],
    order: number,
  ) => Effect.Effect<ReconciledPublication, ManifestPersistenceError>;
}

const pullRequestIdentity = (pullRequest: PullRequest) =>
  `${pullRequest.repository}#${pullRequest.number}`;

const publicationError = (operation: string, message: string) =>
  new ManifestPersistenceError({ operation, message });

export const publishSafeRepository = (
  entry: PublicationPlan["repositories"][number],
  order: number,
  publisher: SafeRepositoryPublisher,
): Effect.Effect<RepositoryPublication, ManifestPersistenceError> =>
  Effect.gen(function* () {
    const initialRebase = yield* publisher.rebase(entry, order);
    const rebase = initialRebase.kind === "conflict"
      ? yield* publisher.resolveConflict(entry, order, initialRebase)
      : initialRebase;

    if (rebase.kind === "conflict") {
      return yield* publicationError("publish.rebase", `Unresolved rebase conflict for ${entry.repository}: ${rebase.message}`);
    }
    if (rebase.kind === "advanced") {
      return yield* publicationError("publish.rebase", `Target advanced concurrently for ${entry.repository}: ${rebase.message}`);
    }

    const prepared: PreparedRepositoryPublication = {
      repository: entry.repository,
      branch: `fireclanker/${entry.repository.replace("/", "-")}/${order + 1}`,
      commit: rebase.expectedHeadSha,
      baseSha: rebase.baseSha,
      expectedHeadSha: rebase.expectedHeadSha,
      deterministicBranch: `fireclanker/${entry.repository.replace("/", "-")}/${order + 1}`,
    };

    const firstWrite = yield* publisher.write(prepared, entry, order);
    if (firstWrite.kind === "success") {
      return { ...prepared, pullRequest: firstWrite.pullRequest };
    }

    const reconciled = yield* publisher.reconcile(prepared, entry, order);
    if (reconciled.expectedHeadPresent && reconciled.pullRequest !== undefined) {
      return { ...prepared, pullRequest: reconciled.pullRequest };
    }
    if (reconciled.branchHeadSha !== undefined && reconciled.branchHeadSha !== prepared.expectedHeadSha) {
      return yield* publicationError(
        "publish.reconcile",
        `Deterministic branch ${prepared.deterministicBranch} already points at ${reconciled.branchHeadSha}`,
      );
    }
    return yield* publicationError(
      "publish.reconcile",
      `Ambiguous publication for ${entry.repository} could not be reconciled: ${firstWrite.message}`,
    );
  });

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
        baseSha: published.value.baseSha,
        expectedHeadSha: published.value.expectedHeadSha,
        deterministicBranch: published.value.deterministicBranch,
        pullRequest: published.value.pullRequest,
        pullRequestIdentity: pullRequestIdentity(published.value.pullRequest),
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

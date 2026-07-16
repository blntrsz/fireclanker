import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  publishPublicationPlan,
  publishSafeRepository,
  type RepositoryPublisher,
  type SafeRepositoryPublisher,
} from "../src/application/publication.js";
import { ManifestPersistenceError } from "../src/application/services.js";
import {
  InvalidRepositoryTarget,
  decideRepositoryPublication,
} from "../src/domain/publication.js";
import type { PublicationPlan, RepositorySetMember } from "../src/domain/schemas.js";

const repositorySet: ReadonlyArray<RepositorySetMember> = [
  { repository: "openai/alpha" },
  { repository: "openai/bravo" },
  { repository: "openai/charlie" },
];

const plan: PublicationPlan = {
  version: 1,
  summary: "Publish coordinated changes",
  repositories: [
    { repository: "openai/alpha", pullRequest: { title: "Alpha", description: "Alpha body" } },
    { repository: "openai/bravo", pullRequest: { title: "Bravo", description: "Bravo body" } },
    { repository: "openai/charlie", pullRequest: { title: "Charlie", description: "Charlie body" } },
  ],
};

const publisher = (failAt?: number): RepositoryPublisher => ({
  publish: (entry, order) =>
    order === failAt
      ? Effect.fail(new ManifestPersistenceError({
          operation: `publish:${entry.repository}`,
          message: `failed at ${entry.repository}`,
        }))
      : Effect.succeed({
          repository: entry.repository,
          branch: `fireclanker/job-000000000001/${order + 1}`,
          commit: `commit-${order + 1}`,
          pullRequest: {
            repository: entry.repository,
            number: order + 1,
            title: entry.pullRequest.title,
            url: `https://github.com/${entry.repository}/pull/${order + 1}`,
            draft: true,
          },
        }),
});

describe("multi-repository Publication Plan publication", () => {
  test("publishes repositories serially in Publication Plan order as one Change Set", async () => {
    const result = await Effect.runPromise(publishPublicationPlan(plan, repositorySet, publisher()));

    expect(result.failure).toBeUndefined();
    expect(result.outcome).toEqual({
      version: 1,
      kind: "change-set",
      summary: "Publish coordinated changes",
      pullRequests: [
        expect.objectContaining({ repository: "openai/alpha", number: 1, draft: true }),
        expect.objectContaining({ repository: "openai/bravo", number: 2, draft: true }),
        expect.objectContaining({ repository: "openai/charlie", number: 3, draft: true }),
      ],
    });
    expect(result.journal.map(({ repository, phase }) => `${repository}:${phase}`)).toEqual([
      "openai/alpha:pull-request-retained",
      "openai/bravo:pull-request-retained",
      "openai/charlie:pull-request-retained",
    ]);
  });

  for (const failAt of [0, 1, 2]) {
    test(`stops at failed serial position ${failAt} and reports retained writes`, async () => {
      const result = await Effect.runPromise(publishPublicationPlan(plan, repositorySet, publisher(failAt)));

      expect(result.outcome).toBeUndefined();
      expect(result.failure).toMatchObject({
        version: 1,
        kind: "publication-failure",
        code: "repository_publication_failed",
        failedRepository: plan.repositories[failAt]?.repository,
        unattemptedRepositories: plan.repositories.slice(failAt + 1).map(({ repository }) => repository),
        retainedBranches: plan.repositories.slice(0, failAt).map(({ repository }, index) => ({
          repository,
          branch: `fireclanker/job-000000000001/${index + 1}`,
          commit: `commit-${index + 1}`,
        })),
        pullRequests: plan.repositories.slice(0, failAt).map(({ repository }, index) => ({
          repository,
          number: index + 1,
        })),
      });
      expect(result.journal.slice(0, failAt).every((entry) => entry.phase === "pull-request-retained")).toBe(true);
      expect(result.journal[failAt]?.phase).toBe("failed");
      expect(result.journal.slice(failAt + 1).every((entry) => entry.phase === "unattempted")).toBe(true);
    });
  }

  test("rejects Publication Plan repositories outside the Repository Set", async () => {
    const failure = await Effect.runPromise(Effect.flip(publishPublicationPlan({
      ...plan,
      repositories: [{ repository: "openai/other", pullRequest: { title: "Other", description: "Other body" } }],
    }, repositorySet, publisher())));

    expect(failure.message).toBe("Publication Plan repository openai/other is not in the Repository Set");
  });

  test("preserves publisher defects instead of reporting them as typed publication failures", async () => {
    const execution = Effect.runPromise(publishPublicationPlan(plan, repositorySet, {
      publish: () => Effect.die(new Error("unexpected publisher defect")),
    }));

    await expect(execution).rejects.toThrow("unexpected publisher defect");
  });
});

const planned = {
  repository: "openai/example",
  pullRequest: { title: "Implement feature", description: "Pi proposal" },
};

const state = {
  repository: "openai/example",
  defaultBranch: "main",
  branches: new Set(["feature", "existing", "pr-head"]),
  nextPullRequestNumber: 12,
  openPullRequests: [
    {
      number: 7,
      title: "Keep my title",
      description: "Keep my description",
      draft: false,
      state: "open" as const,
      headBranch: "existing",
      baseBranch: "main",
      url: "https://github.com/openai/example/pull/7",
      writable: true,
    },
    {
      number: 8,
      title: "Targeted draft",
      description: "Old description",
      draft: true,
      state: "open" as const,
      headBranch: "pr-head",
      baseBranch: "main",
      url: "https://github.com/openai/example/pull/8",
      writable: true,
    },
    {
      number: 9,
      title: "Closed target",
      description: "Closed",
      draft: false,
      state: "closed" as const,
      headBranch: "closed-head",
      baseBranch: "main",
      url: "https://github.com/openai/example/pull/9",
      writable: true,
    },
  ],
};

const member = (target: RepositorySetMember["target"]): RepositorySetMember => ({
  repository: "openai/example",
  ...(target === undefined ? {} : { target }),
});

describe("Repository Target publication decisions", () => {
  test("reuses an existing open pull request for a branch target without metadata changes", () => {
    const decision = decideRepositoryPublication(
      member({ kind: "branch", name: "existing" }),
      planned,
      state,
    );

    expect(decision).not.toBeInstanceOf(InvalidRepositoryTarget);
    expect(decision).toMatchObject({
      branch: "existing",
      title: "Keep my title",
      description: "Keep my description",
      pullRequest: { number: 7, title: "Keep my title", draft: false, action: "reused" },
    });
  });

  test("creates one draft pull request into the default branch for a branch target without an open pull request", () => {
    const decision = decideRepositoryPublication(
      member({ kind: "branch", name: "feature" }),
      planned,
      state,
    );

    expect(decision).not.toBeInstanceOf(InvalidRepositoryTarget);
    expect(decision).toMatchObject({
      branch: "feature",
      title: "Implement feature",
      pullRequest: { number: 12, draft: true, action: "created" },
    });
    expect("description" in decision ? decision.description : "").toContain("Published by Fireclanker");
  });

  test("updates a targeted pull request while preserving title and draft state", () => {
    const decision = decideRepositoryPublication(
      member({ kind: "pull-request", number: 8, headBranch: "pr-head" }),
      planned,
      state,
    );

    expect(decision).not.toBeInstanceOf(InvalidRepositoryTarget);
    expect(decision).toMatchObject({
      branch: "pr-head",
      title: "Targeted draft",
      pullRequest: { number: 8, title: "Targeted draft", draft: true, action: "updated" },
    });
    expect("description" in decision ? decision.description : "").toBe(
      "Pi proposal\n\n---\nPublished by Fireclanker for openai/example. Review and merge remain human decisions.",
    );
  });

  test("rejects closed and otherwise non-writable pull-request targets", () => {
    expect(
      decideRepositoryPublication(
        member({ kind: "pull-request", number: 9, headBranch: "closed-head" }),
        planned,
        state,
      ),
    ).toBeInstanceOf(InvalidRepositoryTarget);
    expect(
      decideRepositoryPublication(
        member({ kind: "pull-request", number: 8, headBranch: "wrong" }),
        planned,
        state,
      ),
    ).toBeInstanceOf(InvalidRepositoryTarget);
  });
});

const safeEntry = plan.repositories[0]!;

const safePublisher = (overrides: Partial<SafeRepositoryPublisher> = {}): SafeRepositoryPublisher => ({
  rebase: () => Effect.succeed({ kind: "clean", baseSha: "base-1", expectedHeadSha: "head-1" }),
  resolveConflict: () => Effect.succeed({ kind: "conflict", baseSha: "base-1", message: "still conflicted" }),
  write: (prepared, entry) => Effect.succeed({
    kind: "success",
    pullRequest: {
      repository: entry.repository,
      number: 101,
      title: entry.pullRequest.title,
      url: `https://github.com/${entry.repository}/pull/101`,
      draft: true,
      action: "created",
    },
  }),
  reconcile: () => Effect.succeed({ expectedHeadPresent: false }),
  ...overrides,
});

describe("safe repository publication", () => {
  test("rebases onto the latest target before writing deterministic branch and pull request identity", async () => {
    const observed: string[] = [];
    const result = await Effect.runPromise(publishSafeRepository(safeEntry, 0, safePublisher({
      rebase: () => {
        observed.push("rebase");
        return Effect.succeed({ kind: "clean", baseSha: "base-latest", expectedHeadSha: "head-after-rebase" });
      },
      write: (prepared, entry) => {
        observed.push(`write:${prepared.baseSha}:${prepared.expectedHeadSha}:${prepared.deterministicBranch}`);
        return Effect.succeed({
          kind: "success",
          pullRequest: {
            repository: entry.repository,
            number: 7,
            title: entry.pullRequest.title,
            url: `https://github.com/${entry.repository}/pull/7`,
            draft: true,
            action: "created",
          },
        });
      },
    })));

    expect(observed).toEqual([
      "rebase",
      "write:base-latest:head-after-rebase:fireclanker/openai-alpha/1",
    ]);
    expect(result).toMatchObject({
      repository: "openai/alpha",
      branch: "fireclanker/openai-alpha/1",
      commit: "head-after-rebase",
      baseSha: "base-latest",
      expectedHeadSha: "head-after-rebase",
      deterministicBranch: "fireclanker/openai-alpha/1",
      pullRequest: { repository: "openai/alpha", number: 7, draft: true, action: "created" },
    });
  });

  test("uses the same workspace conflict-resolution pass once before writing", async () => {
    const observed: string[] = [];
    const result = await Effect.runPromise(publishSafeRepository(safeEntry, 0, safePublisher({
      rebase: () => {
        observed.push("rebase-conflict");
        return Effect.succeed({ kind: "conflict", baseSha: "base-2", message: "conflict" });
      },
      resolveConflict: () => {
        observed.push("resolve-in-same-session");
        return Effect.succeed({ kind: "clean", baseSha: "base-2", expectedHeadSha: "head-resolved" });
      },
      write: (prepared, entry) => {
        observed.push(`write:${prepared.expectedHeadSha}`);
        return Effect.succeed({
          kind: "success",
          pullRequest: {
            repository: entry.repository,
            number: 8,
            title: entry.pullRequest.title,
            url: `https://github.com/${entry.repository}/pull/8`,
            draft: true,
          },
        });
      },
    })));

    expect(observed).toEqual(["rebase-conflict", "resolve-in-same-session", "write:head-resolved"]);
    expect(result.commit).toBe("head-resolved");
  });

  test("fails unresolved conflicts and second target advances without writing", async () => {
    let writes = 0;
    const unresolved = await Effect.runPromise(Effect.flip(publishSafeRepository(safeEntry, 0, safePublisher({
      rebase: () => Effect.succeed({ kind: "conflict", baseSha: "base-3", message: "conflict" }),
      resolveConflict: () => Effect.succeed({ kind: "conflict", baseSha: "base-3", message: "still conflicted" }),
      write: () => {
        writes += 1;
        return Effect.fail(new ManifestPersistenceError({ operation: "write", message: "should not write" }));
      },
    }))));
    const advanced = await Effect.runPromise(Effect.flip(publishSafeRepository(safeEntry, 0, safePublisher({
      rebase: () => Effect.succeed({ kind: "advanced", baseSha: "base-4", message: "moved again" }),
      write: () => {
        writes += 1;
        return Effect.fail(new ManifestPersistenceError({ operation: "write", message: "should not write" }));
      },
    }))));

    expect(unresolved.message).toContain("Unresolved rebase conflict");
    expect(advanced.message).toContain("Target advanced concurrently");
    expect(writes).toBe(0);
  });

  test("reconciles ambiguous write success without creating duplicate pull requests", async () => {
    let writes = 0;
    const result = await Effect.runPromise(publishSafeRepository(safeEntry, 0, safePublisher({
      write: () => {
        writes += 1;
        return Effect.succeed({ kind: "ambiguous", message: "timeout after GitHub write" });
      },
      reconcile: (prepared, entry) => Effect.succeed({
        expectedHeadPresent: true,
        branchHeadSha: prepared.expectedHeadSha,
        pullRequest: {
          repository: entry.repository,
          number: 9,
          title: entry.pullRequest.title,
          url: `https://github.com/${entry.repository}/pull/9`,
          draft: true,
          action: "created",
        },
      }),
    })));

    expect(writes).toBe(1);
    expect(result.pullRequest).toMatchObject({ number: 9, draft: true, action: "created" });
  });

  test("rejects ambiguous conflicting deterministic branches instead of overwriting them", async () => {
    const failure = await Effect.runPromise(Effect.flip(publishSafeRepository(safeEntry, 0, safePublisher({
      write: () => Effect.succeed({ kind: "ambiguous", message: "network reset" }),
      reconcile: () => Effect.succeed({ expectedHeadPresent: false, branchHeadSha: "someone-elses-head" }),
    }))));

    expect(failure.message).toContain("already points at someone-elses-head");
  });

  test("records base SHA, expected head SHA, deterministic branch, and pull-request identity in multi-repository journals", async () => {
    const result = await Effect.runPromise(publishPublicationPlan(plan, repositorySet, {
      publish: (entry, order) => Effect.succeed({
        repository: entry.repository,
        branch: `fireclanker/${order}`,
        commit: `head-${order}`,
        baseSha: `base-${order}`,
        expectedHeadSha: `head-${order}`,
        deterministicBranch: `fireclanker/${order}`,
        pullRequest: {
          repository: entry.repository,
          number: order + 1,
          title: entry.pullRequest.title,
          url: `https://github.com/${entry.repository}/pull/${order + 1}`,
          draft: order !== 1,
          action: order === 1 ? "updated" : "created",
        },
      }),
    }));

    expect(result.journal.map(({ repository, order, baseSha, expectedHeadSha, deterministicBranch, pullRequestIdentity, pullRequest }) => ({
      repository,
      order,
      baseSha,
      expectedHeadSha,
      deterministicBranch,
      pullRequestIdentity,
      draft: pullRequest?.draft,
      action: pullRequest?.action,
    }))).toEqual([
      { repository: "openai/alpha", order: 0, baseSha: "base-0", expectedHeadSha: "head-0", deterministicBranch: "fireclanker/0", pullRequestIdentity: "openai/alpha#1", draft: true, action: "created" },
      { repository: "openai/bravo", order: 1, baseSha: "base-1", expectedHeadSha: "head-1", deterministicBranch: "fireclanker/1", pullRequestIdentity: "openai/bravo#2", draft: false, action: "updated" },
      { repository: "openai/charlie", order: 2, baseSha: "base-2", expectedHeadSha: "head-2", deterministicBranch: "fireclanker/2", pullRequestIdentity: "openai/charlie#3", draft: true, action: "created" },
    ]);
  });
});

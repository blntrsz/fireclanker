import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  expectedPublicationBranch,
  publishPublicationPlan,
  type PublicationPlan,
  type RepositoryPublicationService,
} from "../src/application/publication.js";

const plan = (repositories: ReadonlyArray<string>): PublicationPlan => ({
  version: 1,
  summary: "Publish coordinated change",
  repositories: repositories.map((repository) => ({
    repository,
    pullRequest: {
      title: `Update ${repository}`,
      description: `Structured entry for ${repository}`,
    },
  })),
});

const recordingPublisher = (failAt: number | undefined, writes: string[]): RepositoryPublicationService => ({
  publish: (entry, position) => position === failAt
    ? Effect.fail(new Error(`failed ${entry.repository}`))
    : Effect.sync(() => {
    writes.push(entry.repository);
    return {
      repository: entry.repository,
      number: position + 1,
      title: entry.pullRequest.title,
      url: `https://github.com/${entry.repository}/pull/${position + 1}`,
      draft: false,
      headBranch: expectedPublicationBranch(entry.repository),
    };
  }),
});

describe("Publication Plan coordination", () => {
  test("publishes repositories serially in plan order as one Change Set", async () => {
    const writes: string[] = [];
    const publicationPlan = plan(["acme/api", "acme/web", "acme/docs"]);

    const result = await Effect.runPromise(publishPublicationPlan(
      publicationPlan,
      recordingPublisher(undefined, writes),
    ));

    expect(writes).toEqual(["acme/api", "acme/web", "acme/docs"]);
    expect(result).toMatchObject({
      version: 1,
      kind: "change-set",
      summary: publicationPlan.summary,
      pullRequests: [
        { repository: "acme/api", number: 1, headBranch: "fireclanker/acme-api" },
        { repository: "acme/web", number: 2, headBranch: "fireclanker/acme-web" },
        { repository: "acme/docs", number: 3, headBranch: "fireclanker/acme-docs" },
      ],
    });
  });

  test.each([0, 1, 2])("stops on failure at serial position %p and exposes retained remote writes", async (failAt) => {
    const writes: string[] = [];
    const repositories = ["acme/api", "acme/web", "acme/docs"];

    const result = await Effect.runPromise(publishPublicationPlan(
      plan(repositories),
      recordingPublisher(failAt, writes),
    ));

    expect(result.kind).toBe("publication-failure");
    if (result.kind !== "publication-failure") return;
    expect(writes).toEqual(repositories.slice(0, failAt));
    expect(result.failedRepository).toBe(repositories[failAt] ?? "");
    expect(result.unattemptedRepositories).toEqual(repositories.slice(failAt + 1));
    expect(result.retainedPullRequests.map((pullRequest) => pullRequest.repository)).toEqual(repositories.slice(0, failAt));
    expect(result.retainedBranches.map((branch) => branch.repository)).toEqual(repositories.slice(0, failAt));
  });
});

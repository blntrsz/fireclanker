import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflict,
  InMemoryManifestStore,
  makeJobController,
} from "../src/application/job-controller.js";

const submission = {
  version: 1 as const,
  operation: "run" as const,
  jobId: "job-000000000001",
  instruction: "Explain durable acceptance",
  repositorySet: [],
};

describe("Control Job operations", () => {
  test("concurrent identical submissions durably create one queued Job", async () => {
    const store = new InMemoryManifestStore();
    const controller = makeJobController({
      store,
      now: () => "2000-01-01T00:00:00.000Z",
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });

    const [first, second] = await Promise.all([
      controller.handle(submission),
      controller.handle(submission),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      version: 1,
      jobId: submission.jobId,
      status: "queued",
      submission: {
        instruction: submission.instruction,
        repositorySet: [],
      },
      audit: {
        submittedAt: "2000-01-01T00:00:00.000Z",
        submittedBy: "arn:aws:iam::123456789012:user/tester",
      },
      runtime: { writerGeneration: 0 },
      transcript: { highestCursor: null },
      artifacts: {},
    });
    expect(store.size).toBe(1);
  });

  test("reusing a Job ID with different canonical content is a stable conflict", async () => {
    const controller = makeJobController({
      store: new InMemoryManifestStore(),
      now: () => "2000-01-01T00:00:00.000Z",
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });
    await controller.handle(submission);

    await expect(
      controller.handle({ ...submission, instruction: "Different content" }),
    ).rejects.toBeInstanceOf(IdempotencyConflict);
  });

  test("cancelling queued commits one immutable terminal transition and is idempotent", async () => {
    const store = new InMemoryManifestStore();
    const timestamps = ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:01.000Z"];
    const controller = makeJobController({
      store,
      now: () => timestamps.shift()!,
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });
    await controller.handle(submission);

    const cancelled = await controller.handle({
      version: 1,
      operation: "cancel",
      jobId: submission.jobId,
    });
    const repeated = await controller.handle({
      version: 1,
      operation: "cancel",
      jobId: submission.jobId,
    });

    expect(repeated).toEqual(cancelled);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      transitions: [
        { status: "queued", timestamp: "2000-01-01T00:00:00.000Z" },
        { status: "cancelled", timestamp: "2000-01-01T00:00:01.000Z" },
      ],
      failure: { code: "cancelled", message: "Job cancelled by user" },
    });
  });

  test("concurrent duplicate cancellation converges on the cancelled Job", async () => {
    const controller = makeJobController({
      store: new InMemoryManifestStore(),
      now: () => "2000-01-01T00:00:00.000Z",
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });
    await controller.handle(submission);
    const cancel = { version: 1 as const, operation: "cancel" as const, jobId: submission.jobId };

    const [first, second] = await Promise.all([
      controller.handle(cancel),
      controller.handle(cancel),
    ]);

    expect(first.status).toBe("cancelled");
    expect(second).toEqual(first);
    expect(first.transitions.filter(({ status }) => status === "cancelled")).toHaveLength(1);
  });

  test("competing terminal writes use ETags so the first terminal status wins", async () => {
    const controller = makeJobController({
      store: new InMemoryManifestStore(),
      now: () => "2000-01-01T00:00:00.000Z",
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });
    await controller.handle(submission);

    const writes = await Promise.allSettled([
      controller.handle({
        version: 1,
        operation: "settle",
        jobId: submission.jobId,
        status: "succeeded",
        outcome: { version: 1, kind: "response", response: "Done" },
      }),
      controller.handle({
        version: 1,
        operation: "settle",
        jobId: submission.jobId,
        status: "failed",
        failure: { code: "runner_failed", message: "Runner failed" },
      }),
    ]);
    const snapshot = await controller.handle({
      version: 1,
      operation: "get",
      jobId: submission.jobId,
    });

    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    expect(["succeeded", "failed"]).toContain(snapshot.status);
    expect(snapshot.transitions.at(-1)?.status).toBe(snapshot.status);
  });

  test("list returns newest Jobs first with status filtering and opaque pagination", async () => {
    let second = 0;
    const controller = makeJobController({
      store: new InMemoryManifestStore(),
      now: () => `2000-01-01T00:00:${String(second++).padStart(2, "0")}.000Z`,
      submittedBy: () => "arn:aws:iam::123456789012:user/tester",
      wakeLaunch: async () => {},
    });
    for (const suffix of ["001", "002", "003"]) {
      await controller.handle({
        ...submission,
        jobId: `job-000000000${suffix}`,
        instruction: `Job ${suffix}`,
      });
    }
    await controller.handle({ version: 1, operation: "cancel", jobId: "job-000000000002" });

    const first = await controller.handle({ version: 1, operation: "list", limit: 2 });
    const secondPage = await controller.handle({
      version: 1,
      operation: "list",
      limit: 2,
      cursor: first.nextCursor!,
    });
    const cancelled = await controller.handle({
      version: 1,
      operation: "list",
      status: "cancelled",
      limit: 20,
    });

    expect(first.jobs.map((job) => job.jobId)).toEqual([
      "job-000000000003",
      "job-000000000002",
    ]);
    expect(first.nextCursor).toMatch(/^cursor-/);
    expect(secondPage.jobs.map((job) => job.jobId)).toEqual(["job-000000000001"]);
    expect(secondPage.nextCursor).toBeUndefined();
    expect(cancelled.jobs.map((job) => job.jobId)).toEqual(["job-000000000002"]);
  });
});

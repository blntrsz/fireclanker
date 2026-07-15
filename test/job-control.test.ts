import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
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

const dependencies = (store = new InMemoryManifestStore(), now = Effect.succeed("2000-01-01T00:00:00.000Z")) => ({
  store,
  now,
  submittedBy: Effect.succeed("arn:aws:iam::123456789012:user/tester"),
  wakeLaunch: () => Effect.void,
});

const manifestEffect = (controller: ReturnType<typeof makeJobController>, operation: Parameters<ReturnType<typeof makeJobController>["handle"]>[0]) =>
  controller.handle(operation).pipe(
    Effect.flatMap((result) => "jobs" in result ? Effect.die("Expected a Job Manifest") : Effect.succeed(result)),
  );

const listEffect = (controller: ReturnType<typeof makeJobController>, operation: Parameters<ReturnType<typeof makeJobController>["handle"]>[0]) =>
  controller.handle(operation).pipe(
    Effect.flatMap((result) => "jobs" in result ? Effect.succeed(result) : Effect.die("Expected a Job list")),
  );

describe("Control Job operations", () => {
  test("concurrent identical submissions durably create one queued Job", async () => {
    const store = new InMemoryManifestStore();
    const controller = makeJobController(dependencies(store));

    const [first, second] = await Effect.runPromise(Effect.all([
      manifestEffect(controller, submission),
      manifestEffect(controller, submission),
    ], { concurrency: "unbounded" }));

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
    const controller = makeJobController(dependencies());
    await Effect.runPromise(manifestEffect(controller, submission));

    const failure = await Effect.runPromise(Effect.flip(manifestEffect(controller, { ...submission, instruction: "Different content" })));
    expect(failure).toBeInstanceOf(IdempotencyConflict);
  });

  test("cancelling queued commits one immutable terminal transition and is idempotent", async () => {
    const store = new InMemoryManifestStore();
    const timestamps = ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:01.000Z"];
    const controller = makeJobController(dependencies(
      store,
      Effect.sync(() => timestamps.shift() ?? "2000-01-01T00:00:01.000Z"),
    ));
    await Effect.runPromise(manifestEffect(controller, submission));

    const cancelled = await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "cancel",
      jobId: submission.jobId,
    }));
    const repeated = await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "cancel",
      jobId: submission.jobId,
    }));

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
    const controller = makeJobController(dependencies());
    await Effect.runPromise(manifestEffect(controller, submission));
    const cancel = { version: 1 as const, operation: "cancel" as const, jobId: submission.jobId };

    const [first, second] = await Effect.runPromise(Effect.all([
      manifestEffect(controller, cancel),
      manifestEffect(controller, cancel),
    ], { concurrency: "unbounded" }));

    expect(first.status).toBe("cancelled");
    expect(second).toEqual(first);
    expect(first.transitions.filter(({ status }) => status === "cancelled")).toHaveLength(1);
  });


  test("starting a queued Job conditionally commits running runtime identity", async () => {
    const timestamps = [
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:01.000Z",
    ];
    const controller = makeJobController(dependencies(
      new InMemoryManifestStore(),
      Effect.sync(() => timestamps.shift() ?? "2000-01-01T00:00:01.000Z"),
    ));
    await Effect.runPromise(manifestEffect(controller, submission));

    const running = await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "start",
      jobId: submission.jobId,
      microvmId: "fireclanker-runtime-001",
      writerGeneration: 1,
    }));

    expect(running).toMatchObject({
      status: "running",
      transitions: [
        { status: "queued", timestamp: "2000-01-01T00:00:00.000Z" },
        { status: "running", timestamp: "2000-01-01T00:00:01.000Z" },
      ],
      runtime: { writerGeneration: 1, microvmId: "fireclanker-runtime-001" },
    });
  });

  test("cancellation winning the launch race remains cancelled", async () => {
    const controller = makeJobController(dependencies());
    await Effect.runPromise(manifestEffect(controller, submission));
    await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "cancel",
      jobId: submission.jobId,
    }));

    const afterLaunch = await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "start",
      jobId: submission.jobId,
      microvmId: "fireclanker-runtime-001",
      writerGeneration: 1,
    }));

    expect(afterLaunch.status).toBe("cancelled");
    expect(afterLaunch.runtime).toEqual({ writerGeneration: 0 });
    expect(afterLaunch.transitions.map(({ status }) => status)).toEqual(["queued", "cancelled"]);
  });

  test("competing terminal writes use ETags so the first terminal status wins", async () => {
    const controller = makeJobController(dependencies());
    await Effect.runPromise(manifestEffect(controller, submission));

    const writes = await Effect.runPromise(Effect.all([
      Effect.exit(manifestEffect(controller, {
        version: 1,
        operation: "settle",
        jobId: submission.jobId,
        status: "succeeded",
        outcome: { version: 1, kind: "response", response: "Done" },
      })),
      Effect.exit(manifestEffect(controller, {
        version: 1,
        operation: "settle",
        jobId: submission.jobId,
        status: "failed",
        failure: { code: "runner_failed", message: "Runner failed" },
      })),
    ], { concurrency: "unbounded" }));
    const snapshot = await Effect.runPromise(manifestEffect(controller, {
      version: 1,
      operation: "get",
      jobId: submission.jobId,
    }));

    expect(writes.filter((write) => write._tag === "Success")).toHaveLength(1);
    expect(["succeeded", "failed"]).toContain(snapshot.status);
    expect(snapshot.transitions.at(-1)?.status).toBe(snapshot.status);
  });

  test("list returns newest Jobs first with status filtering and opaque pagination", async () => {
    let second = 0;
    const controller = makeJobController(dependencies(new InMemoryManifestStore(), Effect.sync(() => `2000-01-01T00:00:${String(second++).padStart(2, "0")}.000Z`)));
    for (const suffix of ["001", "002", "003"]) {
      await Effect.runPromise(manifestEffect(controller, {
        ...submission,
        jobId: `job-000000000${suffix}`,
        instruction: `Job ${suffix}`,
      }));
    }
    await Effect.runPromise(manifestEffect(controller, { version: 1, operation: "cancel", jobId: "job-000000000002" }));

    const first = await Effect.runPromise(listEffect(controller, { version: 1, operation: "list", limit: 2 }));
    const secondPage = await Effect.runPromise(listEffect(controller, {
      version: 1,
      operation: "list",
      limit: 2,
      cursor: first.nextCursor ?? "missing",
    }));
    const cancelled = await Effect.runPromise(listEffect(controller, {
      version: 1,
      operation: "list",
      status: "cancelled",
      limit: 20,
    }));

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

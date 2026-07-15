import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const executable = join(root, "dist", "fireclanker-test");
const productionExecutable = join(root, "dist", "fireclanker");
let stateDirectory: string;

const invoke = (
  arguments_: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
) =>
  Bun.spawnSync([executable, ...arguments_], {
    cwd: root,
    env: {
      ...process.env,
      FIRECLANKER_TEST_STATE_DIRECTORY: stateDirectory,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

const invokeDeployment = (
  arguments_: ReadonlyArray<string>,
  cwd: string,
  home: string,
  stdin?: string,
) =>
  Bun.spawnSync([executable, ...arguments_], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      FIRECLANKER_TEST_STATE_DIRECTORY: stateDirectory,
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });

const configuration = (name: string, overrides: Record<string, unknown> = {}) => ({
  version: 1,
  name,
  region: "us-east-1",
  model: "gpt-5.5",
  repositoryCatalog: ["openai/example"],
  retentionDays: 30,
  ...overrides,
});

const invokeProduction = (arguments_: ReadonlyArray<string>) =>
  Bun.spawnSync([productionExecutable, ...arguments_], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

beforeAll(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), "fireclanker-acceptance-"));
  const build = Bun.spawnSync(["bun", "run", "build:test"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const productionBuild = Bun.spawnSync(["bun", "run", "build:production"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(productionBuild.exitCode, productionBuild.stderr.toString()).toBe(0);
});

afterAll(async () => {
  await rm(stateDirectory, { recursive: true, force: true });
});

describe("compiled deterministic CLI", () => {
  test("advertises the flat command surface and global options", () => {
    const result = invoke(["--help"]);
    const output = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(output).toContain("--json");
    expect(output).toContain("--config");
    for (const command of ["run", "get", "list", "cancel", "deploy", "destroy"]) {
      expect(output).toMatch(new RegExp(`\\b${command}\\b`));
    }
  });

  test("run durably accepts a Response Job", () => {
    const result = invoke(["run", "Explain deterministic systems"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toMatch(
      /^Job job-[a-f0-9]{12} queued\nResume with: fireclanker get job-[a-f0-9]{12} --watch\n$/,
    );
  });

  test("run generates a fresh Job ID client-side for each submission", () => {
    const first = invoke(["run", "Same canonical submission"]);
    const second = invoke(["run", "Same canonical submission"]);
    const firstJobId = first.stdout.toString().match(/job-[a-f0-9]{12}/)?.[0];
    const secondJobId = second.stdout.toString().match(/job-[a-f0-9]{12}/)?.[0];

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(firstJobId).toBeDefined();
    expect(secondJobId).toBeDefined();
    expect(secondJobId).not.toBe(firstJobId);
  });

  test("get and get --watch expose a succeeded Response Job", () => {
    const submitted = invoke(["run", "Describe a tracer bullet"]);
    const jobId = submitted.stdout.toString().match(/job-[a-f0-9]{12}/)?.[0];
    expect(jobId).toBeDefined();

    const snapshot = invoke(["get", jobId!]);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stderr.toString()).toBe("");
    expect(snapshot.stdout.toString()).toBe(
      `Job ${jobId}\nStatus: succeeded\nResponse: Deterministic response to: Describe a tracer bullet\n`,
    );

    const watched = invoke(["get", jobId!, "--watch"]);
    expect(watched.exitCode).toBe(0);
    expect(watched.stderr.toString()).toBe("");
    expect(watched.stdout.toString()).toBe(
      [
        `[2000-01-01T00:00:00.000Z] Job ${jobId} queued`,
        `[2000-01-01T00:00:01.000Z] Job ${jobId} running`,
        "[2000-01-01T00:00:02.000Z] Response: Deterministic response to: Describe a tracer bullet",
        `[2000-01-01T00:00:03.000Z] Job ${jobId} succeeded`,
        "",
      ].join("\n"),
    );
  });

  test("JSON mode emits one compact versioned event per line", () => {
    const submitted = invoke(["--json", "run", "Explain NDJSON"]);
    expect(submitted.exitCode).toBe(0);
    expect(submitted.stderr.toString()).toBe("");
    const accepted = JSON.parse(submitted.stdout.toString());
    expect(accepted).toEqual({
      version: 1,
      event: "job-accepted",
      jobId: expect.stringMatching(/^job-[a-f0-9]{12}$/),
      status: "queued",
    });

    const watched = invoke(["--json", "get", accepted.jobId, "--watch"]);
    expect(watched.exitCode).toBe(0);
    expect(watched.stderr.toString()).toBe("");
    const lines = watched.stdout.toString().trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual([
      "job-status",
      "job-status",
      "outcome",
      "job-status",
    ]);
    expect(lines.every((line) => JSON.parse(line).version === 1)).toBe(true);
  });

  test("invalid usage has stable human and JSON conventions", () => {
    const human = invoke(["run"]);
    expect(human.exitCode).toBe(2);
    expect(human.stderr.toString()).toContain("Missing required argument: instruction");

    const json = invoke(["--json", "run"]);
    expect(json.exitCode).toBe(2);
    expect(json.stdout.toString()).toBe("");
    expect(json.stderr.toString()).toBe(
      '{"version":1,"event":"error","code":"invalid_usage","message":"Missing required argument: instruction"}\n',
    );

    const missingJobId = invoke(["--json", "get"]);
    expect(missingJobId.exitCode).toBe(2);
    expect(missingJobId.stdout.toString()).toBe("");
    expect(JSON.parse(missingJobId.stderr.toString())).toEqual({
      version: 1,
      event: "error",
      code: "invalid_usage",
      message: "Missing required argument: job-id",
    });

    const malformedJobId = invoke(["--json", "get", "nope"]);
    expect(malformedJobId.exitCode).toBe(2);
    expect(malformedJobId.stdout.toString()).toBe("");
    expect(JSON.parse(malformedJobId.stderr.toString())).toEqual({
      version: 1,
      event: "error",
      code: "invalid_usage",
      message: "Invalid Job ID: nope",
    });
  });

  test("the production executable requires Deployment configuration before invocation", () => {
    const result = invokeProduction(["--json", "run", "Do production work"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toMatchObject({
      version: 1,
      event: "error",
      code: "invalid_configuration",
    });
  });

  test("an unknown Job has a stable structured client error", () => {
    const result = invoke(["--json", "get", "job-000000000000"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toEqual({
      version: 1,
      event: "error",
      code: "job_not_found",
      message: "Job job-000000000000 not found",
    });
  });

  test("run accepts exactly one positional or file instruction source", async () => {
    const instructionPath = join(stateDirectory, "instruction.txt");
    await Bun.write(instructionPath, "Explain instruction files");

    const fromFile = invoke(["run", "--file", instructionPath]);
    expect(fromFile.exitCode).toBe(0);
    const jobId = fromFile.stdout.toString().match(/job-[a-f0-9]{12}/)?.[0];
    expect(jobId).toBeDefined();
    expect(invoke(["get", jobId!]).stdout.toString()).toContain(
      "Response: Deterministic response to: Explain instruction files",
    );

    const multiple = invoke(["--json", "run", "Inline", "--file", instructionPath]);
    expect(multiple.exitCode).toBe(2);
    expect(JSON.parse(multiple.stderr.toString())).toEqual({
      version: 1,
      event: "error",
      code: "invalid_usage",
      message: "Use exactly one instruction source: positional text or --file",
    });
  });

  test("list paginates newest first and cancel is queued-only and idempotent", () => {
    const submitted = ["Oldest", "Middle", "Newest"].map((instruction) => {
      const result = invoke(["--json", "run", instruction]);
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString()) as { jobId: string };
    });

    const first = invoke(["--json", "list", "--limit", "2"]);
    expect(first.exitCode, first.stderr.toString()).toBe(0);
    const firstPage = JSON.parse(first.stdout.toString());
    expect(firstPage.event).toBe("job-list");
    expect(firstPage.jobs.map((job: { jobId: string }) => job.jobId)).toEqual([
      submitted[2]!.jobId,
      submitted[1]!.jobId,
    ]);
    expect(firstPage.nextCursor).toMatch(/^cursor-/);

    const next = invoke(["--json", "list", "--limit", "2", "--cursor", firstPage.nextCursor]);
    expect(next.exitCode, next.stderr.toString()).toBe(0);
    expect(JSON.parse(next.stdout.toString()).jobs[0].jobId).toBe(submitted[0]!.jobId);

    const human = invoke(["list", "--status", "succeeded", "--limit", "1"]);
    expect(human.exitCode).toBe(0);
    expect(human.stdout.toString()).toContain(submitted[2]!.jobId);
    expect(human.stdout.toString()).toMatch(
      /Continue with: fireclanker list --status succeeded --limit 1 --cursor cursor-/,
    );

    const queued = invoke(
      ["--json", "run", "Cancel this queued Job"],
      { FIRECLANKER_TEST_EXECUTION_DISABLED: "1" },
    );
    const queuedJobId = JSON.parse(queued.stdout.toString()).jobId as string;
    for (let attempt = 0; attempt < 2; attempt++) {
      const cancelled = invoke(["--json", "cancel", queuedJobId]);
      expect(cancelled.exitCode, cancelled.stderr.toString()).toBe(0);
      expect(JSON.parse(cancelled.stdout.toString())).toEqual({
        version: 1,
        event: "job-cancelled",
        jobId: queuedJobId,
        status: "cancelled",
      });
    }

    const terminal = invoke(["--json", "cancel", submitted[0]!.jobId]);
    expect(terminal.exitCode).toBe(1);
    expect(JSON.parse(terminal.stderr.toString()).code).toBe("job_not_cancellable");
  });

  test("get returns terminal failure data without transcript replay", () => {
    const submitted = invoke(
      ["--json", "run", "Inspect cancellation snapshot"],
      { FIRECLANKER_TEST_EXECUTION_DISABLED: "1" },
    );
    const jobId = JSON.parse(submitted.stdout.toString()).jobId as string;
    expect(invoke(["cancel", jobId]).exitCode).toBe(0);

    const snapshot = invoke(["--json", "get", jobId]);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stderr.toString()).toBe("");
    expect(JSON.parse(snapshot.stdout.toString())).toMatchObject({
      version: 1,
      event: "job-status",
      jobId,
      status: "cancelled",
      failure: { code: "cancelled", message: "Job cancelled by user" },
    });
  });

  test("deploy discovers and strictly validates configuration before AWS activity", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "fireclanker-config-cwd-"));
    const home = await mkdtemp(join(tmpdir(), "fireclanker-config-home-"));
    const explicit = join(cwd, "explicit.json");
    const userConfiguration = join(home, ".config", "fireclanker", "fireclanker.json");
    await mkdir(join(home, ".config", "fireclanker"), { recursive: true });
    await Bun.write(explicit, JSON.stringify(configuration("explicit")));
    await Bun.write(join(cwd, "fireclanker.json"), JSON.stringify(configuration("working")));
    await Bun.write(userConfiguration, JSON.stringify(configuration("user")));

    const fromExplicit = invokeDeployment(
      ["--json", "--config", explicit, "deploy"],
      cwd,
      home,
    );
    expect(fromExplicit.exitCode).toBe(2);
    expect(JSON.parse(fromExplicit.stderr.toString())).toMatchObject({
      code: "confirmation_required",
      message: expect.stringContaining("explicit"),
    });

    const fromWorkingDirectory = invokeDeployment(["--json", "deploy"], cwd, home);
    expect(fromWorkingDirectory.exitCode).toBe(2);
    expect(JSON.parse(fromWorkingDirectory.stderr.toString())).toMatchObject({
      code: "confirmation_required",
      message: expect.stringContaining("working"),
    });

    await rm(join(cwd, "fireclanker.json"));
    const fromUserConfiguration = invokeDeployment(["--json", "deploy"], cwd, home);
    expect(fromUserConfiguration.exitCode).toBe(2);
    expect(JSON.parse(fromUserConfiguration.stderr.toString())).toMatchObject({
      code: "confirmation_required",
      message: expect.stringContaining("user"),
    });

    await Bun.write(
      explicit,
      JSON.stringify(configuration("invalid", { unexpected: "rejected" })),
    );
    const invalid = invokeDeployment(
      ["--json", "--config", explicit, "deploy", "--yes"],
      cwd,
      home,
      "secret-that-must-not-be-read",
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.stdout.toString()).toBe("");
    expect(JSON.parse(invalid.stderr.toString())).toMatchObject({ code: "invalid_configuration" });

    for (const invalidFields of [
      { region: "eu-central-1" },
      { model: "unmapped-model" },
      { retentionDays: 0 },
      { repositoryCatalog: ["openai/example", "effect-ts/example"] },
      { repositoryCatalog: ["openai/example", "OPENAI/EXAMPLE"] },
    ]) {
      await Bun.write(explicit, JSON.stringify(configuration("invalid", invalidFields)));
      const rejected = invokeDeployment(
        ["--json", "--config", explicit, "deploy", "--yes"],
        cwd,
        home,
      );
      expect(rejected.exitCode).toBe(2);
      expect(JSON.parse(rejected.stderr.toString())).toMatchObject({
        code: "invalid_configuration",
      });
    }
  }, 15_000);

  test("deploy converges portably, preserves or rotates the PAT, and destroys only the name", async () => {
    const firstMachine = await mkdtemp(join(tmpdir(), "fireclanker-first-machine-"));
    const secondMachine = await mkdtemp(join(tmpdir(), "fireclanker-second-machine-"));
    const home = await mkdtemp(join(tmpdir(), "fireclanker-deployment-home-"));
    const name = `portable-${Date.now().toString(36)}`;
    const token = "github_pat_must_never_appear";
    await Bun.write(join(firstMachine, "fireclanker.json"), JSON.stringify(configuration(name)));
    await Bun.write(join(secondMachine, "fireclanker.json"), JSON.stringify(configuration(name)));

    const created = invokeDeployment(
      ["--json", "deploy", "--yes", "--github-token-stdin"],
      firstMachine,
      home,
      `${token}\n`,
    );
    expect(created.exitCode, created.stderr.toString()).toBe(0);
    expect(created.stderr.toString()).toBe("");
    const createPlan = JSON.parse(created.stdout.toString());
    expect(createPlan).toMatchObject({
      event: "deployment-plan",
      action: "create",
      deployment: { accountId: "123456789012", region: "us-east-1", name },
      statePrefix: `deployments/${name}/`,
      alchemyRevision: "c999680eedb38aa1e311c65d8dd9ef67c785b9b8",
    });
    expect(created.stdout.toString()).not.toContain(token);

    const convergedElsewhere = invokeDeployment(
      ["--json", "deploy", "--yes"],
      secondMachine,
      home,
    );
    expect(convergedElsewhere.exitCode, convergedElsewhere.stderr.toString()).toBe(0);
    expect(JSON.parse(convergedElsewhere.stdout.toString())).toMatchObject({ action: "no-op" });

    const rotatedToken = "github_pat_rotated_must_never_appear";
    const rotated = invokeDeployment(
      ["--json", "deploy", "--yes", "--github-token-stdin"],
      secondMachine,
      home,
      `${rotatedToken}\n`,
    );
    expect(rotated.exitCode, rotated.stderr.toString()).toBe(0);
    expect(JSON.parse(rotated.stdout.toString())).toMatchObject({ action: "update" });
    expect(rotated.stdout.toString()).not.toContain(rotatedToken);

    const destroyed = invokeDeployment(["destroy", "--yes"], secondMachine, home);
    expect(destroyed.exitCode, destroyed.stderr.toString()).toBe(0);
    expect(destroyed.stdout.toString()).toContain(`Destroyed Deployment ${name}`);
    expect(destroyed.stdout.toString()).toContain("Preserve shared bootstrap bucket");

    const needsTokenAgain = invokeDeployment(["--json", "deploy", "--yes"], firstMachine, home);
    expect(needsTokenAgain.exitCode).toBe(2);
    expect(JSON.parse(needsTokenAgain.stderr.toString())).toMatchObject({
      code: "github_token_required",
      message: expect.stringContaining("GitHub token"),
    });

    const persistedState = await Bun.file(join(stateDirectory, "deployments.json")).text();
    expect(persistedState).not.toContain(token);
    expect(persistedState).not.toContain(rotatedToken);
  });
});

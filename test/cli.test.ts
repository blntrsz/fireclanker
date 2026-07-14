import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const executable = join(root, "dist", "fireclanker-test");
const productionExecutable = join(root, "dist", "fireclanker");
let stateDirectory: string;

const invoke = (arguments_: ReadonlyArray<string>) =>
  Bun.spawnSync([executable, ...arguments_], {
    cwd: root,
    env: {
      ...process.env,
      FIRECLANKER_TEST_STATE_DIRECTORY: stateDirectory,
    },
    stdout: "pipe",
    stderr: "pipe",
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

  test("the production executable never falls back to deterministic fixtures", () => {
    const result = invokeProduction(["--json", "run", "Do production work"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(JSON.parse(result.stderr.toString())).toEqual({
      version: 1,
      event: "error",
      code: "deployment_unavailable",
      message: "Deployment unavailable: no production Deployment adapter is configured",
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
});

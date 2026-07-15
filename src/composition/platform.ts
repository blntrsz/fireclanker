import { join, resolve } from "node:path";
import { Config, Effect, Layer, Option, Schema } from "effect";
import {
  ConfigurationSource,
  FileSystemProcess,
  GitHubTokenRequired,
  InstructionReadFailure,
  InvalidConfiguration,
  TerminalInteraction,
} from "../application/services.js";
import { supportedRegions, type DeploymentConfiguration } from "../domain/deployment.js";

export const PlatformFileSystemProcess = Layer.succeed(
  FileSystemProcess,
  FileSystemProcess.of({
    readInstruction: Effect.fn("FileSystemProcess.readInstruction")((path: string) =>
      Effect.tryPromise({
        try: () => (path === "-" ? Bun.stdin.text() : Bun.file(path).text()),
        catch: () =>
          new InstructionReadFailure({
            path,
            message: `Unable to read instruction from ${path}`,
          }),
      })),
  }),
);

const ConfigurationDocumentSchema = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.String.check(
    Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/),
    Schema.isMinLength(1),
  ),
  region: Schema.Literals(supportedRegions),
  model: Schema.Literals(["gpt-5.5", "claude-sonnet-5", "claude-opus-4.8"]),
  repositoryCatalog: Schema.Array(
    Schema.String.check(
      Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\/[a-z0-9._-]+$/i),
    ),
  ),
  retentionDays: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
});

const decodeConfiguration = Schema.decodeUnknownSync(ConfigurationDocumentSchema, {
  onExcessProperty: "error",
});

const configurationPath = async (explicitPath: string | undefined, home: string | undefined) => {
  if (explicitPath !== undefined) return resolve(explicitPath);
  const working = join(process.cwd(), "fireclanker.json");
  if (await Bun.file(working).exists()) return working;
  return join(home ?? "", ".config", "fireclanker", "fireclanker.json");
};

const validateCatalog = (configuration: typeof ConfigurationDocumentSchema.Type) => {
  const canonical = configuration.repositoryCatalog.map((repository) => repository.toLowerCase());
  if (new Set(canonical).size !== canonical.length) {
    throw new Error("repositoryCatalog must contain unique canonical repositories");
  }
  const organizations = new Set(canonical.map((repository) => repository.split("/", 1)[0]));
  if (organizations.size > 1) {
    throw new Error("repositoryCatalog must contain repositories from one GitHub organization");
  }
  return canonical;
};

export const PlatformConfigurationSource = Layer.succeed(
  ConfigurationSource,
  ConfigurationSource.of({
    load: Effect.fn("ConfigurationSource.load")(function* (explicitPath: string | undefined) {
      const home = yield* Config.option(Config.string("HOME")).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((error) => new InvalidConfiguration({ message: error.message })),
      );
      return yield* Effect.tryPromise({
        try: async (): Promise<DeploymentConfiguration> => {
          const path = await configurationPath(explicitPath, home);
          const file = Bun.file(path);
          if (!(await file.exists())) throw new Error(`Configuration not found at ${path}`);
          const decoded = decodeConfiguration(await file.json());
          return {
            ...decoded,
            repositoryCatalog: validateCatalog(decoded),
            retentionDays: decoded.retentionDays ?? 30,
          };
        },
        catch: (error) =>
          new InvalidConfiguration({
            message: error instanceof Error ? error.message : "Invalid Deployment configuration",
          }),
      });
    }),
  }),
);

const readHiddenLine = Effect.fn("TerminalInteraction.readSecret")((message: string) =>
  Effect.callback<string, GitHubTokenRequired>((resume) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      resume(
        Effect.fail(
          new GitHubTokenRequired({
            message: "GitHub token required; pass --github-token-stdin",
          }),
        ),
      );
      return;
    }
    process.stderr.write(message);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      process.stderr.write("\n");
      const token = value.trim();
      resume(
        token.length > 0
          ? Effect.succeed(token)
          : Effect.fail(new GitHubTokenRequired({ message: "GitHub token cannot be empty" })),
      );
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u0003") return finish();
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    process.stdin.on("data", onData);
  }));

export const PlatformTerminalInteraction = Layer.succeed(
  TerminalInteraction,
  TerminalInteraction.of({
    isInteractive: Effect.sync(() => Boolean(process.stdin.isTTY && process.stdout.isTTY)),
    confirm: Effect.fn("TerminalInteraction.confirm")((message: string) =>
      Effect.sync(() => {
        const answer = globalThis.prompt(`${message} [y/N]`);
        return answer?.trim().toLowerCase() === "y" || answer?.trim().toLowerCase() === "yes";
      })),
    readSecret: readHiddenLine,
  }),
);

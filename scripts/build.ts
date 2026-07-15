import { existsSync } from "node:fs";
import { resolve } from "node:path";

const composition = process.argv[2];
if (composition !== "production" && composition !== "test") {
  throw new Error("usage: bun run scripts/build.ts <production|test>");
}

const root = resolve(import.meta.dir, "..");
const alchemySource = resolve(root, ".agents", "alchemy-effect", "packages", "alchemy", "src");
const expectedAlchemyRevision = "c999680eedb38aa1e311c65d8dd9ef67c785b9b8";
const alchemyCheckout = resolve(alchemySource, "..", "..", "..");
const revision = Bun.spawnSync(["git", "-C", alchemyCheckout, "rev-parse", "HEAD"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (revision.exitCode !== 0 || revision.stdout.toString().trim() !== expectedAlchemyRevision) {
  throw new Error(
    `Alchemy source must be initialized at ${expectedAlchemyRevision}; run git submodule update --init`,
  );
}
const exactAlchemyModule = (specifier: string) => {
  if (specifier === "alchemy") return resolve(alchemySource, "index.ts");
  const relative = specifier.slice("alchemy/".length);
  const candidates = [
    resolve(alchemySource, `${relative}.ts`),
    resolve(alchemySource, relative, "index.ts"),
  ];
  const resolved = candidates.find(existsSync);
  if (resolved === undefined) throw new Error(`Unable to resolve exact Alchemy module ${specifier}`);
  return resolved;
};

const rolldownNativePackages: Record<string, string> = {
  "darwin-arm64": "@rolldown/binding-darwin-arm64",
  "darwin-x64": "@rolldown/binding-darwin-x64",
  "linux-arm64": "@rolldown/binding-linux-arm64-gnu",
  "linux-x64": "@rolldown/binding-linux-x64-gnu",
  "win32-arm64": "@rolldown/binding-win32-arm64-msvc",
  "win32-x64": "@rolldown/binding-win32-x64-msvc",
};
const rolldownNativePackage = rolldownNativePackages[`${process.platform}-${process.arch}`];
if (rolldownNativePackage === undefined) {
  throw new Error(`Unsupported build platform ${process.platform}-${process.arch}`);
}
const rolldownNativePath = Bun.resolveSync(rolldownNativePackage, root);
const rolldownNativeVersion = (
  await Bun.file(Bun.resolveSync(`${rolldownNativePackage}/package.json`, root)).json()
).version as string;

const result = await Bun.build({
  entrypoints: [resolve(root, "src", "main.ts")],
  target: "bun",
  minify: composition === "production",
  define: {
    FIRECLANKER_COMPOSITION: JSON.stringify(composition),
  },
  plugins: [
    {
      name: "exact-alchemy-source-revision",
      setup(builder) {
        builder.onLoad(
          { filter: /rolldown\/dist\/shared\/binding-.*\.mjs$/ },
          async (args) => {
            const source = await Bun.file(args.path).text();
            return {
              // Rolldown's generated dynamic require is opaque to Bun's
              // compiler. Make the selected native addon a direct import so
              // the executable embeds it, while preserving Rolldown itself.
              contents:
                `import embeddedRolldownBinding from ${JSON.stringify(rolldownNativePath)};\n` +
                source
                  .replaceAll(
                    `__require(${JSON.stringify(rolldownNativePackage)})`,
                    "embeddedRolldownBinding",
                  )
                  .replaceAll(
                    `__require(${JSON.stringify(`${rolldownNativePackage}/package.json`)}).version`,
                    JSON.stringify(rolldownNativeVersion),
                  ),
              loader: "js",
            };
          },
        );
        builder.onResolve({ filter: /^alchemy(?:\/.*)?$/ }, (args) => ({
          path: exactAlchemyModule(args.path),
        }));
      },
    },
  ],
  compile: {
    outfile: resolve(root, "dist", composition === "production" ? "fireclanker" : "fireclanker-test"),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

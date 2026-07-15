import { resolve } from "node:path";

const composition = process.argv[2];
if (composition !== "production" && composition !== "test") {
  throw new Error("usage: bun run scripts/build.ts <production|test>");
}

const root = resolve(import.meta.dir, "..");
const controlHandlerBuild = await Bun.build({
  entrypoints: [resolve(root, "src", "control", "handler.ts")],
  target: "node",
  format: "esm",
  minify: true,
});
if (!controlHandlerBuild.success || controlHandlerBuild.outputs[0] === undefined) {
  for (const log of controlHandlerBuild.logs) console.error(log);
  throw new Error("Unable to build the embedded Control Lambda handler");
}
const controlHandler = await controlHandlerBuild.outputs[0].text();

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
    FIRECLANKER_CONTROL_HANDLER: JSON.stringify(controlHandler),
  },
  plugins: [
    {
      name: "embed-rolldown-native-binding",
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

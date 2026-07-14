import { Effect, Layer } from "effect";
import { FileSystemProcess, InstructionReadFailure } from "../application/services.js";

export const PlatformFileSystemProcess = Layer.effect(
  FileSystemProcess,
  Effect.succeed({
    readInstruction: (path: string) =>
      Effect.tryPromise({
        try: () => (path === "-" ? Bun.stdin.text() : Bun.file(path).text()),
        catch: () =>
          new InstructionReadFailure({
            path,
            message: `Unable to read instruction from ${path}`,
          }),
      }),
  }),
);

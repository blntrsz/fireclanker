import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Effect, Schema } from "effect";
import type { ManifestStoreService, StoredManifest } from "../application/job-controller.js";
import { ManifestPersistenceError } from "../application/services.js";
import { JobManifestSchema, type JobManifest } from "../domain/schemas.js";

const metadataStatus = (error: unknown): number | undefined => {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
};

const errorName = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name
    : undefined;

const persistenceError = (operation: string, cause: unknown) =>
  new ManifestPersistenceError({
    operation,
    message: cause instanceof Error ? cause.message : `S3 ${operation} failed`,
  });

const manifestKey = (manifest: JobManifest) => {
  const submittedSecond = Number.parseInt(manifest.jobId.slice(4, 12), 16);
  const date = new Date(submittedSecond * 1_000).toISOString().slice(0, 10).replaceAll("-", "/");
  return `jobs/${date}/${manifest.jobId}/manifest.json`;
};

export class S3ManifestStore implements ManifestStoreService {
  readonly #client: S3Client;
  readonly #keys = new Map<string, string>();

  constructor(
    readonly bucket: string,
    configuration: S3ClientConfig = {},
  ) {
    this.#client = new S3Client(configuration);
  }

  readonly #allKeys = Effect.fn("ManifestStore.S3.allKeys")(() =>
    Effect.tryPromise({
      try: async () => {
        const keys: string[] = [];
        let continuationToken: string | undefined;
        do {
          const page = await this.#client.send(
            new ListObjectsV2Command({
              Bucket: this.bucket,
              Prefix: "jobs/",
              ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
            }),
          );
          for (const object of page.Contents ?? []) {
            if (object.Key?.endsWith("/manifest.json")) keys.push(object.Key);
          }
          continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (continuationToken !== undefined);
        return keys;
      },
      catch: (cause) => persistenceError("list", cause),
    }),
  );

  readonly #readKey = Effect.fn("ManifestStore.S3.readKey")(function* (
    this: S3ManifestStore,
    key: string,
  ) {
    const object = yield* Effect.tryPromise({
      try: () => this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key })),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        metadataStatus(cause) === 404
          ? Effect.succeed(undefined)
          : Effect.fail(persistenceError("read", cause)),
      ),
    );
    if (object === undefined) return undefined;
    const body = yield* Effect.tryPromise({
      try: () => object.Body?.transformToString() ?? Promise.resolve(undefined),
      catch: (cause) => persistenceError("read-body", cause),
    });
    if (body === undefined || object.ETag === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(body),
      catch: (cause) => persistenceError("parse", cause),
    });
    const manifest = yield* Schema.decodeUnknownEffect(JobManifestSchema, {
      onExcessProperty: "error",
    })(parsed).pipe(Effect.mapError((cause) => persistenceError("decode", cause)));
    this.#keys.set(manifest.jobId, key);
    return { manifest, etag: object.ETag } satisfies StoredManifest;
  });

  readonly create = Effect.fn("ManifestStore.S3.create")((manifest: JobManifest) => {
    const key = manifestKey(manifest);
    return Effect.tryPromise({
      try: () =>
        this.#client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(manifest),
            ContentType: "application/json",
            IfNoneMatch: "*",
          }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((result) => {
        this.#keys.set(manifest.jobId, key);
        return { manifest, etag: result.ETag ?? '"created"' } satisfies StoredManifest;
      }),
      Effect.catch((cause) =>
        metadataStatus(cause) === 412 || errorName(cause) === "PreconditionFailed"
          ? Effect.succeed(undefined)
          : Effect.fail(persistenceError("create", cause)),
      ),
    );
  });

  readonly read = Effect.fn("ManifestStore.S3.read")(function* (
    this: S3ManifestStore,
    jobId: string,
  ) {
    const cached = this.#keys.get(jobId);
    if (cached !== undefined) return yield* this.#readKey(cached);
    const key = (yield* this.#allKeys()).find((candidate) =>
      candidate.endsWith(`/${jobId}/manifest.json`),
    );
    return key === undefined ? undefined : yield* this.#readKey(key);
  });

  readonly replace = Effect.fn("ManifestStore.S3.replace")(function* (
    this: S3ManifestStore,
    jobId: string,
    expectedEtag: string,
    manifest: JobManifest,
  ) {
    const existing = yield* this.read(jobId);
    if (existing === undefined) return undefined;
    const key = this.#keys.get(jobId);
    if (key === undefined) return yield* Effect.fail(persistenceError("replace", "Missing key"));
    return yield* Effect.tryPromise({
      try: () =>
        this.#client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: JSON.stringify(manifest),
            ContentType: "application/json",
            IfMatch: expectedEtag,
          }),
        ),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((result) => ({ manifest, etag: result.ETag ?? expectedEtag })),
      Effect.catch((cause) =>
        metadataStatus(cause) === 412 || errorName(cause) === "PreconditionFailed"
          ? Effect.succeed(undefined)
          : Effect.fail(persistenceError("replace", cause)),
      ),
    );
  });

  readonly list = Effect.fn("ManifestStore.S3.list")(function* (this: S3ManifestStore) {
    const manifests = yield* Effect.forEach(yield* this.#allKeys(), (key) => this.#readKey(key), {
      concurrency: "unbounded",
    });
    return manifests.filter((manifest): manifest is StoredManifest => manifest !== undefined);
  });
}

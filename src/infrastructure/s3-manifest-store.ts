import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { Schema } from "effect";
import type {
  ManifestStore,
  StoredManifest,
} from "../application/job-controller.js";
import { JobManifestSchema, type JobManifest } from "../domain/schemas.js";

const decodeManifest = Schema.decodeUnknownSync(JobManifestSchema, { onExcessProperty: "error" });

const isPreconditionFailure = (error: unknown) =>
  (error as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata
    ?.httpStatusCode === 412 || (error as { readonly name?: string }).name === "PreconditionFailed";

const manifestKey = (manifest: JobManifest) => {
  const submittedSecond = Number.parseInt(manifest.jobId.slice(4, 12), 16);
  const date = new Date(submittedSecond * 1_000).toISOString().slice(0, 10).replaceAll("-", "/");
  return `jobs/${date}/${manifest.jobId}/manifest.json`;
};

export class S3ManifestStore implements ManifestStore {
  readonly #client: S3Client;
  readonly #keys = new Map<string, string>();

  constructor(
    readonly bucket: string,
    configuration: S3ClientConfig = {},
  ) {
    this.#client = new S3Client(configuration);
  }

  async #allKeys() {
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
  }

  async #readKey(key: string): Promise<StoredManifest | undefined> {
    try {
      const object = await this.#client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await object.Body?.transformToString();
      if (body === undefined || object.ETag === undefined) return undefined;
      const manifest = decodeManifest(JSON.parse(body)) as JobManifest;
      this.#keys.set(manifest.jobId, key);
      return { manifest, etag: object.ETag };
    } catch (error) {
      if ((error as { readonly $metadata?: { readonly httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async create(manifest: JobManifest) {
    const key = manifestKey(manifest);
    try {
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(manifest),
          ContentType: "application/json",
          IfNoneMatch: "*",
        }),
      );
      this.#keys.set(manifest.jobId, key);
      return { manifest, etag: result.ETag ?? '"created"' };
    } catch (error) {
      if (isPreconditionFailure(error)) return undefined;
      throw error;
    }
  }

  async read(jobId: string) {
    const cached = this.#keys.get(jobId);
    if (cached !== undefined) return this.#readKey(cached);
    const key = (await this.#allKeys()).find((candidate) =>
      candidate.endsWith(`/${jobId}/manifest.json`),
    );
    return key === undefined ? undefined : this.#readKey(key);
  }

  async replace(jobId: string, expectedEtag: string, manifest: JobManifest) {
    const existing = await this.read(jobId);
    if (existing === undefined) return undefined;
    const key = this.#keys.get(jobId)!;
    try {
      const result = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(manifest),
          ContentType: "application/json",
          IfMatch: expectedEtag,
        }),
      );
      return { manifest, etag: result.ETag ?? expectedEtag };
    } catch (error) {
      if (isPreconditionFailure(error)) return undefined;
      throw error;
    }
  }

  async list() {
    const manifests = await Promise.all((await this.#allKeys()).map((key) => this.#readKey(key)));
    return manifests.filter((manifest): manifest is StoredManifest => manifest !== undefined);
  }
}

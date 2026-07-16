import { createHash } from "node:crypto";

export const REDACTED_SECRET = "[REDACTED:fireclanker-secret]" as const;

export interface SecretRedactionBoundary {
  readonly redactText: (input: string) => string;
  readonly longestRegisteredFormLength: number;
  readonly redactValue: <A>(value: A) => A;
  readonly isRegisteredSecretPresent: (input: string) => boolean;
  readonly registeredFingerprints: ReadonlyArray<string>;
}

const minimumSecretLength = 4;

const fingerprint = (secret: string) =>
  createHash("sha256").update(secret).digest("hex").slice(0, 16);

const basicAuthForms = (secret: string) => [
  `x-access-token:${secret}`,
  `oauth2:${secret}`,
  `git:${secret}`,
  `:${secret}`,
];

const githubUrlForms = (secret: string) => [
  `https://${secret}@github.com`,
  `https://x-access-token:${secret}@github.com`,
  `https://oauth2:${secret}@github.com`,
];

const derivedForms = (secret: string): ReadonlyArray<string> => [
  secret,
  encodeURIComponent(secret),
  Buffer.from(secret).toString("base64"),
  ...basicAuthForms(secret),
  ...basicAuthForms(secret).map((value) => Buffer.from(value).toString("base64")),
  ...githubUrlForms(secret),
];

export const knownSecretValuesFromEnvironment = (environment: NodeJS.ProcessEnv = process.env) =>
  [
    environment.GITHUB_TOKEN,
    environment.GH_TOKEN,
    environment.FIRECLANKER_GITHUB_TOKEN,
    environment.AWS_ACCESS_KEY_ID,
    environment.AWS_SECRET_ACCESS_KEY,
    environment.AWS_SESSION_TOKEN,
  ].filter((value): value is string => value !== undefined && value.length >= minimumSecretLength);

export const makeSecretRedactionBoundary = (
  secrets: ReadonlyArray<string>,
): SecretRedactionBoundary => {
  const registered = [...new Set(secrets.filter((secret) => secret.length >= minimumSecretLength))];
  const forms = [...new Set(registered.flatMap(derivedForms))]
    .filter((secret) => secret.length >= minimumSecretLength)
    .sort((left, right) => right.length - left.length);

  const redactText = (input: string) =>
    forms.reduce((text, secret) => text.split(secret).join(REDACTED_SECRET), input);

  const redactValue = <A>(value: A): A => {
    if (typeof value === "string") return redactText(value) as A;
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry)) as A;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [key, redactValue(entry)]),
      ) as A;
    }
    return value;
  };

  return {
    redactText,
    longestRegisteredFormLength: forms[0]?.length ?? 0,
    redactValue,
    isRegisteredSecretPresent: (input) => redactText(input) !== input,
    registeredFingerprints: registered.map(fingerprint),
  };
};

export const environmentSecretRedactionBoundary = () =>
  makeSecretRedactionBoundary(knownSecretValuesFromEnvironment());

export class StreamingSecretRedactor {
  readonly #boundary: SecretRedactionBoundary;
  readonly #lookbehind: number;
  #pending = "";

  constructor(boundary: SecretRedactionBoundary) {
    this.#boundary = boundary;
    this.#lookbehind = Math.max(0, boundary.longestRegisteredFormLength - 1);
  }

  push(chunk: string): string {
    const combined = this.#pending + chunk;
    if (combined.length <= this.#lookbehind) {
      this.#pending = combined;
      return "";
    }
    const emit = combined.slice(0, combined.length - this.#lookbehind);
    this.#pending = combined.slice(combined.length - this.#lookbehind);
    return this.#boundary.redactText(emit);
  }

  end(): string {
    const final = this.#boundary.redactText(this.#pending);
    this.#pending = "";
    return final;
  }
}

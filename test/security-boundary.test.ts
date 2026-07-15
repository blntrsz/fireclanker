import { describe, expect, test } from "bun:test";
import { makeSecretRedactionBoundary, REDACTED_SECRET, StreamingSecretRedactor } from "../src/application/redaction.js";
import { controlPolicyDocument, runnerPolicyDocument } from "../src/infrastructure/alchemy-core.js";

const githubToken = "ghp_known_token_1234567890";
const accessKey = "AKIAKNOWNACCESS";
const secretKey = "known/aws/secret+key";
const sessionToken = "known-session-token";
const boundary = makeSecretRedactionBoundary([githubToken, accessKey, secretKey, sessionToken]);

const assertClean = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const secret of [githubToken, accessKey, secretKey, sessionToken]) {
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).not.toContain(Buffer.from(secret).toString("base64"));
  }
};

describe("known-secret redaction boundary", () => {
  test("redacts exact, URL, and Basic-auth forms from nested output values", () => {
    const value = boundary.redactValue({
      manifest: { instruction: `use ${githubToken} and ${accessKey}` },
      outcome: { response: `clone https://x-access-token:${githubToken}@github.com/acme/repo` },
      failure: { message: `Authorization: Basic ${Buffer.from(`x-access-token:${githubToken}`).toString("base64")}` },
      transcript: [`aws=${secretKey}`, `session=${encodeURIComponent(sessionToken)}`],
      pullRequestMetadata: { body: `token ${githubToken}` },
    });

    assertClean(value);
    expect(JSON.stringify(value)).toContain(REDACTED_SECRET);
  });

  test("redacts registered values spanning streamed chunk boundaries", () => {
    const redactor = new StreamingSecretRedactor(boundary);
    const rendered = [
      redactor.push("before ghp_known"),
      redactor.push("_token_1234567890 after"),
      redactor.end(),
    ].join("");

    expect(rendered).toBe(`before ${REDACTED_SECRET} after`);
  });

  test("does not claim coverage for unknown repository secrets or arbitrary transformations", () => {
    const unknownSecret = "repo-secret-not-registered";
    const transformed = githubToken.split("").reverse().join("");

    expect(boundary.redactText(unknownSecret)).toBe(unknownSecret);
    expect(boundary.redactText(transformed)).toBe(transformed);
  });

});

describe("least-privilege IAM policies", () => {
  const identity = { accountId: "123456789012", region: "us-east-1" as const, name: "prod" };
  const controlPolicy = controlPolicyDocument(identity);
  const runnerPolicy = runnerPolicyDocument(identity);

  test("Control role is scoped to Deployment data, runner pass-role, live self invocation, and MicroVM lifecycle", () => {
    const serialized = JSON.stringify(controlPolicy);

    expect(serialized).toContain("arn:aws:s3:::fireclanker-123456789012-us-east-1-prod-data/jobs/*");
    expect(serialized).toContain("arn:aws:iam::123456789012:role/fireclanker-prod-runner");
    expect(serialized).toContain("arn:aws:lambda:us-east-1:123456789012:function:fireclanker-prod-control:live");
    expect(serialized).not.toContain("arn:aws:iam::123456789012:role/*");
    expect(serialized).not.toContain("secretsmanager:GetSecretValue");
    expect(serialized).not.toContain("iam:CreateRole");
  });

  test("runner role cannot mutate IAM, manage MicroVMs, administer buckets, mutate secrets, or invoke unrelated Lambdas", () => {
    const serialized = JSON.stringify(runnerPolicy);

    expect(serialized).toContain("secretsmanager:GetSecretValue");
    expect(serialized).toContain("arn:aws:s3:::fireclanker-123456789012-us-east-1-prod-data/jobs/*");
    expect(serialized).toContain("arn:aws:lambda:us-east-1:123456789012:function:fireclanker-prod-control:live");
    expect(serialized).not.toMatch(/iam:/);
    expect(serialized).not.toContain("lambda:RunMicrovm");
    expect(serialized).not.toContain("s3:CreateBucket");
    expect(serialized).not.toContain("s3:DeleteBucket");
    expect(serialized).not.toContain("secretsmanager:PutSecretValue");
    expect(serialized).not.toContain("function:*");
  });
});

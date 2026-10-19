import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyRun, verifyReceipt, version, packages } from "./ultramodern-solid2-release.mjs";

import { verifySourceExclusion } from "./ultramodern-solid2-policy.mjs";

const source = "a".repeat(40);
test("missing settings credential stops before any release API request", () => {
  const script = new URL("./ultramodern-solid2-release.mjs", import.meta.url);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `globalThis.fetch = async () => {
        console.error("UNEXPECTED_RELEASE_REQUEST");
        throw new Error("Release API must not be called without verification credentials");
      };
      process.argv[1] = ${JSON.stringify(fileURLToPath(script))};
      process.argv[2] = "123";
      await import(${JSON.stringify(script.href)});`
    ],
    {
      encoding: "utf8",
      env: {
        GITHUB_REPOSITORY: "BleedingDev/solid",
        GITHUB_REF: "refs/heads/solid2-rc15",
        GITHUB_SHA: source,
        GH_TOKEN: "guard-test-token"
      }
    }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SOLID2_RELEASE_SETTINGS_TOKEN is required/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_RELEASE_REQUEST/);
  assert.equal(result.stdout, "");
});
const run = {
  id: 123,
  run_attempt: 2,
  repository: { full_name: "BleedingDev/solid" },
  head_repository: { full_name: "BleedingDev/solid" },
  path: ".github/workflows/ultramodern-solid2-source.yml",
  event: "push",
  head_branch: "solid2-rc15",
  head_sha: source,
  status: "completed",
  conclusion: "success"
};
const archives = Object.fromEntries(packages.map(name => [name, Buffer.from(`accepted ${name}`)]));
const receipt = {
  schema: 1,
  repository: "BleedingDev/solid",
  source,
  runId: "123",
  runAttempt: "2",
  signals: version,
  compiler: version,
  compilerSource: "4937f0a2bfddd45a65738c189075aff577530073",
  compilerBinary: {
    package: "@solidjs/compiler-linux-x64-gnu",
    version,
    integrity: `sha512-${createHash("sha512").update("official native bytes").digest("base64")}`
  },
  packages: Object.fromEntries(
    packages.map(name => [
      name,
      {
        version,
        archive: `${name === "solid-js" ? "solid-js" : "solidjs-web"}-${source.slice(0, 12)}.tgz`,
        integrity: `sha512-${createHash("sha512").update(archives[name]).digest("base64")}`
      }
    ])
  )
};
test("accepts both exact archives from the successful current merged-source attempt", () => {
  verifyRun(run, source);
  verifyReceipt(receipt, run, archives);
});
test("rejects unmerged, legacy Solid1, foreign, failed and stale source runs", () => {
  for (const change of [
    { event: "pull_request" },
    { repository: { full_name: "solidjs/solid" } },
    { head_repository: { full_name: "solidjs/solid" } },
    { head_branch: "main" },
    { conclusion: "failure" },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
    { path: ".github/workflows/release.yml" }
  ]) {
    assert.throws(() => verifyRun({ ...run, ...change }, source));
  }
});
test("rejects mixed attempts, changed dependencies, changed bytes and incomplete cohorts", () => {
  for (const change of [
    { runId: "124" },
    { runAttempt: "1" },
    { source: "b".repeat(40) },
    { repository: "solidjs/solid" },
    { signals: "1.9.17" },
    { compiler: "2.0.0-rc.13" },
    { compilerSource: "b".repeat(40) },
    { compilerBinary: { ...receipt.compilerBinary, version: "2.0.0-rc.13" } },
    { compilerBinary: { ...receipt.compilerBinary, package: "@solidjs/compiler-darwin-arm64" } },
    { compilerBinary: { ...receipt.compilerBinary, integrity: "unchecked" } }
  ]) {
    assert.throws(() => verifyReceipt({ ...receipt, ...change }, run, archives));
  }
  for (const name of packages) {
    assert.throws(() =>
      verifyReceipt(receipt, run, { ...archives, [name]: Buffer.from("replacement") })
    );
    const altered = structuredClone(receipt);
    altered.packages[name].archive = "other.tgz";
    assert.throws(() => verifyReceipt(altered, run, archives));
    altered.packages[name] = { ...receipt.packages[name], version: "1.9.17" };
    assert.throws(() => verifyReceipt(altered, run, archives));
    delete altered.packages[name];
    assert.throws(() => verifyReceipt(altered, run, archives));
  }
});

test("the sole existing source exclusion must independently mature with no added waiver", () => {
  const workspace =
    "minimumReleaseAgeExclude:\n  - '@solidjs/vite-plugin'\n\noverrides:\n  solid-js: workspace:*\n";
  const manifest = { devDependencies: { "@solidjs/vite-plugin": "3.0.0-next.35" } };
  const metadata = { time: { "3.0.0-next.35": "2026-08-28T22:11:18.842Z" } };
  const deadline = Date.parse(metadata.time["3.0.0-next.35"]) + 1440 * 60_000;
  assert.equal(
    verifySourceExclusion(workspace, manifest, metadata, deadline).matureAt,
    "2026-08-29T22:11:18.842Z"
  );
  assert.throws(() => verifySourceExclusion(workspace, manifest, metadata, deadline - 1));
  assert.throws(() =>
    verifySourceExclusion(
      workspace.replace("\n\noverrides", "\n  - '*'\n\noverrides"),
      manifest,
      metadata,
      deadline
    )
  );
  assert.throws(() => verifySourceExclusion(workspace, manifest, {}, deadline));
  assert.throws(() =>
    verifySourceExclusion(
      workspace,
      { devDependencies: { "@solidjs/vite-plugin": "latest" } },
      metadata,
      deadline
    )
  );
});

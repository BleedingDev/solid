import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  publishSourcePackage,
  validateReleaseArchive,
  validateReleaseRun
} from "./publish-source-package.mjs";

const repository = "BleedingDev/solid";
const sha = "a".repeat(40);
const tag = `ultramodern-solid-${sha.slice(0, 12)}`;
const run = {
  id: 42,
  repository: { full_name: repository },
  head_repository: { full_name: repository },
  path: ".github/workflows/fork-source-package.yml",
  event: "push",
  head_branch: "main",
  status: "completed",
  conclusion: "success",
  head_sha: sha,
  run_attempt: 2
};
const job = {
  id: 7,
  name: "accept-source-package",
  status: "completed",
  conclusion: "success",
  head_sha: sha,
  run_id: 42,
  run_attempt: 1
};
const env = {
  GITHUB_REPOSITORY: repository,
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REF: "refs/heads/main"
};

test("accepts only successful fork main pushes and the latest accepted attempt", () => {
  assert.deepEqual(validateReleaseRun(run, [job], "42"), { sha, attempt: 1 });
  assert.deepEqual(validateReleaseRun({ ...run, path: `${run.path}@main` }, [job], "42"), {
    sha,
    attempt: 1
  });
  for (const change of [
    { id: 41 },
    { event: "pull_request" },
    { head_branch: "feature" },
    { status: "in_progress" },
    { conclusion: "failure" },
    { repository: { full_name: "ryansolid/dom-expressions" } },
    { head_repository: { full_name: "foreign/dom-expressions" } },
    { path: ".github/workflows/fork-source-package.yml.backup" },
    { run_attempt: 0 }
  ])
    assert.throws(() => validateReleaseRun({ ...run, ...change }, [job], "42"));
  assert.throws(() => validateReleaseRun(run, [], "42"));
  for (const change of [
    { status: "in_progress" },
    { conclusion: "skipped" },
    { head_sha: "b".repeat(40) },
    { run_id: 43 },
    { run_attempt: 0 },
    { run_attempt: 3 },
    { run_attempt: undefined }
  ])
    assert.throws(() => validateReleaseRun(run, [{ ...job, ...change }], "42"));
  const later = { ...job, id: 8, run_attempt: 2, conclusion: "failure" };
  for (const history of [
    [job, later],
    [later, job]
  ])
    assert.throws(() => validateReleaseRun(run, history, "42"), /Latest package acceptance/);
  assert.deepEqual(validateReleaseRun(run, [job, { ...later, conclusion: "success" }], "42"), {
    sha,
    attempt: 2
  });
});

function fixture(context) {
  const root = mkdtempSync(join(process.env.OWNED_TEMP_DIR ?? tmpdir(), "solid-promoter-test-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const accepted = join(root, "accepted");
  const temporaryRoot = join(root, "temporary");
  const source = join(root, "source", "package");
  for (const path of [accepted, temporaryRoot, join(source, "web/dist"), join(source, "web/types")])
    mkdirSync(path, { recursive: true });
  const packageManifest = {
    name: "solid-js",
    version: "1.9.17",
    files: ["web/dist", "web/types"],
    dependencies: { csstype: "^3.1.0", seroval: "~1.6.8", "seroval-plugins": "~1.6.8" },
    exports: {
      "./web": {
        import: "./web/dist/server.js",
        require: "./web/dist/server.cjs",
        types: "./web/types/server.d.ts"
      }
    }
  };
  const sources = new Map([
    ["package.json", JSON.stringify(packageManifest)],
    ["README.md", "Native package"],
    ["LICENSE", "MIT"],
    ["web/dist/server.js", "export const transformSerializedScript = script => script;"],
    ["web/dist/server.cjs", "exports.transformSerializedScript = script => script;"],
    [
      "web/types/server.d.ts",
      "export interface Options { transformSerializedScript?: (script: string) => string }"
    ]
  ]);
  const rootSources = new Map([
    ["LICENSE", "MIT"],
    ["pnpm-lock.yaml", "accepted frozen dependency graph"],
    ["pnpm-workspace.yaml", "packages: [packages/*]"],
    [
      "package.json",
      JSON.stringify({
        devDependencies: {
          "dom-expressions":
            "https://github.com/BleedingDev/dom-expressions/releases/download/accepted/dom-expressions.tgz"
        }
      })
    ]
  ]);
  const hash = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  for (const [path, bytes] of sources) writeFileSync(join(source, path), bytes);
  const archive = "solid-js-1.9.17.tgz";
  const repack = () =>
    execFileSync("tar", ["-czf", join(accepted, archive), "-C", join(root, "source"), "package"]);
  repack();
  const manifest = {
    schemaVersion: 1,
    repository,
    sourceSha: sha,
    run: { id: "42", attempt: "1", event: "push", ref: "refs/heads/main" },
    package: {
      name: "solid-js",
      version: "1.9.17",
      dependencies: packageManifest.dependencies,
      archive,
      integrity: `sha512-${createHash("sha512")
        .update(readFileSync(join(accepted, archive)))
        .digest("base64")}`
    },
    build: {
      node: "24.18.0",
      pnpm: "9.15.0",
      commands: ["pnpm run build", "pnpm run types", "pnpm run test"],
      lockfileIntegrity: hash(rootSources.get("pnpm-lock.yaml")),
      workspaceConfigIntegrity: hash(rootSources.get("pnpm-workspace.yaml")),
      domExpressionsRequest: JSON.parse(rootSources.get("package.json")).devDependencies[
        "dom-expressions"
      ],
      dependencies: ["dom-expressions", ...Object.keys(packageManifest.dependencies)].map(name => ({
        name,
        version: "1.6.8",
        packageJsonIntegrity: hash(name)
      })),
      domSerializerIntegrity: hash("exact DOM serializer")
    }
  };
  const save = () => writeFileSync(join(accepted, "source-package.json"), JSON.stringify(manifest));
  save();
  const state = {
    release: undefined,
    assets: new Map(),
    incomplete: new Set(),
    injectFinalAsset: false,
    uploads: 0,
    creates: 0,
    edits: 0,
    failAfterUploads: Infinity,
    mutable: false,
    foreignTag: false,
    downloadFailure: false,
    interruptDownload: false,
    calls: []
  };
  const git = (...args) => {
    if (args[0] === "merge-base") {
      assert.deepEqual(args, ["merge-base", "--is-ancestor", sha, "origin/main"]);
      return Buffer.from("");
    }
    if (args[0] === "ls-remote")
      return Buffer.from(state.foreignTag ? `${"b".repeat(40)}\trefs/tags/${tag}\n` : "");
    assert.equal(args[0], "show");
    const path = args[1].replace(`${sha}:`, "");
    if (path.startsWith("packages/solid/")) {
      const relative = path.slice("packages/solid/".length);
      assert(sources.has(relative), `Unexpected package source read ${path}`);
      return Buffer.from(sources.get(relative));
    }
    assert(rootSources.has(path), `Unexpected root source read ${path}`);
    return Buffer.from(rootSources.get(path));
  };
  const gh = async (...args) => {
    state.calls.push(args);
    if (args[0] === "api") {
      const route = args[1];
      if (route.endsWith("/actions/runs/42")) return JSON.stringify(run);
      if (route.includes("/jobs?")) return JSON.stringify([{ jobs: [job] }]);
      if (route === "graphql")
        return JSON.stringify({
          data: {
            repository: {
              release: state.release ? { databaseId: state.release.id } : null
            }
          }
        });
      if (route.endsWith("/assets?per_page=100"))
        return JSON.stringify([
          [...state.assets.keys()].map(name => ({
            name,
            state: state.incomplete.has(name) ? "starter" : "uploaded"
          }))
        ]);
      if (route.endsWith("/releases/9"))
        return JSON.stringify({
          ...state.release,
          assets: [...state.assets.keys()].map(name => ({ name, state: "uploaded" }))
        });
      if (route.endsWith(`/commits/${tag}`)) return JSON.stringify({ sha });
      assert.fail(`Unexpected API call: ${args}`);
    }
    if (args[0] === "run") {
      assert.equal(args[args.indexOf("--name") + 1], "solid-source-42-1");
      if (state.downloadFailure) throw new Error("download interrupted");
      cpSync(accepted, args[args.indexOf("--dir") + 1], { recursive: true });
      if (state.interruptDownload) process.emit("SIGTERM");
      return "";
    }
    assert.equal(args[0], "release");
    assert.equal(args[2], tag);
    if (args[1] === "create") {
      assert(!state.release, "Resume the existing draft");
      state.creates++;
      state.release = {
        id: 9,
        tag_name: tag,
        target_commitish: sha,
        draft: true,
        immutable: false
      };
    } else if (args[1] === "upload") {
      if (state.uploads === state.failAfterUploads) throw new Error("upload interrupted");
      const name = basename(args[3]);
      assert(!state.assets.has(name), "Never overwrite an asset");
      state.assets.set(name, readFileSync(args[3]));
      state.uploads++;
      if (state.injectDraftAsset)
        state.assets.set("foreign-file", Buffer.from("concurrent upload"));
    } else if (args[1] === "download") {
      const name = args[args.indexOf("--pattern") + 1];
      writeFileSync(join(args[args.indexOf("--dir") + 1], name), state.assets.get(name));
    } else if (args[1] === "edit") {
      state.edits++;
      state.release.draft = args.includes("--draft=true");
      state.release.immutable = !state.release.draft && !state.mutable;
      if (!state.release.draft && state.injectFinalAsset)
        state.assets.set("foreign-file", Buffer.from("concurrent upload"));
    } else if (args[1] === "delete-asset") {
      assert.equal(state.release.draft, true);
      assert(state.incomplete.has(args[3]));
      state.assets.delete(args[3]);
      state.incomplete.delete(args[3]);
    } else assert.fail(`Unexpected command: ${args}`);
    return "";
  };
  return {
    root,
    accepted,
    temporaryRoot,
    source,
    sources,
    manifest,
    save,
    repack,
    state,
    git,
    commands: { gh, git, temporaryRoot, env }
  };
}

test("revalidates metadata, SHA512 and exact reviewed source before publication", context => {
  const f = fixture(context);
  const identity = { sha, attempt: 1, runId: "42" };
  assert.deepEqual(validateReleaseArchive(f.accepted, identity, f.git), [
    "source-package.json",
    f.manifest.package.archive
  ]);
  for (const update of [
    { repository: "ryansolid/dom-expressions" },
    { sourceSha: "b".repeat(40) },
    { run: { ...f.manifest.run, event: "pull_request" } },
    { run: { ...f.manifest.run, attempt: "2" } },
    { package: { ...f.manifest.package, archive: "../outside.tgz" } },
    { package: { ...f.manifest.package, version: "9.9.9" } },
    { package: { ...f.manifest.package, integrity: "sha512-tampered" } },
    { package: { ...f.manifest.package, dependencies: { seroval: "foreign" } } },
    { build: { ...f.manifest.build, lockfileIntegrity: "sha512-foreign" } },
    { build: { ...f.manifest.build, workspaceConfigIntegrity: "sha512-foreign" } },
    { build: { ...f.manifest.build, domExpressionsRequest: "foreign" } },
    { build: { ...f.manifest.build, pnpm: "10.0.0" } },
    { build: { ...f.manifest.build, node: "22.0.0" } },
    { build: { ...f.manifest.build, commands: ["npm publish"] } },
    { build: { ...f.manifest.build, dependencies: f.manifest.build.dependencies.slice(1) } },
    {
      build: {
        ...f.manifest.build,
        dependencies: [...f.manifest.build.dependencies, f.manifest.build.dependencies[0]]
      }
    },
    { build: { ...f.manifest.build, domSerializerIntegrity: "sha512-invalid" } }
  ]) {
    writeFileSync(
      join(f.accepted, "source-package.json"),
      JSON.stringify({ ...f.manifest, ...update })
    );
    assert.throws(() => validateReleaseArchive(f.accepted, identity, f.git));
  }
  f.save();
  writeFileSync(join(f.accepted, "extra-file"), "unexpected");
  assert.throws(
    () => validateReleaseArchive(f.accepted, identity, f.git),
    /Unexpected artifact files/
  );
  rmSync(join(f.accepted, "extra-file"));
  f.sources.set("README.md", "different accepted source");
  assert.throws(() => validateReleaseArchive(f.accepted, identity, f.git), /source differs/);
});

test("resumes exact draft bytes and never edits an immutable finalized release", async context => {
  const f = fixture(context);
  f.state.failAfterUploads = 1;
  await assert.rejects(publishSourcePackage("42", f.commands), /upload interrupted/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.assets.size, 1);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
  f.state.failAfterUploads = Infinity;
  const url = await publishSourcePackage("42", f.commands);
  assert.equal(url, `https://github.com/${repository}/releases/tag/${tag}`);
  assert.equal(f.state.release.immutable, true);
  assert.equal(f.state.assets.size, 2);
  assert.equal(f.state.creates, 1);
  assert.equal(f.state.edits, 1);
  await publishSourcePackage("42", f.commands);
  assert.equal(f.state.uploads, 2);
  assert.equal(f.state.edits, 1);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
  f.state.assets.set("source-package.json", Buffer.from("remote tampering"));
  await assert.rejects(
    publishSourcePackage("42", f.commands),
    /Never replace existing release bytes/
  );
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
});

test("rejects mutable releases, foreign tags and unexpected draft assets", async context => {
  const f = fixture(context);
  f.state.foreignTag = true;
  await assert.rejects(publishSourcePackage("42", f.commands), /Existing tag targets another/);
  assert.equal(f.state.creates, 0);
  f.state.foreignTag = false;
  f.state.mutable = true;
  await assert.rejects(publishSourcePackage("42", f.commands), /immutability must be enabled/);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
  assert.equal(f.state.release.draft, true, "A mutable publication is returned to draft");
  f.state.mutable = false;
  await publishSourcePackage("42", f.commands);
  assert.equal(f.state.release.immutable, true);
  f.state.release.draft = true;
  f.state.assets.set("unreviewed.js", Buffer.from("unexpected"));
  await assert.rejects(publishSourcePackage("42", f.commands), /Unexpected release asset/);
});

test("recovers a mutable publication interrupted before rollback without changing its bytes", async context => {
  const f = fixture(context);
  f.state.mutable = true;
  await assert.rejects(
    publishSourcePackage("42", {
      ...f.commands,
      gh: async (...args) => {
        const result = await f.commands.gh(...args);
        if (args[0] === "release" && args[1] === "edit" && args.includes("--draft=false"))
          throw new Error("finalize response lost");
        return result;
      }
    }),
    /finalize response lost/
  );
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.release.immutable, false);
  const original = f.state.assets.get("source-package.json");
  f.state.assets.set("source-package.json", Buffer.from("foreign bytes"));
  await assert.rejects(
    publishSourcePackage("42", f.commands),
    /Never replace existing release bytes/
  );
  assert.equal(f.state.edits, 1, "Never demote a release with unverified bytes");
  f.state.assets.set("source-package.json", original);
  await assert.rejects(publishSourcePackage("42", f.commands), /Recovered mutable release/);
  assert.equal(f.state.release.draft, true);
  f.state.mutable = false;
  await publishSourcePackage("42", f.commands);
  assert.equal(f.state.release.immutable, true);
  assert.equal(f.state.uploads, 2, "Recovery reuses the exact accepted uploads");
  assert.equal(f.state.creates, 1);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
});

test("cleans owned partial downloads on failure or signal and restores signal listeners", async context => {
  const f = fixture(context);
  const listeners = process.listenerCount("SIGTERM");
  f.state.downloadFailure = true;
  await assert.rejects(publishSourcePackage("42", f.commands), /download interrupted/);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
  f.state.downloadFailure = false;
  f.state.interruptDownload = true;
  await assert.rejects(publishSourcePackage("42", f.commands), /Interrupted by SIGTERM/);
  assert.deepEqual(readdirSync(f.temporaryRoot), []);
  assert.equal(process.listenerCount("SIGTERM"), listeners);
  assert.equal(f.state.creates, 0);
  assert(existsCallerFile(f), "Caller-owned accepted artifact must remain intact");
});

function existsCallerFile(f) {
  return readFileSync(join(f.accepted, "source-package.json"), "utf8").includes(sha);
}

test("refuses a publisher invoked from another repository, event or branch", async context => {
  const f = fixture(context);
  for (const update of [
    { GITHUB_REPOSITORY: "ryansolid/dom-expressions" },
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/feature" }
  ])
    await assert.rejects(publishSourcePackage("42", { ...f.commands, env: { ...env, ...update } }));
  assert.equal(f.state.calls.length, 0);
});

test("replaces only incomplete draft uploads before resuming", async context => {
  const f = fixture(context);
  f.state.failAfterUploads = 1;
  await assert.rejects(publishSourcePackage("42", f.commands), /upload interrupted/);
  const [name] = f.state.assets.keys();
  f.state.incomplete.add(name);
  f.state.assets.set(name, Buffer.from("partial upload"));
  f.state.failAfterUploads = Infinity;
  await publishSourcePackage("42", f.commands);
  assert.equal(f.state.release.immutable, true);
  assert.equal(f.state.incomplete.size, 0);
  assert.deepEqual(f.state.assets.get(name), readFileSync(join(f.accepted, name)));
});

test("rejects a concurrent foreign asset before freezing a draft", async context => {
  const f = fixture(context);
  f.state.injectDraftAsset = true;
  await assert.rejects(publishSourcePackage("42", f.commands), /Draft release contains unexpected/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.release.immutable, false);
  assert.equal(f.state.edits, 0);
});

test("rejects a concurrent foreign asset in the finalized release", async context => {
  const f = fixture(context);
  f.state.injectFinalAsset = true;
  await assert.rejects(
    publishSourcePackage("42", f.commands),
    /Finalized release contains unexpected/
  );
  assert.equal(f.state.release.immutable, true);
});

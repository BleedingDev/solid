import assert from "node:assert/strict";
import test from "node:test";
import { probePublicSSR, runIdentity, validateCompiledPackage } from "./accept-source-package.mjs";

function fixture() {
  const manifest = {
    name: "solid-js",
    version: "1.9.17",
    type: "module",
    dependencies: { csstype: "^3.1.0", seroval: "~1.6.8", "seroval-plugins": "~1.6.8" },
    exports: {
      ".": {
        node: {
          import: "./dist/server.js",
          require: "./dist/server.cjs",
          types: "./types/index.d.ts"
        }
      },
      "./web": {
        node: {
          import: "./web/dist/server.js",
          require: "./web/dist/server.cjs",
          types: "./web/types/index.d.ts"
        }
      },
      "./dist/*": "./dist/*"
    }
  };
  const built = new Map([
    ["package.json", JSON.stringify(manifest)],
    ["README.md", "Native Solid package"],
    ["dist/server.js", "export const createResource = () => {};"],
    ["dist/server.cjs", "exports.createResource = () => {};"],
    ["types/index.d.ts", "export declare function createResource(): unknown;"],
    ["web/dist/server.js", "export function renderToStream(fn, { transformSerializedScript }) {}"],
    ["web/dist/server.cjs", "exports.renderToStream = (fn, { transformSerializedScript }) => {};"],
    [
      "web/types/server.d.ts",
      "export declare function renderToStream(fn: () => unknown, options?: { transformSerializedScript?: (script: string) => string }): unknown;"
    ],
    ["web/types/index.d.ts", "export * from './server.js';"]
  ]);
  const source = new Map(built);
  const archive = new Map([...built].map(([path, bytes]) => [`package/${path}`, bytes]));
  const options = {
    entries: [...archive.keys()],
    expectedFiles: [...built.keys()],
    readEntry: path => Buffer.from(archive.get(path) ?? ""),
    readBuilt: path => Buffer.from(built.get(path) ?? ""),
    readSource: path => Buffer.from(source.get(path) ?? "")
  };
  const saveManifest = () => {
    const bytes = JSON.stringify(manifest);
    built.set("package.json", bytes);
    source.set("package.json", bytes);
    archive.set("package/package.json", bytes);
  };
  return { manifest, built, source, archive, options, saveManifest };
}

test("accepts complete native compiled outputs and public SSR surfaces", () => {
  const f = fixture();
  assert.deepEqual(validateCompiledPackage(f.options), {
    name: "solid-js",
    version: "1.9.17",
    dependencies: f.manifest.dependencies
  });
});

test("accepts pack manifest formatting while rejecting changed manifest fields", () => {
  const f = fixture();
  f.built.set("package.json", `${JSON.stringify(f.manifest, null, 2)}\n`);
  f.source.set("package.json", f.built.get("package.json"));
  validateCompiledPackage(f.options);

  f.archive.set(
    "package/package.json",
    JSON.stringify({
      ...f.manifest,
      dependencies: { ...f.manifest.dependencies, seroval: "~0.0.1" }
    })
  );
  assert.throws(() => validateCompiledPackage(f.options), /manifest must match/);

  const nested = fixture();
  nested.built.set("web/package.json", '{"type":"module"}\n');
  nested.source.set("web/package.json", '{"type":"module"}\n');
  nested.archive.set("package/web/package.json", '{"type":"module"}');
  nested.options.expectedFiles.push("web/package.json");
  nested.options.entries.push("package/web/package.json");
  validateCompiledPackage(nested.options);
  nested.archive.set("package/web/package.json", '{"type":"commonjs"}');
  assert.throws(() => validateCompiledPackage(nested.options), /differs from the native build/);
});

test("rejects altered, missing and unexpected archive files", () => {
  const altered = fixture();
  altered.archive.set("package/web/dist/server.js", "post-build patch");
  assert.throws(() => validateCompiledPackage(altered.options), /differs from the native build/);
  const missing = fixture();
  missing.options.entries = missing.options.entries.filter(
    path => path !== "package/types/index.d.ts"
  );
  assert.throws(
    () => validateCompiledPackage(missing.options),
    /complete native package inventory/
  );
  const extra = fixture();
  extra.options.entries.push("package/unreviewed.js");
  assert.throws(() => validateCompiledPackage(extra.options), /complete native package inventory/);
});

test("rejects unsafe paths, duplicates and source manifest or documentation drift", () => {
  for (const path of [
    "../outside",
    "package/../outside",
    "package/src\\outside",
    "package/package.json"
  ]) {
    const f = fixture();
    f.options.entries.push(path);
    assert.throws(() => validateCompiledPackage(f.options), /Unsafe|Duplicate/);
  }
  const manifest = fixture();
  manifest.source.set("package.json", '{"name":"solid-js","version":"0.0.0"}');
  assert.throws(() => validateCompiledPackage(manifest.options), /manifest must match/);
  const docs = fixture();
  docs.source.set("README.md", "another source commit");
  assert.throws(() => validateCompiledPackage(docs.options), /Packaged source differs/);
});

test("requires declared exports, generated SSR declarations and both compiled transform hooks", () => {
  const missingExport = fixture();
  missingExport.manifest.exports["."].node.types = "./types/missing.d.ts";
  missingExport.saveManifest();
  assert.throws(() => validateCompiledPackage(missingExport.options), /Missing export target/);
  for (const path of ["web/dist/server.js", "web/dist/server.cjs", "web/types/server.d.ts"]) {
    const f = fixture();
    f.built.set(path, "old native implementation");
    f.archive.set(`package/${path}`, "old native implementation");
    assert.throws(
      () => validateCompiledPackage(f.options),
      /Missing serialized-script transform contract/
    );
  }
});

const sha = "a".repeat(40);
const env = {
  GITHUB_REPOSITORY: "BleedingDev/solid",
  GITHUB_SHA: sha,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "2"
};

test("distinguishes accepted main-push and PR artifacts using exact run identity", () => {
  assert.deepEqual(runIdentity(env, sha), {
    id: "42",
    attempt: "2",
    event: "push",
    ref: "refs/heads/main"
  });
  assert.equal(
    runIdentity({ ...env, GITHUB_EVENT_NAME: "pull_request", GITHUB_REF: "refs/pull/3/merge" }, sha)
      .event,
    "pull_request"
  );
  for (const change of [
    { GITHUB_REPOSITORY: "solidjs/solid" },
    { GITHUB_SHA: "b".repeat(40) },
    { GITHUB_EVENT_NAME: "workflow_dispatch" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ATTEMPT: undefined }
  ])
    assert.throws(() => runIdentity({ ...env, ...change }, sha));
});

test("the packed SSR probe requires actual transform invocation and its emitted bytes", async () => {
  const solid = {
    createResource: fetcher => [fetcher],
    createComponent: (component, props) => component(props),
    Suspense: props => props.children
  };
  const web = {
    renderToString() {},
    renderToStringAsync() {},
    renderToStream(component, options) {
      const value = component();
      const transformed = options.transformSerializedScript(`resource=${value};`);
      return {
        pipe(writer) {
          writer.write(transformed);
          writer.end();
        }
      };
    }
  };
  await probePublicSSR(solid, web);
  await assert.rejects(
    probePublicSSR(solid, {
      ...web,
      renderToStream: () => ({
        pipe(writer) {
          writer.write("untransformed");
          writer.end();
        }
      })
    }),
    /did not apply/
  );
  await assert.rejects(
    probePublicSSR(solid, { ...web, renderToStream: undefined }),
    /Missing public SSR export/
  );
});

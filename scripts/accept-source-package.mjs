import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "BleedingDev/solid";
const packagePath = "packages/solid";
const command = (program, args, options = {}) =>
  execFileSync(program, args, { maxBuffer: 32 * 1024 * 1024, ...options });
const integrity = bytes => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

export function runIdentity(env, sourceSha) {
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(env.GITHUB_SHA, sourceSha);
  const push = env.GITHUB_EVENT_NAME === "push" && env.GITHUB_REF === "refs/heads/main";
  const pr =
    env.GITHUB_EVENT_NAME === "pull_request" &&
    /^refs\/pull\/\d+\/merge$/.test(env.GITHUB_REF ?? "");
  assert(push || pr, "Expected a fork main push or PR qualification run");
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) assert.match(env[key], /^[1-9]\d*$/);
  return {
    id: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF
  };
}

export function validateCompiledPackage({
  entries,
  expectedFiles,
  readEntry,
  readBuilt,
  readSource
}) {
  assert.equal(new Set(entries).size, entries.length, "Duplicate archive entry");
  for (const entry of entries) {
    assert(
      entry.startsWith("package/") &&
        !entry.includes("\\") &&
        !entry.split("/").some(part => part === "." || part === ".."),
      "Unsafe archive entry"
    );
  }
  const files = entries.filter(path => !path.endsWith("/"));
  assert.deepEqual(
    [...files].sort(),
    expectedFiles.map(path => `package/${path}`).sort(),
    "Archive must contain the complete native package inventory"
  );
  const manifest = JSON.parse(readEntry("package/package.json"));
  const sourceManifest = JSON.parse(readSource("package.json"));
  assert.equal(manifest.name, "solid-js");
  assert.deepEqual(manifest, sourceManifest, "Package manifest must match the source commit");
  for (const path of expectedFiles) {
    assert.deepEqual(
      Buffer.from(readEntry(`package/${path}`)),
      Buffer.from(readBuilt(path)),
      `Archive differs from the native build: ${path}`
    );
    if (path.endsWith("package.json") || path.endsWith("README.md") || path === "jsx-runtime.d.ts")
      assert.deepEqual(
        Buffer.from(readEntry(`package/${path}`)),
        Buffer.from(readSource(path)),
        `Packaged source differs from the accepted commit: ${path}`
      );
  }
  const checkExports = (value, prefix = "") => {
    if (typeof value === "string") {
      assert(value.startsWith("./"), "Exports must stay inside the package");
      const target = prefix + value.slice(2);
      if (target.includes("*")) {
        const [start, end] = target.split("*");
        assert(
          expectedFiles.some(path => path.startsWith(start) && path.endsWith(end)),
          `Missing wildcard export target: ${target}`
        );
      } else assert(expectedFiles.includes(target), `Missing export target: ${target}`);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) checkExports(child, prefix);
    }
  };
  checkExports(manifest.exports);
  for (const path of expectedFiles.filter(path => path.endsWith("/package.json"))) {
    const nested = JSON.parse(readEntry(`package/${path}`));
    if (nested.exports) checkExports(nested.exports, path.slice(0, -"package.json".length));
  }
  for (const path of ["web/dist/server.js", "web/dist/server.cjs", "web/types/server.d.ts"]) {
    assert(expectedFiles.includes(path), `Missing SSR surface: ${path}`);
    assert(
      readEntry(`package/${path}`).toString().includes("transformSerializedScript"),
      `Missing serialized-script transform contract: ${path}`
    );
  }
  return { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies };
}

function walkFiles(directory, relative = "") {
  const target = join(directory, relative);
  const stat = lstatSync(target);
  if (stat.isFile()) return [relative];
  assert(
    stat.isDirectory(),
    `Native package input must be a regular file or directory: ${relative}`
  );
  return readdirSync(target).flatMap(name =>
    walkFiles(directory, relative ? `${relative}/${name}` : name)
  );
}

function dependency(name, from) {
  const require = createRequire(join(from, "package.json"));
  let entry;
  try {
    entry = require.resolve(`${name}/package.json`);
  } catch {
    entry = require.resolve(name === "seroval-plugins" ? `${name}/web` : name);
  }
  let root = dirname(entry);
  while (true) {
    const path = join(root, "package.json");
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      const manifest = JSON.parse(bytes);
      if (manifest.name === name)
        return { root, name, version: manifest.version, packageJsonIntegrity: integrity(bytes) };
    }
    const parent = dirname(root);
    assert.notEqual(parent, root, `Cannot locate installed dependency ${name}`);
    root = parent;
  }
}

// Runs unchanged against both public module formats from the extracted archive.
export async function probePublicSSR(solid, web) {
  for (const name of ["renderToString", "renderToStringAsync", "renderToStream"])
    if (typeof web[name] !== "function") throw new Error(`Missing public SSR export ${name}`);
  const transformed = [];
  const stream = web.renderToStream(
    () => {
      const [value] = solid.createResource(() => ({ accepted: "packed source" }));
      return solid.createComponent(solid.Suspense, {
        fallback: "pending",
        get children() {
          return JSON.stringify(value());
        }
      });
    },
    {
      transformSerializedScript(script) {
        transformed.push(script);
        return `globalThis.__solidAcceptedScripts.push(()=>{${script}});`;
      }
    }
  );
  const html = await new Promise((resolve, reject) => {
    let html = "";
    stream.pipe({
      write(chunk) {
        html += chunk;
      },
      end() {
        resolve(html);
      },
      destroy(error) {
        reject(error);
      }
    });
  });
  if (!transformed.length || !html.includes("globalThis.__solidAcceptedScripts.push"))
    throw new Error("Public packed SSR did not apply the serialized-script transform");
}

function acceptPublicSurfaces(archive, dependencies) {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), "solid-package-accept-"));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal, index) => [
      signal,
      () => {
        cleanup();
        process.exit([130, 143, 129][index]);
      }
    ])
  );
  for (const [signal, handler] of handlers) process.once(signal, handler);
  try {
    const modules = join(directory, "node_modules");
    mkdirSync(modules);
    command("tar", ["-xzf", archive, "-C", directory]);
    symlinkSync(join(directory, "package"), join(modules, "solid-js"), "dir");
    for (const entry of dependencies) symlinkSync(entry.root, join(modules, entry.name), "dir");
    mkdirSync(join(modules, "@types"));
    const require = createRequire(join(process.cwd(), "package.json"));
    symlinkSync(
      dirname(require.resolve("@types/node/package.json")),
      join(modules, "@types/node"),
      "dir"
    );
    const body = `${probePublicSSR.toString()}\nawait probePublicSSR(solid, web);\n`;
    writeFileSync(
      join(directory, "public-ssr.mjs"),
      `import * as solid from 'solid-js';\nimport * as web from 'solid-js/web';\n${body}`
    );
    writeFileSync(
      join(directory, "public-ssr.cjs"),
      `const solid = require('solid-js'), web = require('solid-js/web');\n` +
        `${probePublicSSR.toString()}\nprobePublicSSR(solid, web).catch(error => { console.error(error); process.exitCode = 1; });\n`
    );
    command(process.execPath, [join(directory, "public-ssr.mjs")], { timeout: 30000 });
    command(process.execPath, [join(directory, "public-ssr.cjs")], { timeout: 30000 });
    writeFileSync(
      join(directory, "public-ssr.mts"),
      `import { renderToStream, renderToString, renderToStringAsync } from 'solid-js/web';\n` +
        `const options = { transformSerializedScript: (script: string): string => script };\n` +
        `renderToStream(() => 'accepted', options);\nrenderToString(() => 'accepted', options);\nrenderToStringAsync(() => 'accepted', options);\n`
    );
    command(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--lib",
        "ES2022,DOM",
        "--types",
        "node",
        join(directory, "public-ssr.mts")
      ],
      { cwd: directory, timeout: 60000 }
    );
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    cleanup();
  }
}

export function acceptSourcePackage(directory) {
  assert(directory, "Usage: node scripts/accept-source-package.mjs <archive-directory>");
  const sourceSha = command("git", ["rev-parse", "HEAD"]).toString().trim();
  const run = runIdentity(process.env, sourceSha);
  command("git", ["diff", "--exit-code", sourceSha, "--", "."]);
  const archives = readdirSync(directory).filter(path => path.endsWith(".tgz"));
  assert.equal(archives.length, 1, "Expected exactly one native archive");
  const archive = resolve(directory, archives[0]);
  assert(lstatSync(archive).isFile(), "Archive must be a regular file");
  const listing = command("tar", ["-tvzf", archive]).toString().trim().split("\n");
  assert(
    listing.every(line => /^[d-]/.test(line)),
    "Archive links and special files are forbidden"
  );
  const entries = command("tar", ["-tzf", archive]).toString().trim().split("\n");
  const packageDirectory = resolve(packagePath);
  const manifest = JSON.parse(readFileSync(join(packageDirectory, "package.json")));
  const expectedFiles = [
    "package.json",
    ...manifest.files.flatMap(path => walkFiles(packageDirectory, path))
  ];
  for (const entry of entries) {
    const path = entry.slice("package/".length);
    if ((path.endsWith("README.md") || path === "LICENSE") && !expectedFiles.includes(path))
      expectedFiles.push(path);
  }
  const readSource = path => command("git", ["show", `${sourceSha}:${packagePath}/${path}`]);
  const identity = validateCompiledPackage({
    entries,
    expectedFiles,
    readEntry: path => command("tar", ["-xOzf", archive, path]),
    readBuilt: path =>
      path === "LICENSE" && !existsSync(join(packageDirectory, path))
        ? readFileSync("LICENSE")
        : readFileSync(join(packageDirectory, path)),
    readSource
  });
  const runtime = Object.keys(identity.dependencies).map(name =>
    dependency(name, packageDirectory)
  );
  const dom = dependency("dom-expressions", process.cwd());
  acceptPublicSurfaces(archive, runtime);
  const rootManifest = JSON.parse(readFileSync("package.json"));
  const metadata = {
    schemaVersion: 1,
    repository,
    sourceSha,
    run,
    package: {
      ...identity,
      archive: basename(archive),
      integrity: integrity(readFileSync(archive))
    },
    build: {
      node: process.versions.node,
      pnpm: command("pnpm", ["--version"]).toString().trim(),
      commands: ["pnpm run build", "pnpm run types", "pnpm run test"],
      lockfileIntegrity: integrity(readFileSync("pnpm-lock.yaml")),
      workspaceConfigIntegrity: integrity(readFileSync("pnpm-workspace.yaml")),
      domExpressionsRequest: rootManifest.devDependencies["dom-expressions"],
      dependencies: [dom, ...runtime].map(({ root, ...entry }) => entry),
      domSerializerIntegrity: integrity(readFileSync(join(dom.root, "src/serializer.js")))
    }
  };
  writeFileSync(join(directory, "source-package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`Accepted ${identity.name}@${identity.version} from ${sourceSha}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  acceptSourcePackage(process.argv[2]);

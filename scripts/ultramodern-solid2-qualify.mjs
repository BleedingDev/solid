import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile, cp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { version, packages } from "./ultramodern-solid2-release.mjs";
import { verifySourceExclusion } from "./ultramodern-solid2-policy.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.equal(process.argv.length, 3, "Provide a fresh artifact output directory");
const output = path.resolve(process.argv[2]);
assert(output !== repo && !repo.startsWith(`${output}${path.sep}`));
const work = await mkdtemp(path.join(os.tmpdir(), "solid2-qualification-"));
const compilerSource = "4937f0a2bfddd45a65738c189075aff577530073";
const pnpm = process.env.PNPM_BIN ?? "pnpm";
let child;
let nativePath;
let interrupted = false;
const groups = [];
const stop = () => {
  interrupted = true;
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
async function run(command, args, cwd = repo, env = {}) {
  assert(!interrupted, "Qualification interrupted");
  await new Promise((resolve, reject) => {
    child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      detached: true,
      env: {
        ...process.env,
        ...(nativePath ? { SOLID_COMPILER_NATIVE: nativePath } : {}),
        JSX_COMPILER: "native",
        ...env
      }
    });
    if (child.pid) groups.push(child.pid);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      if (code === 0 && !interrupted) resolve();
      else reject(new Error(`${command} failed: ${signal ?? code}`));
    });
  });
}
function entryFiles(pkg) {
  const entries = new Set();
  const walk = value => {
    if (typeof value === "string" && value && !value.includes("*"))
      entries.add(value.replace(/^\.\//, ""));
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  for (const field of ["main", "module", "types", "browser", "bin", "exports"]) walk(pkg[field]);
  return entries;
}
try {
  // Official compiler/signals stay unchanged; their npm releases remain the
  // consumer dependency. Source CI uses the supported explicit native loader.
  await run("git", [
    "diff",
    "--exit-code",
    compilerSource,
    "--",
    "packages/compiler",
    "packages/signals",
    "packages/babel-plugin"
  ]);
  await run(process.execPath, ["scripts/check-release-invariants.mjs"]);
  const hook = path.join(work, "strict.cjs");
  await writeFile(
    hook,
    `module.exports = { hooks: { updateConfig(config) { return { ...config, minimumReleaseAge: 1440, minimumReleaseAgeExclude: [], strictPeerDependencies: true, packageImportMethod: "clone-or-copy", allowBuilds: { esbuild: true } }; } } };\n`
  );
  const strict = [
    `--config.pnpmfile=${hook}`,
    "--strict-peer-dependencies",
    "--package-import-method",
    "clone-or-copy"
  ];
  const metadata = await fetch("https://registry.npmjs.org/@solidjs%2fvite-plugin", {
    signal: AbortSignal.timeout(30_000)
  });
  assert(metadata.ok, `Native Vite plugin registry metadata failed: ${metadata.status}`);
  const sourceVite = verifySourceExclusion(
    await readFile(path.join(repo, "pnpm-workspace.yaml"), "utf8"),
    JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")),
    await metadata.json()
  );
  // No source pnpmfile: adding one changes the frozen lock's checksum.
  // This one upstream exclusion was age-checked above, never accepted as a waiver.
  await run(pnpm, [
    "--config.minimumReleaseAge=1440",
    "--strict-peer-dependencies",
    "--package-import-method",
    "clone-or-copy",
    "install",
    "--frozen-lockfile"
  ]);
  await run("git", [
    "diff",
    "--exit-code",
    "--",
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "packages/*/package.json"
  ]);
  const platform =
    process.platform === "darwin"
      ? `darwin-${process.arch}`
      : process.platform === "linux" && ["x64", "arm64"].includes(process.arch)
        ? `linux-${process.arch}-gnu`
        : undefined;
  assert(platform, "Qualification requires a supported native macOS or glibc Linux host");
  const nativePackage = `@solidjs/compiler-${platform}`;
  const compiler = path.join(work, "compiler");
  await mkdir(compiler);
  await writeFile(
    path.join(compiler, "package.json"),
    JSON.stringify({ private: true, dependencies: { [nativePackage]: version } })
  );
  await writeFile(
    path.join(compiler, "pnpm-workspace.yaml"),
    "packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude: []\nstrictPeerDependencies: true\npackageImportMethod: clone-or-copy\n"
  );
  await run(pnpm, [...strict, "install", "--no-frozen-lockfile", "--ignore-workspace"], compiler);
  nativePath = createRequire(path.join(compiler, "package.json")).resolve(nativePackage);
  const nativeManifest = JSON.parse(
    await readFile(path.join(path.dirname(nativePath), "package.json"), "utf8")
  );
  assert.equal(nativeManifest.name, nativePackage);
  assert.equal(nativeManifest.version, version);
  const compilerBinary = {
    package: nativePackage,
    version,
    integrity: `sha512-${createHash("sha512")
      .update(await readFile(nativePath))
      .digest("base64")}`
  };
  // This is the package's supported SOLID_COMPILER_NATIVE seam, not a stub edit.
  // The compiler source/loader itself was verified identical to official RC15.

  await run(pnpm, [
    "exec",
    "turbo",
    "run",
    "build",
    "types",
    "--filter=solid-js",
    "--filter=@solidjs/web",
    // Solid's cross-package field contract inspects universal's built tiers.
    "--filter=@solidjs/universal"
  ]);
  // Web's normal test script records SSR before its hydration project consumes it.
  for (const name of packages) {
    const directory = name === "solid-js" ? "packages/solid" : "packages/web";
    await run(pnpm, ["--dir", directory, "run", "test"]);
    await run(pnpm, ["--dir", directory, "run", "test-types"]);
  }
  const packs = path.join(work, "packs");
  await mkdir(packs);
  const accepted = {};
  const source = process.env.GITHUB_SHA;
  assert(source && /^[a-f0-9]{40}$/.test(source), "GITHUB_SHA must identify qualified source");
  for (const [name, directory] of [
    ["solid-js", "solid"],
    ["@solidjs/web", "web"]
  ]) {
    const pkg = JSON.parse(
      await readFile(path.join(repo, "packages", directory, "package.json"), "utf8")
    );
    assert.equal(pkg.version, version);
    const destination = path.join(packs, directory);
    await mkdir(destination);
    await run(pnpm, ["--dir", `packages/${directory}`, "pack", "--pack-destination", destination]);
    const files = await readdir(destination);
    assert.equal(files.length, 1, "Expected one normal package archive");
    const archive = path.join(destination, files[0]);
    const listing = new Set(
      execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
    );
    for (const entry of entryFiles(pkg))
      assert(listing.has(`package/${entry}`), `${name}: missing public archive entry ${entry}`);
    const bytes = await readFile(archive);
    accepted[name] = {
      version,
      archive: `${directory === "solid" ? "solid-js" : "solidjs-web"}-${source.slice(0, 12)}.tgz`,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      path: archive
    };
  }
  const consumer = path.join(work, "consumer");
  await cp(path.join(repo, "scripts/solid2-consumer"), consumer, { recursive: true });
  await writeFile(
    path.join(consumer, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          "solid-js": `file:${accepted["solid-js"].path}`,
          "@solidjs/web": `file:${accepted["@solidjs/web"].path}`,
          "@solidjs/signals": version,
          "@solidjs/compiler": version,
          typescript: "6.0.3",
          esbuild: "0.27.7",
          jsdom: "25.0.1"
        }
      },
      null,
      2
    )
  );
  await writeFile(
    path.join(consumer, "pnpm-workspace.yaml"),
    "packages: []\nminimumReleaseAge: 1440\nminimumReleaseAgeExclude: []\nstrictPeerDependencies: true\npackageImportMethod: clone-or-copy\nallowBuilds:\n  esbuild: true\n"
  );
  await writeFile(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
          lib: ["ES2022", "DOM", "DOM.Iterable"]
        },
        include: ["contract.ts"]
      },
      null,
      2
    )
  );
  await run(pnpm, [...strict, "install", "--no-frozen-lockfile", "--ignore-workspace"], consumer);
  await run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], consumer);
  await run(process.execPath, ["smoke.mjs"], consumer, { SOLID_COMPILER_NATIVE: "" });
  await mkdir(output);
  for (const entry of Object.values(accepted)) {
    await copyFile(entry.path, path.join(output, entry.archive));
    delete entry.path;
  }
  await writeFile(
    path.join(output, "acceptance.json"),
    JSON.stringify(
      {
        schema: 1,
        repository: process.env.GITHUB_REPOSITORY,
        source,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
        signals: version,
        compiler: version,
        compilerSource,
        compilerBinary,
        sourceVite,
        packages: accepted,
        checks: [
          "native owning solid/web tests and types",
          "all concrete packed exports",
          "strict installed consumer without overrides or age exemptions",
          "official RC15 native compiler",
          "shared runtime/signals identities",
          "production/development public SSR, deferred hydration, event replay, client fallback and cleanup"
        ]
      },
      null,
      2
    ) + "\n"
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const live = groups.filter(pid => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  });
  if (live.length) console.error(`Retained ${work}: process groups ${live.join(", ")} remain live`);
  else await rm(work, { recursive: true, force: true });
}

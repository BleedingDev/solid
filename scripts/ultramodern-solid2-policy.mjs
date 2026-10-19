import assert from "node:assert/strict";

// The unchanged upstream lock has no pnpmfile checksum. Keep its frozen
// install, and independently enforce age for its one pre-existing exemption.
export function verifySourceExclusion(workspace, manifest, metadata, now = Date.now()) {
  assert.equal((workspace.match(/^minimumReleaseAgeExclude:/gm) ?? []).length, 1);
  const block = workspace.match(/^minimumReleaseAgeExclude:\r?\n((?:[ \t]+[^\n]*\r?\n|\r?\n)*)/m);
  assert(block, "Expected the reviewed upstream exclusion list");
  const exclusions = block[1]
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  assert.deepEqual(
    exclusions,
    ["- '@solidjs/vite-plugin'"],
    "No new source age exemptions are accepted"
  );
  const version = "3.0.0-next.35";
  assert.equal(manifest.devDependencies["@solidjs/vite-plugin"], version);
  const publishedAt = metadata.time?.[version];
  const published = Date.parse(publishedAt);
  assert(
    Number.isFinite(published),
    "Registry did not supply the pinned Vite plugin publication time"
  );
  const mature = published + 1440 * 60_000;
  assert(
    Number.isFinite(now) && now >= mature,
    `Pinned native Vite plugin is not mature until ${new Date(mature).toISOString()}`
  );
  return {
    package: "@solidjs/vite-plugin",
    version,
    publishedAt,
    matureAt: new Date(mature).toISOString()
  };
}

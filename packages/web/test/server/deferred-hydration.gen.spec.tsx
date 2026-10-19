/** @jsxImportSource @solidjs/web */
import { expect, test } from "vitest";
import { deferredApp } from "../harness/deferred-hydration.jsx";
import { recordStream, writeArtifact } from "./artifact-recorder.js";

test("DeferredHydration renders children even when both client gates are closed", async () => {
  const entered: string[] = [];
  const App = deferredApp({
    ready: () => false,
    nestedReady: () => false,
    entered: n => entered.push(n)
  });
  const result = await recordStream(() => <App />);
  expect(result.shell).toContain("preserved context");
  expect(result.shell).toContain("nested context:");
  expect(result.shell).toContain("following sibling");
  expect(result.shell).not.toContain("client fallback");
  expect(entered).toEqual(["outer", "nested"]);
  expect(result.chunks).toEqual([]);
  const other = await recordStream(() => <App />, { renderId: "other" });
  const AsyncApp = deferredApp({ ready: () => false, async: true });
  const streamed = await recordStream(() => <AsyncApp />);
  expect(streamed.shell).toContain("native pending");
  expect(streamed.rest).toContain("async content");
  expect(streamed.chunks.length).toBeGreaterThan(0);
  writeArtifact("deferred-hydration", { ...result, other, streamed });
});

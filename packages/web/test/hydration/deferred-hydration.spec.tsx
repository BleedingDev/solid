/** @jsxImportSource @solidjs/web */
import { afterEach, beforeEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSignal, flush, onHydrationEnd } from "solid-js";
import { hydrate, render } from "@solidjs/web";
import { deferredApp } from "../harness/deferred-hydration.jsx";

const artifact = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../harness/__artifacts__/deferred-hydration.json"
    ),
    "utf8"
  )
) as {
  shell: string;
  other: { shell: string };
  streamed: { shell: string; chunks: string[] };
};
let container: HTMLDivElement;
let dispose: (() => void) | undefined;

function applyChunk(target: HTMLElement, html: string, first = true) {
  const scripts: string[] = [];
  const markup = html.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/g, (_, s) => {
    scripts.push(s);
    return "";
  });
  if (first) target.innerHTML = markup;
  else target.insertAdjacentHTML("beforeend", markup);
  for (const script of scripts) (0, eval)(script);
}
function mount() {
  applyChunk(container, artifact.shell);
}
async function settle() {
  await Promise.resolve();
  flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  flush();
}

beforeEach(() => {
  (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  await settle();
  container.remove();
  delete (globalThis as any)._$HY;
});

test("holds exact SSR nodes, preserves context, and replays one queued click on the late claim", async () => {
  mount();
  const button = container.querySelector("button")!;
  const nested = container.querySelector("span")!;
  const sibling = container.querySelector("aside")!;
  const entered: string[] = [];
  let clicks = 0;
  let settled = 0;
  let ended = 0;
  const [ready, setReady] = createSignal(false);
  const [nestedReady, setNestedReady] = createSignal(false);
  const App = deferredApp({
    ready,
    nestedReady,
    entered: n => entered.push(n),
    clicked: () => clicks++,
    settled: () => settled++
  });
  // The generated bootstrap queues the nearest keyed template root, not an
  // unkeyed descendant. The original event still targets the button.
  button.addEventListener(
    "click",
    event => (globalThis as any)._$HY.events.push([button.closest("[_hk]"), event]),
    {
      capture: true,
      once: true
    }
  );
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  expect(entered).toEqual([]);
  expect(settled).toBe(1);
  expect(ended).toBe(0);
  expect(container.querySelector("button")).toBe(button);
  expect(container.querySelector("aside")).toBe(sibling);
  expect(clicks).toBe(0);

  setReady(true);
  await settle();
  expect(entered).toEqual(["outer"]);
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")).toBe(button);
  expect(button.textContent).toBe("preserved context");
  expect(clicks).toBe(1);
  expect(ended).toBe(0);
  expect(container.querySelector("span")).toBe(nested);

  setNestedReady(true);
  await settle();
  expect(entered).toEqual(["outer", "nested"]);
  expect(container.querySelector("span")).toBe(nested);
  expect(nested.textContent).toBe("nested context: preserved context");
  expect(ended).toBe(1);
  setReady(false);
  setNestedReady(false);
  await settle();
  button.click();
  expect(clicks).toBe(2);
  expect(container.querySelector("button")).toBe(button);
  expect(entered).toEqual(["outer", "nested"]);
});

test("a late claim uses its original registry after another root hydrates", async () => {
  mount();
  const button = container.querySelector("button")!;
  const [ready, setReady] = createSignal(false);
  const App = deferredApp({ ready });
  dispose = hydrate(() => <App />, container);
  await settle();
  const otherContainer = document.createElement("div");
  document.body.appendChild(otherContainer);
  let disposeOther: (() => void) | undefined;
  try {
    applyChunk(otherContainer, artifact.other.shell);
    const otherButton = otherContainer.querySelector("button")!;
    const Other = deferredApp({ ready: () => true });
    disposeOther = hydrate(() => <Other />, otherContainer, { renderId: "other" });
    await settle();
    expect(otherContainer.querySelector("button")).toBe(otherButton);
    setReady(true);
    await settle();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector("button")).toBe(button);
    expect(otherContainer.querySelectorAll("button")).toHaveLength(1);
    expect(otherContainer.querySelector("button")).toBe(otherButton);
  } finally {
    disposeOther?.();
    otherContainer.remove();
  }
});

test("claims an async native Loading fragment delivered while its outer gate is held", async () => {
  applyChunk(container, artifact.streamed.shell);
  const [ready, setReady] = createSignal(false);
  const App = deferredApp({ ready, async: true });
  let ended = 0;
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  expect(ended).toBe(0);
  expect(container.textContent).toContain("native pending");
  for (const chunk of artifact.streamed.chunks) {
    applyChunk(container, chunk, false);
    await settle();
  }
  // The parser-delivered fragment may remain parked until its native Loading
  // owner claims it. Capture whichever real SSR nodes have already revealed.
  const deliveredButton =
    container.querySelector("button") ??
    Array.from(container.querySelectorAll("template"))
      .map(template => template.content.querySelector("button"))
      .find(button => button !== null);
  expect(deliveredButton).toBeTruthy();
  setReady(true);
  await settle();
  await settle();
  expect(container.querySelectorAll("button")).toHaveLength(1);
  expect(container.querySelector("button")).toBe(deliveredButton);
  expect(container.textContent).toContain("async content");
  expect(container.textContent).not.toContain("native pending");
  expect(container.querySelectorAll("template")).toHaveLength(0);
  expect(ended).toBe(1);
});

test("an initially open gate claims the server nodes without a deferred pass", async () => {
  mount();
  const button = container.querySelector("button")!;
  const span = container.querySelector("span")!;
  const [ready, setReady] = createSignal(true);
  const entered: string[] = [];
  let ended = 0;
  const App = deferredApp({ ready, entered: n => entered.push(n) });
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  expect(entered).toEqual(["outer", "nested"]);
  expect(container.querySelector("button")).toBe(button);
  expect(container.querySelector("span")).toBe(span);
  expect(ended).toBe(1);
  setReady(false);
  await settle();
  expect(entered).toEqual(["outer", "nested"]);
  expect(container.querySelector("button")).toBe(button);
});

test("disposing an unopened boundary releases its hold and a later gate cannot mount it", async () => {
  mount();
  const [ready, setReady] = createSignal(false);
  const entered: string[] = [];
  const App = deferredApp({ ready, entered: n => entered.push(n) });
  let ended = 0;
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  expect(ended).toBe(0);
  dispose();
  dispose = undefined;
  await settle();
  expect(ended).toBe(1);
  setReady(true);
  await settle();
  expect(entered).toEqual([]);
});

test("a queued activation cannot revive a boundary disposed before its microtask", async () => {
  mount();
  const [ready, setReady] = createSignal(false);
  const entered: string[] = [];
  const App = deferredApp({ ready, entered: name => entered.push(name) });
  let ended = 0;
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  setReady(true);
  // The user effect queues the claim; it does not run the claim in this flush.
  flush();
  expect(entered).toEqual([]);
  dispose();
  dispose = undefined;
  await settle();
  expect(entered).toEqual([]);
  expect(ended).toBe(1);
});

test("a client-only mount renders its fallback, then activates exactly once", async () => {
  const [ready, setReady] = createSignal(false);
  const entered: string[] = [];
  let cleaned = 0;
  const App = deferredApp({ ready, entered: n => entered.push(n), disposed: () => cleaned++ });
  dispose = render(() => <App />, container);
  expect(container.textContent).toContain("client fallback");
  expect(entered).toEqual([]);
  setReady(true);
  await settle();
  expect(entered).toEqual(["outer", "nested"]);
  expect(container.querySelector("button")!.textContent).toBe("preserved context");
  setReady(false);
  await settle();
  expect(entered).toEqual(["outer", "nested"]);
  expect(cleaned).toBe(0);
  dispose();
  dispose = undefined;
  expect(cleaned).toBe(1);
});

test("an error during a late claim reaches its native boundary and releases hydration", async () => {
  mount();
  const [ready, setReady] = createSignal(false);
  const error = new Error("activation failed");
  let caught: unknown;
  let ended = 0;
  const App = deferredApp({
    ready,
    fail: () => {
      throw error;
    },
    failed: e => {
      caught = e;
    }
  });
  dispose = hydrate(() => <App />, container);
  onHydrationEnd(() => ended++);
  await settle();
  expect(caught).toBeUndefined();
  expect(ended).toBe(0);
  setReady(true);
  await settle();
  expect(caught).toBe(error);
  expect(container.textContent).toBe("activation failed");
  expect(ended).toBe(1);
});

import { createSignal, flush, onHydrationEnd, DeferredHydration as CoreDeferred } from "solid-js";
import { createSignal as signal } from "@solidjs/signals";
import { hydrate, render, DeferredHydration } from "@solidjs/web";
import { createApp } from "./app.client.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}
async function settle() {
  await Promise.resolve();
  flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  flush();
}
export async function verify() {
  check(CoreDeferred === DeferredHydration, "core/web boundary identity differs");
  // A native signal drives the packed core boundary, which drives packed web.
  const [ready, setReady] = signal(false);
  const container = document.getElementById("app");
  const button = container.querySelector("button");
  const sibling = container.querySelector("aside");
  check(button && sibling, "server failed to render children behind a closed gate");
  let entered = 0;
  let clicked = 0;
  let cleaned = 0;
  let ended = 0;
  const App = createApp({
    ready,
    entered: () => entered++,
    clicked: () => clicked++,
    cleaned: () => cleaned++
  });
  // The real generated hydration script captures this event before activation.
  button.click();
  let dispose;
  try {
    dispose = hydrate(() => <App />, container);
    onHydrationEnd(() => ended++);
    await settle();
    check(entered === 0 && clicked === 0 && ended === 0, "closed boundary activated early");
    check(
      container.querySelector("button") === button && container.querySelector("aside") === sibling,
      "closed boundary replaced SSR DOM"
    );
    setReady(true);
    await settle();
    check(
      entered === 1 && clicked === 1 && ended === 1,
      "late claim did not activate/replay/release exactly once"
    );
    check(
      container.querySelector("button") === button && button.textContent === "packed RC15 context",
      "late claim lost SSR node/context"
    );
    setReady(false);
    await settle();
    button.click();
    check(
      entered === 1 && clicked === 2 && cleaned === 0,
      "activated boundary remounted or lost its event"
    );
  } finally {
    dispose?.();
  }
  check(cleaned === 1, "hydrated child did not clean up exactly once");
  const target = document.createElement("div");
  document.body.append(target);
  const [clientReady, setClientReady] = createSignal(false);
  const ClientApp = createApp({ ready: clientReady });
  try {
    dispose = render(() => <ClientApp />, target);
    check(
      target.textContent === "client fallbackfollowing sibling",
      "client fallback contract failed"
    );
    setClientReady(true);
    await settle();
    check(
      target.querySelector("button")?.textContent === "packed RC15 context",
      "client activation failed"
    );
  } finally {
    dispose?.();
    target.remove();
  }
}

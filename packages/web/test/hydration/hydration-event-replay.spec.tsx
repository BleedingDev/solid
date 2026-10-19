/** @jsxImportSource @solidjs/web */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { hydrate } from "@solidjs/web";
import { eventReplayApp } from "../harness/deferred-hydration.jsx";

const artifact = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../harness/__artifacts__/hydration-event-replay.json"
    ),
    "utf8"
  )
) as { bootstrap: string; cases: Array<{ shell: string }> };

function runScripts(html: string) {
  for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    (0, eval)(script);
  }
}
async function settle() {
  await Promise.resolve();
  flush();
  await new Promise(resolve => setTimeout(resolve, 0));
  flush();
}

test.each([
  { events: "dblclick", index: 0, replayedClicks: 0, replayedDoubleClicks: 1 },
  { events: "", index: 1, replayedClicks: 0, replayedDoubleClicks: 0 },
  { events: undefined, index: 2, replayedClicks: 2, replayedDoubleClicks: 1 }
])(
  "the public bootstrap preserves live propagation and filters later replay ($events)",
  async row => {
    const previous = (globalThis as any)._$HY;
    delete (globalThis as any)._$HY;
    const container = document.createElement("div");
    document.body.append(container);
    const listenerSpy = vi.spyOn(document, "addEventListener");
    let registrations: typeof listenerSpy.mock.calls = [];
    let dispose: (() => void) | undefined;
    try {
      // Execute the emitted bootstrap before any application hydration or intent
      // listener exists, as it runs in the server-rendered document's head.
      runScripts(artifact.bootstrap);
      registrations = listenerSpy.mock.calls.slice();
      listenerSpy.mockRestore();
      const html = artifact.cases[row.index]!.shell;
      container.innerHTML = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      runScripts(html);
      const parent = container.querySelector("main")!;
      const button = container.querySelector("button")!;
      let liveParentClicks = 0;
      parent.addEventListener("click", () => liveParentClicks++);
      const beforeEntry = new MouseEvent("click", { bubbles: true, cancelable: true });
      button.dispatchEvent(beforeEntry);
      expect(liveParentClicks).toBe(1);
      expect(beforeEntry.defaultPrevented).toBe(false);
      const queuedTypes = () =>
        ((globalThis as any)._$HY.events ?? []).map((entry: [Element, Event]) => entry[1].type);
      expect(queuedTypes()).toEqual(row.events === undefined ? ["click"] : []);
      button.click();
      const intent = new MouseEvent("dblclick", { bubbles: true, cancelable: true });
      button.dispatchEvent(intent);
      expect(intent.defaultPrevented).toBe(false);
      expect(liveParentClicks).toBe(2);
      const queuedBeforeEntry = [
        ...(row.events === undefined ? ["click", "click"] : []),
        ...(row.events === "" ? [] : ["dblclick"])
      ];
      expect(queuedTypes()).toEqual(queuedBeforeEntry);

      const [ready, setReady] = createSignal(false);
      let parentClicks = 0;
      let childClicks = 0;
      let childDoubleClicks = 0;
      const App = eventReplayApp({
        ready,
        events: row.events,
        parentClicked: () => parentClicks++,
        childClicked: () => childClicks++,
        childDoubleClicked: () => childDoubleClicks++
      });
      dispose = hydrate(() => <App />, container);
      await settle();
      expect(parentClicks).toBe(0);
      expect(childClicks).toBe(0);
      expect(queuedTypes()).toEqual(queuedBeforeEntry);
      if (row.events !== undefined) {
        // A declined click after entry must still reach the now-live native
        // parent. It must not enter the document's later replay queue.
        button.click();
        expect(liveParentClicks).toBe(3);
        expect(parentClicks).toBe(1);
        expect(childClicks).toBe(0);
        expect(queuedTypes()).toEqual(queuedBeforeEntry);
      }

      // The pre-entry double click is the intent that releases this native
      // gate once application code is available. Events already delivered
      // through a live root are not replayed through that same root twice.
      setReady(true);
      await settle();
      await settle();
      expect(container.querySelector("main")).toBe(parent);
      expect(container.querySelector("button")).toBe(button);
      expect(childClicks).toBe(row.replayedClicks);
      expect(childDoubleClicks).toBe(row.replayedDoubleClicks);
      const parentBeforeLiveClick = parentClicks;
      button.click();
      await settle();
      expect(childClicks).toBe(row.replayedClicks + 1);
      expect(parentClicks).toBe(parentBeforeLiveClick + 1);
      expect(liveParentClicks).toBe(row.events === undefined ? 3 : 4);
    } finally {
      registrations = registrations.length ? registrations : listenerSpy.mock.calls.slice();
      listenerSpy.mockRestore();
      dispose?.();
      await settle();
      for (const [type, listener, options] of registrations) {
        document.removeEventListener(
          type,
          listener,
          typeof options === "boolean" ? options : options?.capture
        );
      }
      container.remove();
      if (previous === undefined) delete (globalThis as any)._$HY;
      else (globalThis as any)._$HY = previous;
    }
  }
);

/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 */
import { expect, test, vi } from "vitest";
import { generateHydrationScript, HydrationScript, renderToString } from "@solidjs/web";

type Page = { window: typeof globalThis };

function withPage(
  markup: string,
  run: (page: Page) => void,
  bootstrap = generateHydrationScript()
) {
  const previousBody = [...document.body.childNodes];
  const hydrationTargets = new Set([globalThis, window]);
  const previousHydration = [...hydrationTargets].map(target => ({
    target,
    descriptor: Object.getOwnPropertyDescriptor(target, "_$HY")
  }));
  const listenerSpy = vi.spyOn(document, "addEventListener");
  let registrations: typeof listenerSpy.mock.calls = [];
  try {
    for (const target of hydrationTargets) Reflect.deleteProperty(target, "_$HY");
    document.body.replaceChildren();
    try {
      for (const [, script] of bootstrap.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
        (0, eval)(script);
      }
    } finally {
      registrations = listenerSpy.mock.calls.slice();
      listenerSpy.mockRestore();
    }
    document.body.innerHTML = markup;
    run({ window: globalThis });
  } finally {
    for (const [type, listener, options] of registrations) {
      document.removeEventListener(type, listener, options);
    }
    document.body.replaceChildren(...previousBody);
    for (const { target, descriptor } of previousHydration) {
      if (descriptor) Object.defineProperty(target, "_$HY", descriptor);
      else Reflect.deleteProperty(target, "_$HY");
    }
  }
}
function queued(page: Page): Array<[Element, Event]> {
  const state: unknown = Reflect.get(page.window, "_$HY");
  if (!state || typeof state !== "object" || !("events" in state) || !Array.isArray(state.events)) {
    throw new Error("The emitted hydration bootstrap did not install its replay queue");
  }
  return state.events.map((entry: unknown): [Element, Event] => {
    if (!Array.isArray(entry) || !(entry[0] instanceof Element) || !(entry[1] instanceof Event)) {
      throw new Error("The emitted hydration bootstrap queued an invalid event");
    }
    return [entry[0], entry[1]];
  });
}

test.each([
  ['data-hydration-events="dblclick"', 0],
  ['data-hydration-events=""', 0],
  ['data-hydration-events="input click"', 1],
  ["", 1]
])(
  "the emitted bootstrap respects declarations without stopping live events (%s)",
  (attribute, expected) => {
    withPage(
      `<main><section ${attribute}><button _hk="0">click</button></section></main>`,
      page => {
        const { document, MouseEvent } = page.window;
        let parentClicks = 0;
        document.querySelector("main")!.addEventListener("click", () => parentClicks++);
        const event = new MouseEvent("click", { bubbles: true, cancelable: true });
        document.querySelector("button")!.dispatchEvent(event);
        expect(parentClicks).toBe(1);
        expect(event.defaultPrevented).toBe(false);
        expect(queued(page)).toHaveLength(expected);
      }
    );
  }
);

test("a matching outer declaration permits an event declined by its inner boundary", () => {
  withPage(
    '<main data-hydration-events="click"><section data-hydration-events="dblclick"><button _hk="0">click</button></section></main>',
    page => {
      const button = page.window.document.querySelector("button")!;
      button.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
      expect(queued(page)).toHaveLength(1);
      expect(queued(page)[0]![0]).toBe(button);
    }
  );
});

test("removing a completed outer declaration leaves the pending inner policy in charge", () => {
  withPage(
    '<main data-hydration-events="click"><section data-hydration-events="dblclick"><button _hk="0">click</button></section></main>',
    page => {
      const parent = page.window.document.querySelector("main")!;
      const button = parent.querySelector("button")!;
      let parentClicks = 0;
      parent.addEventListener("click", () => parentClicks++);
      button.click();
      expect(queued(page)).toHaveLength(1);
      parent.removeAttribute("data-hydration-events");
      button.click();
      expect(queued(page)).toHaveLength(1);
      expect(parentClicks).toBe(2);
    }
  );
});

test("composed ancestry permits an interested shadow host past a declining shadow child", () => {
  withPage('<main data-hydration-events="click"></main>', page => {
    const host = page.window.document.querySelector("main")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<section data-hydration-events="dblclick"><button _hk="0">click</button></section>';
    const button = shadow.querySelector("button")!;
    button.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, composed: true }));
    expect(queued(page)).toHaveLength(1);
    expect(queued(page)[0]![0]).toBe(button);
  });
});

test.each(["dblclick", "click"])("fallback ancestry handles text targets (%s)", policy => {
  withPage(
    `<main data-hydration-events="${policy}"><button _hk="0">click</button></main>`,
    page => {
      const button = page.window.document.querySelector("button")!;
      const event = new page.window.MouseEvent("click", { bubbles: true });
      Object.defineProperty(event, "composedPath", { value: undefined });
      button.firstChild!.dispatchEvent(event);
      expect(queued(page)).toHaveLength(policy === "click" ? 1 : 0);
      if (policy === "click") expect(queued(page)[0]![0]).toBe(button);
    }
  );
});

test.each(["generateHydrationScript", "HydrationScript"])(
  "%s supports a custom attribute name",
  emitter => {
    const options = { eventReplayAttribute: "data-custom-events" };
    const bootstrap =
      emitter === "HydrationScript"
        ? renderToString(() => <HydrationScript {...options} />)
        : generateHydrationScript(options);
    withPage(
      '<main data-custom-events="dblclick"><button _hk="0">click</button></main>',
      page => {
        page.window.document
          .querySelector("button")!
          .dispatchEvent(new page.window.MouseEvent("click", { bubbles: true }));
        expect(queued(page)).toHaveLength(0);
      },
      bootstrap
    );
  }
);

test("the attribute option cannot terminate its script or inject executable source", () => {
  const attribute = 'data-</script><script>window.injected=true</script>"\\';
  const bootstrap = generateHydrationScript({ eventReplayAttribute: attribute });
  expect(bootstrap).not.toContain(attribute);
  expect(bootstrap.match(/<script/g)).toHaveLength(1);
  withPage(
    '<button _hk="0">click</button>',
    page => {
      expect(Reflect.get(page.window, "injected")).toBeUndefined();
      page.window.document.querySelector("button")!.click();
      expect(queued(page)).toHaveLength(1);
    },
    bootstrap
  );
});

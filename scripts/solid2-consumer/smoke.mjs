import assert from "node:assert/strict";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM, VirtualConsole } from "jsdom";
import { transform } from "@solidjs/compiler";
import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "@solidjs/web";

const require = createRequire(import.meta.url);
const coreRequire = createRequire(require.resolve("solid-js"));
const webRequire = createRequire(require.resolve("@solidjs/web"));
assert.equal(
  await realpath(require.resolve("solid-js")),
  await realpath(webRequire.resolve("solid-js"))
);
assert.equal(
  await realpath(require.resolve("@solidjs/signals")),
  await realpath(coreRequire.resolve("@solidjs/signals"))
);
const source = await readFile("app.jsx", "utf8");
for (const [generate, filename] of [
  ["ssr", "app.server.js"],
  ["dom", "app.client.js"]
]) {
  const result = transform(source, { filename: "app.jsx", generate, hydratable: true, dev: false });
  assert(result.code, "official native RC15 compiler returned no code");
  await writeFile(filename, result.code);
}
await writeFile(
  "client.entry.js",
  transform(await readFile("client.jsx", "utf8"), {
    filename: "client.jsx",
    generate: "dom",
    hydratable: true,
    dev: false
  }).code
);
const { createApp } = await import("./app.server.js");
const App = createApp({ ready: () => false });
const html = renderToString(() => createComponent(App, {}));
assert.match(html, /packed RC15 context/);
assert(!html.includes("client fallback"));
for (const development of [false, true]) {
  const result = await build({
    entryPoints: ["client.entry.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "SolidAcceptance",
    platform: "browser",
    conditions: development ? ["development"] : [],
    define: { "process.env.NODE_ENV": JSON.stringify(development ? "development" : "production") }
  });
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(
    `<!doctype html><html><body>${generateHydrationScript()}<div id="app">${html}</div></body></html>`,
    { runScripts: "dangerously", url: "http://localhost/", virtualConsole }
  );
  try {
    const script = dom.window.document.createElement("script");
    script.textContent = result.outputFiles[0].text;
    dom.window.document.head.append(script);
    assert.deepEqual(errors, [], "packed browser entry emitted errors");
    assert.equal(
      typeof dom.window.SolidAcceptance?.verify,
      "function",
      "packed browser entry did not load"
    );
    await dom.window.SolidAcceptance.verify();
    assert.deepEqual(errors, [], "packed hydration emitted browser errors");
  } finally {
    dom.window.close();
  }
}
console.log(
  "Packed RC15 native compiler, shared identities, SSR DOM, late activation, real event replay, client fallback and cleanup accepted in production/development"
);

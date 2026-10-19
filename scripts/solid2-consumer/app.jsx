import { createContext, onCleanup, useContext } from "solid-js";
import { DeferredHydration } from "@solidjs/web";

const Label = createContext("missing context");
export function createApp(options) {
  function Child() {
    options.entered?.();
    onCleanup(() => {
      options.cleaned?.();
    });
    return <button onClick={() => options.clicked?.()}>{useContext(Label)}</button>;
  }
  return function App() {
    return (
      <Label value="packed RC15 context">
        <main>
          <DeferredHydration when={options.ready()} fallback={<p>client fallback</p>}>
            <Child />
          </DeferredHydration>
          <aside>following sibling</aside>
        </main>
      </Label>
    );
  };
}

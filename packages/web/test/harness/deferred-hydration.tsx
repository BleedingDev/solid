/** @jsxImportSource @solidjs/web */
import {
  createContext,
  createMemo,
  onCleanup,
  onSettled,
  useContext,
  type Accessor
} from "solid-js";
import { DeferredHydration, Errored, Loading } from "@solidjs/web";

const Label = createContext("missing context");

export function deferredApp(options: {
  ready: Accessor<boolean>;
  async?: boolean;
  nestedReady?: Accessor<boolean>;
  entered?: (name: string) => void;
  disposed?: () => void;
  settled?: () => void;
  clicked?: () => void;
  fail?: () => void;
  failed?: (error: unknown) => void;
}) {
  function Content() {
    options.entered?.("outer");
    const label = useContext(Label);
    onCleanup(() => {
      options.disposed?.();
    });
    options.fail?.();
    const data = options.async
      ? createMemo(async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return "async content";
        })
      : undefined;
    return (
      <section>
        <button onClick={() => options.clicked?.()}>{label}</button>
        {data && <em>{data()}</em>}
        <DeferredHydration when={options.nestedReady?.() ?? true}>
          <Nested />
        </DeferredHydration>
      </section>
    );
  }
  function Nested() {
    options.entered?.("nested");
    return <span>nested context: {useContext(Label)}</span>;
  }
  function App() {
    onSettled(() => {
      options.settled?.();
    });
    return (
      <Errored
        fallback={error => {
          options.failed?.(error());
          return <p>activation failed</p>;
        }}
      >
        <Label value="preserved context">
          <main>
            <DeferredHydration when={options.ready()} fallback={<p>client fallback</p>}>
              <Loading fallback={<p>native pending</p>}>
                <Content />
              </Loading>
            </DeferredHydration>
            <aside>following sibling</aside>
          </main>
        </Label>
      </Errored>
    );
  }
  return App;
}

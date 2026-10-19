import { DeferredHydration as CoreBoundary, createSignal, type Component } from "solid-js";
import { DeferredHydration, hydrate, type JSX } from "@solidjs/web";
import { createSignal as nativeSignal } from "@solidjs/signals";
const [ready] = nativeSignal(false);
const [other] = createSignal(false);
export const boundary: Component<{ when: boolean; fallback?: JSX.Element; children: JSX.Element }> =
  DeferredHydration;
export const coreBoundary: typeof DeferredHydration = CoreBoundary;
export function mount(root: HTMLElement) {
  return hydrate(() => boundary({ when: ready() || other(), children: "accepted" }), root);
}

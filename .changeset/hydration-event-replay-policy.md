---
"@solidjs/web": patch
---

Respect `data-hydration-events` allowlists when queuing events for hydration replay, while preserving live event propagation and default actions. Hosts can select another attribute through `eventReplayAttribute` on `HydrationScript` or `generateHydrationScript`.

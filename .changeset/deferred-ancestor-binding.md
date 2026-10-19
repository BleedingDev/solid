---
"solid-js": patch
---

Retain server-rendered content when a deferred hydration boundary activates before its browser module loads, including DOM bindings created outside the boundary. Resolve pending children without recreating their owners, then claim the original nodes when the module settles.

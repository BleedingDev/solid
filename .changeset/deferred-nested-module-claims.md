---
"solid-js": patch
---

Keep nested deferred hydration claims open through sequential client module loads and their DOM publication. Preserve the original server nodes, context and event handlers, and release each pending claim once when hydration completes or its owner is disposed.

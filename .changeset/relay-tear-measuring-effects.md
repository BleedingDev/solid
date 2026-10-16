---
"@solidjs/signals": patch
---

EFFECT_RELAY_TEAR no longer flags effects that measure layout. A boolean write that agrees with a boolean compute output is not taken as a copy (it fired an immediate "read the source instead" warning on `createEffect(open, () => setFlipped(measure()))`), and a non-copy tear escalates to a warning only with evidence the write is a function of the relay's input: three distinct compute outputs and no input that ever wrote two different values.

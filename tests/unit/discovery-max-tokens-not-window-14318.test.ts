import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeDiscoveredModels } from "@/lib/providerModels/modelDiscovery";

// Regression guard for #14318.
//
// `max_tokens` on a model record is the model's maximum OUTPUT length — the same
// meaning as the `max_tokens` request parameter — not its context window. The
// discovery rewrite that landed with #14159 added it to the window candidates, so
// a record carrying only `max_tokens` synced with `inputTokenLimit` equal to the
// output cap: a 128K model advertised a 4K window, the combo context-window
// filter skipped it for any prompt above 4K, and the compression heuristics sized
// prompts against the completion limit.
//
// Inverse of #3202 / #12858: those added window fields the normalizer must read;
// this pins a field it must NOT read.

test("#14318 a record with only max_tokens yields no inputTokenLimit", () => {
  const [model] = normalizeDiscoveredModels([
    { id: "vendor/output-cap-only", owned_by: "vendor", max_tokens: 4096 },
  ]);

  assert.equal(model.id, "vendor/output-cap-only");
  assert.equal(model.inputTokenLimit, undefined);
});

test("#14318 max_tokens never overrides the declared window", () => {
  const [model] = normalizeDiscoveredModels([
    { id: "vendor/both", context_length: 131072, max_tokens: 4096 },
  ]);

  assert.equal(model.inputTokenLimit, 131072);
});

test("#14318 max_context_window (the sibling field #14159 also added) still maps", () => {
  // The other field from the same change is a real window name (Lemonade-style
  // catalogs); dropping `max_tokens` must not take it down with it.
  const [model] = normalizeDiscoveredModels([{ id: "vendor/window", max_context_window: 32768 }]);

  assert.equal(model.inputTokenLimit, 32768);
});

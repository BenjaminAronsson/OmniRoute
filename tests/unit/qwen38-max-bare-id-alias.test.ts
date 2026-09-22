import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_SPECS } from "../../src/shared/constants/modelSpecs.ts";
import { resolveModelAlias } from "../../open-sse/services/modelDeprecation.ts";
import { resolveLifecycle } from "../../open-sse/handlers/chatCore/modelLifecyclePolicy.ts";
import { hasKnownProviderModel } from "../../open-sse/services/model.ts";

/**
 * Bare `qwen3.8-max` was an unroutable id: the model ships everywhere as
 * `qwen3.8-max-preview` (bailian-coding-plan, qoder, qwen-cloud-token-plan),
 * and nothing in the repo declared the short form. A client sending it therefore
 *
 *   1. missed MODEL_SPECS, so `getModelContextLimit()` fell through to the
 *      `default: 128000` in open-sse/services/contextManager.ts, and the chatCore
 *      preflight rejected any prompt above 128k with `context_length_exceeded`
 *      ("Input exceeds context window ... limit 128000") even though the real
 *      window is 1M; and
 *   2. would have been dispatched verbatim to the upstream, which only knows the
 *      `-preview` id.
 *
 * Both symptoms have one cause — the missing id — so the fix belongs in the
 * deprecation/rename alias map (`BUILT_IN_ALIASES`), which `resolveLifecycle()`
 * applies at open-sse/handlers/chatCore.ts:755, well before both the context
 * preflight and the upstream dispatch. A MODEL_SPECS `aliases` entry would have
 * fixed only (1): spec aliases resolve capabilities, never the dispatched id.
 *
 * SINCE THEN the premise has half-expired: `qwen-cloud-token-plan` and `qwen-web`
 * now list the BARE id and no longer carry `-preview` at all, so the rewrite that
 * rescues `qoder`/`bailian-coding-plan` would break those two. `resolveModelAlias`
 * already handles this — `hasKnownProviderModel` short-circuits the built-in alias
 * when the provider serves the id itself — which is why the alias map keeps the
 * entry rather than dropping it. The assertions below pin BOTH halves.
 */

const BARE = "qwen3.8-max";
const CANONICAL = "qwen3.8-max-preview";

test("bare qwen3.8-max resolves to the canonical -preview id", () => {
  assert.equal(resolveModelAlias(BARE), CANONICAL);
});

test("the canonical id is a no-op through the alias map (no double rewrite)", () => {
  assert.equal(resolveModelAlias(CANONICAL), CANONICAL);
});

test("the alias target carries the real 1M window, not the 128k fallback", () => {
  const spec = MODEL_SPECS[CANONICAL];
  assert.ok(spec, `MODEL_SPECS is missing ${CANONICAL}`);
  assert.equal(spec.contextWindow, 1_000_000);

  // This used to assert `MODEL_SPECS[BARE] === undefined`, guarding against a second
  // source of truth for what was then the SAME model under two ids. That premise
  // expired in #14181/#14242 (83a6e9a): opencode-go ships a GA `qwen3.8-max` that 401s
  // on the `-preview` id, so the two ids are now two DISTINCT models and the GA one
  // carries its own row instead of an `aliases: ["qwen3.8-max"]` entry on the preview.
  // What this file exists to prove still holds and is what we pin now: NEITHER id may
  // fall through to contextManager's `default: 128000`.
  const bareSpec = MODEL_SPECS[BARE];
  assert.ok(bareSpec, `MODEL_SPECS is missing the GA ${BARE} row added by #14181`);
  assert.equal(bareSpec.contextWindow, 1_000_000);
  // The preview spec must not re-declare the bare id as an alias — that is what would
  // let the GA row and the preview row silently collapse back into one.
  assert.ok(!(spec.aliases || []).includes(BARE));
});

// The catalogs have since split. `qwen-cloud-token-plan` now lists the BARE
// id and no longer carries `-preview`, so `resolveModelAlias`'s
// `hasKnownProviderModel` short-circuit deliberately leaves the id alone there —
// rewriting it to `-preview` would dispatch an id that provider no longer
// serves. The rewrite still has to happen on the providers that only know
// `-preview`. `qwen-web` served the BARE id too before its retirement
// (provenance HOLD, #11713); it no longer exists as a provider at all.
const SERVES_BARE = ["qwen-cloud-token-plan"];
const SERVES_PREVIEW = ["qoder", "bailian-coding-plan"];

// Pin the premise, not just the outcome: if a catalog flips, this fails first and says
// which provider moved, instead of leaving the lifecycle assertions below unexplained.
test("the catalog split the two ids across providers", () => {
  for (const provider of SERVES_BARE) {
    assert.equal(hasKnownProviderModel(provider, BARE), true, `${provider} must serve ${BARE}`);
  }
  for (const provider of SERVES_PREVIEW) {
    assert.equal(
      hasKnownProviderModel(provider, BARE),
      false,
      `${provider} must NOT serve ${BARE} — the rewrite below depends on it`
    );
  }
});

test("chatCore lifecycle rewrites the model only where the provider needs it", () => {
  for (const provider of SERVES_PREVIEW) {
    const [resolvedModel, effectiveModel, lifecycleError] = resolveLifecycle(provider, BARE);
    assert.equal(resolvedModel, CANONICAL, `resolvedModel for ${provider}`);
    assert.equal(effectiveModel, CANONICAL, `effectiveModel for ${provider}`);
    assert.equal(lifecycleError, null, `unexpected lifecycle rejection for ${provider}`);
  }
  for (const provider of SERVES_BARE) {
    const [resolvedModel, effectiveModel, lifecycleError] = resolveLifecycle(provider, BARE);
    assert.equal(resolvedModel, BARE, `resolvedModel for ${provider}`);
    assert.equal(effectiveModel, BARE, `effectiveModel for ${provider}`);
    assert.equal(lifecycleError, null, `unexpected lifecycle rejection for ${provider}`);
  }
});

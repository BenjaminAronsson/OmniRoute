import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-token-limit-catalog-"));
process.env.DATA_DIR = TEST_DATA_DIR;
// Every override write bumps the catalog cache generation, so each `getModel()` here is
// a COLD build of the full catalog. That path is bounded by CATALOG_BUILD_TIMEOUT_MS
// (#12627, 8s by default) and a cold tsx build already costs ~7s on an idle box — when
// the bound trips, `getUnifiedModelsResponse` answers a 503 `catalog_build_timeout`
// body with no `data` array and `getModel()` dies on `body.data.find` before any
// token-limit assertion runs. Build latency is not what this file covers, so pin it out
// of the way exactly like tests/unit/{9147-catalog-eventloop-yield,
// 12058-models-catalog-canonical-self-aliased,models-catalog-route}.test.ts do.
// Every assertion below is unchanged.
process.env.CATALOG_BUILD_TIMEOUT_MS = "120000";

const core = await import("../../src/lib/db/core.ts");
const contextOverrides = await import("../../src/lib/db/modelContextOverrides.ts");
const capabilityOverrides = await import("../../src/lib/db/modelCapabilityOverrides.ts");
const models = await import("../../src/lib/db/models.ts");
const providers = await import("../../src/lib/db/providers.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const overrideRoute = await import("../../src/app/api/model-capability-overrides/route.ts");

const TARGET = "openai/gpt-5.6";
const LIMITS = { context: 372000, input: 353400, output: 128000 };

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  catalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function getModel(target = TARGET) {
  const response = await catalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  return body.data.find((model) => model.id === target);
}

test("v1 model catalog projects effective context, input, and output overrides and invalidates on delete", async () => {
  assert.equal(contextOverrides.setModelContextOverride("openai", "gpt-5.6", LIMITS.context), true);
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_input_tokens", LIMITS.input),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_output_tokens", LIMITS.output),
    true
  );
  await providers.createProviderConnection({
    provider: "openai",
    authType: "api_key",
    name: "token-limit-catalog",
    apiKey: "sk-test",
  });

  const initial = await getModel();
  assert.ok(initial);
  assert.deepEqual(
    {
      context_length: initial.context_length,
      max_input_tokens: initial.max_input_tokens,
      max_output_tokens: initial.max_output_tokens,
    },
    {
      context_length: LIMITS.context,
      max_input_tokens: LIMITS.input,
      max_output_tokens: LIMITS.output,
    }
  );

  const sentinelOutput = 111111;
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(TARGET, "max_output_tokens", sentinelOutput),
    true
  );
  assert.equal((await getModel())?.max_output_tokens, sentinelOutput);
  assert.equal(
    capabilityOverrides.removeModelCapabilityOverride(TARGET, "max_output_tokens"),
    true
  );
  assert.notEqual((await getModel())?.max_output_tokens, sentinelOutput);
});

test("v1 model catalog projects a synced Codex context to both public aliases", async () => {
  const target = "codex/gpt-5.6-sol";
  const connection = await providers.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-token-limit-catalog",
    accessToken: "test-access-token",
  });
  assert.equal(typeof connection.id, "string");
  await models.replaceSyncedAvailableModelsForConnection("codex", connection.id as string, [
    {
      id: "gpt-5.6-sol",
      name: "GPT 5.6 Sol",
      source: "provider",
      supportedEndpoints: ["responses"],
      inputTokenLimit: 272000,
      outputTokenLimit: 128000,
    },
  ]);
  assert.equal(
    contextOverrides.setModelContextOverride("codex", "gpt-5.6-sol", LIMITS.context),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(target, "max_input_tokens", LIMITS.input),
    true
  );
  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(target, "max_output_tokens", LIMITS.output),
    true
  );

  for (const publicId of ["cx/gpt-5.6-sol", "codex/gpt-5.6-sol"]) {
    const projected = await getModel(publicId);
    assert.ok(projected, `expected ${publicId} in the public catalog`);
    assert.deepEqual(
      {
        context_length: projected.context_length,
        max_input_tokens: projected.max_input_tokens,
        max_output_tokens: projected.max_output_tokens,
      },
      {
        context_length: LIMITS.context,
        max_input_tokens: LIMITS.input,
        max_output_tokens: LIMITS.output,
      },
      `${publicId} must retain the persisted Codex token-limit overrides`
    );
  }

  // #14216 (4970f5f) gave the Codex GPT-5.6 image models their own PUBLIC catalog id
  // (`catalogId: "gpt-5.6-sol-image"`) because the callable upstream id collided with
  // the chat surface of the same model — the specialty row this block inspects used to
  // be published as `codex/gpt-5.6-sol` and is now `codex/gpt-5.6-sol-image`. The
  // callable id behind it is unchanged (`parseImageModel` maps the catalog id back to
  // `gpt-5.6-sol` for the hidden/supported checks), so what is asserted is the same row.
  const IMAGE_ROW = "codex/gpt-5.6-sol-image";
  const canonical = await getModel(IMAGE_ROW);
  assert.ok(canonical, `expected ${IMAGE_ROW} in the public catalog`);
  assert.equal(canonical.type, "image");
  assert.deepEqual(canonical.output_modalities, ["image"]);
  assert.ok(Array.isArray(canonical.supported_sizes));
  // The separation is the whole point of #14216: a context override targeting the CHAT
  // id must not bleed into the image row, which has no context window of its own.
  assert.equal(canonical.context_length, undefined);

  assert.equal(contextOverrides.removeModelContextOverride("codex", "gpt-5.6-sol"), true);
  assert.equal(
    (await getModel(IMAGE_ROW))?.context_length,
    undefined,
    "the specialty row must not inherit the synced chat context after override removal"
  );
  assert.equal((await getModel("cx/gpt-5.6-sol"))?.context_length, 272000);
});

test("v1 model catalog projects an exact raw-alias context override", async () => {
  const target = "github/claude-opus-4.5";
  assert.equal(contextOverrides.setModelContextOverride("github", "claude-opus-4.5", 333333), true);
  await providers.createProviderConnection({
    provider: "github",
    authType: "api_key",
    name: "raw-alias-token-limit-catalog",
    apiKey: "ghp-test",
  });

  assert.equal(
    (await getModel(target))?.context_length,
    333333,
    "the catalog entry keeps its raw alias and must project that exact override"
  );
});

test("v1 model catalog projects a compatible provider prefix override stored under its node id", async () => {
  const nodeId = "openai-compatible-chat-context-override";
  const prefix = "wawapi-openai";
  const modelId = "grok-4.6";
  const contextWindow = 500000;
  await providers.createProviderNode({
    id: nodeId,
    type: "openai-compatible",
    prefix,
    name: "WawAPI (OpenAI)",
    apiType: "chat",
    baseUrl: "https://example.com/v1",
  });
  const connection = await providers.createProviderConnection({
    provider: nodeId,
    authType: "api_key",
    name: "compatible-provider-token-limit-catalog",
    apiKey: "sk-test",
  });
  assert.equal(typeof connection.id, "string");
  await models.replaceSyncedAvailableModelsForConnection(nodeId, connection.id as string, [
    { id: modelId, name: modelId, source: "imported" },
  ]);

  const patch = await overrideRoute.PATCH(
    new Request("http://localhost/api/model-capability-overrides", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: `${prefix}/${modelId}`,
        key: "context_length",
        value: contextWindow,
      }),
    })
  );
  assert.equal(patch.status, 200);
  assert.equal(
    contextOverrides.getModelContextOverrideRecord(nodeId, modelId)?.realContext,
    contextWindow,
    "the public prefix target must persist under the internal provider node id"
  );

  assert.equal(
    (await getModel(`${prefix}/${modelId}`))?.context_length,
    contextWindow,
    "the public catalog row must read the override stored under the internal provider node id"
  );
});

test("v1 model catalog overlays same-id custom metadata before final overrides", async () => {
  const providerId = "openai-compatible-chat-custom-precedence";
  const prefix = "custom-precedence";
  const modelId = "shared-model";
  await providers.createProviderNode({
    id: providerId,
    type: "openai-compatible",
    prefix,
    name: "Custom Precedence",
    apiType: "chat",
    baseUrl: "https://example.com/v1",
  });
  const connection = await providers.createProviderConnection({
    provider: providerId,
    authType: "api_key",
    name: "custom-precedence-catalog",
    apiKey: "sk-test",
  });
  await models.replaceSyncedAvailableModelsForConnection(providerId, connection.id as string, [
    {
      id: modelId,
      name: "Discovered name",
      source: "imported",
      inputTokenLimit: 128000,
      supportsVision: true,
    },
  ]);
  await models.addCustomModel(
    providerId,
    modelId,
    "Operator name",
    "manual",
    "chat-completions",
    ["chat"],
    undefined,
    { outputTokenLimit: 32000 },
    false
  );

  const customProjected = await getModel(`${prefix}/${modelId}`);
  assert.ok(customProjected);
  assert.equal(customProjected.max_output_tokens, 32000);

  assert.equal(
    capabilityOverrides.setModelCapabilityOverride(
      `${prefix}/${modelId}`,
      "max_output_tokens",
      64000
    ),
    true
  );
  assert.equal(contextOverrides.setModelContextOverride(providerId, modelId, 500000), true);

  const projected = await getModel(`${prefix}/${modelId}`);
  assert.ok(projected);
  assert.equal(projected.name, "Operator name");
  assert.equal(projected.context_length, 500000);
  assert.equal(projected.max_output_tokens, 64000);
  assert.equal((projected.capabilities as Record<string, unknown>)?.vision, false);
  assert.deepEqual(projected.input_modalities, ["text"]);
});

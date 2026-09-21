/**
 * Repro probe for issue #13931 — the combo builder emits `qualifiedModel`
 * using the raw connection/provider-node id instead of the node's routing
 * `prefix`, so a combo built from the dashboard for a custom OpenAI-compatible
 * *embeddings* connection is unresolvable by /v1/embeddings (which only
 * matches a static registry id or a `provider_nodes.prefix`, never a raw
 * node/connection id).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-13931-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const { getComboBuilderOptions } = await import("../../src/lib/combos/builderOptions.ts");

const NODE_ID = "openai-compatible-embeddings-conn-9c1f0a3b8e2d4c56";
const NODE_PREFIX = "sf";
const MODEL_ID = "BAAI/bge-m3";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("#13931: combo builder qualifiedModel for a custom embeddings connection uses the node prefix, not the raw connection/provider id", async () => {
  await providersDb.createProviderNode({
    id: NODE_ID,
    type: "openai-compatible",
    name: "SiliconFlow embeddings (probe)",
    prefix: NODE_PREFIX,
    apiType: "embeddings",
    baseUrl: "https://api.siliconflow.cn/v1",
  });

  const connection = await providersDb.createProviderConnection({
    provider: NODE_ID,
    authType: "apikey",
    name: "sf-embeddings-conn",
    apiKey: "sk-test",
    isActive: true,
    testStatus: "active",
    providerSpecificData: { baseUrl: "https://api.siliconflow.cn/v1" },
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection(
    NODE_ID,
    (connection as { id: string }).id,
    [{ id: MODEL_ID, name: "BAAI bge-m3", source: "imported", supportedEndpoints: ["embeddings"] }]
  );

  const payload = await getComboBuilderOptions();
  const provider = payload.providers.find((p) => p.providerId === NODE_ID);
  assert.ok(provider, "the custom embeddings provider must appear in the combo builder");

  const model = provider.models.find((m) => m.id === MODEL_ID);
  assert.ok(model, `model "${MODEL_ID}" must be listed under the custom embeddings provider`);

  const expectedQualifiedModel = `${NODE_PREFIX}/${MODEL_ID}`;
  assert.equal(
    model!.qualifiedModel,
    expectedQualifiedModel,
    `combo builder must emit qualifiedModel "${expectedQualifiedModel}" (node prefix) so ` +
      `/v1/embeddings can resolve it — got "${model!.qualifiedModel}"`
  );
});

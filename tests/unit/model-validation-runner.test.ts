import "./_helpers/modelValidationEnvironment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";
import { getCustomModels } from "../../src/lib/db/models.ts";
import { createValidationSnapshot } from "../../src/lib/db/validatedModels.ts";
import { getProviderCredentials } from "../../src/sse/services/auth.ts";
import { createProofRunner } from "../../src/lib/modelValidation/runner.ts";

test("pending credential selection can abort and cannot dispatch when it later resolves", async () => {
  let dispatched = 0;
  globalThis.fetch = async () => {
    dispatched++;
    throw new Error("unexpected dispatch");
  };
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fake-pending-proof",
    isActive: true,
  });
  const input = {
    provider: "openai",
    modelId: "pending-proof",
    connectionId: String(connection.id),
    allowInference: true as const,
    apiFormat: "chat-completions" as const,
  };
  const credentials = await getProviderCredentials(
    input.provider,
    null,
    [input.connectionId],
    input.modelId
  );
  let release: (value: typeof credentials) => void;
  let entered: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<typeof credentials>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  const run = await createProofRunner(
    input,
    createValidationSnapshot(input),
    controller.signal,
    async () => {
      entered();
      return pending;
    }
  );
  const result = run([{ role: "user", content: "validation fixture" }], false);
  await started;
  controller.abort(new Error("test pre-dispatch abort"));
  await assert.rejects(() => result, /pre-dispatch abort/);
  release(credentials);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatched, 0);
  assert.equal((await getCustomModels(input.provider)).length, 0);
});

test("stale selected endpoint metadata is rejected against the fresh connection snapshot", async () => {
  const connection = await createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "fake-stale-endpoint",
    isActive: true,
    providerSpecificData: { baseUrl: "https://old.invalid/v1" },
  });
  const input = {
    provider: "openai",
    modelId: "stale-endpoint-proof",
    connectionId: String(connection.id),
    allowInference: true as const,
    apiFormat: "chat-completions" as const,
  };
  const stale = await getProviderCredentials(
    input.provider,
    null,
    [input.connectionId],
    input.modelId
  );
  await updateProviderConnection(input.connectionId, {
    providerSpecificData: { baseUrl: "https://new.invalid/v1" },
  });
  const run = await createProofRunner(
    input,
    createValidationSnapshot(input),
    new AbortController().signal,
    async () => stale
  );
  await assert.rejects(() => run([{ role: "user", content: "validation fixture" }], false), {
    code: "VALIDATION_CONFIG_CHANGED",
  });
  assert.equal((await getCustomModels(input.provider)).length, 0);
});

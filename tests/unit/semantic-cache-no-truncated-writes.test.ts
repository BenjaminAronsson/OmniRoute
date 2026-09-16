// Regression: a truncated upstream response (finish_reason "length") must never be
// written to the semantic cache. A partial completion cached under a temperature:0
// signature is served to every subsequent identical request, permanently returning
// a mid-sentence answer that no retry can clear (only a cache flush).
// Observed live on OmniRoute against github/gemini-3.5-flash: temperature:0 returned
// finish_reason "length" at 93 completion tokens on every call, while the same request
// with x-omniroute-no-cache:true returned a complete 239-token response. (#12885)
import { test } from "node:test";
import assert from "node:assert/strict";

const { storeSemanticCacheResponse } =
  await import("../../open-sse/handlers/chatCore/semanticCacheStore.ts");
const { storeStreamingSemanticCacheResponse } =
  await import("../../open-sse/handlers/chatCore/streamingSemanticCacheStore.ts");
// Real truncation predicate — only the cache backend and the temperature/size
// gates are stubbed, so these tests exercise the actual detection logic.
const { isTruncatedCompletion } = await import("../../src/lib/semanticCache.ts");

function deps(stored: unknown[]) {
  return {
    isCacheableForWrite: () => true,
    isTruncatedCompletion,
    isSmallEnoughForSemanticCache: () => true,
    generateSignature: () => "sig",
    setCachedResponse: (_s: unknown, _m: string, r: unknown, t: number) => stored.push({ r, t }),
  } as never;
}

test("does not cache a non-streaming response truncated by max_tokens", () => {
  const stored: unknown[] = [];
  storeSemanticCacheResponse(
    {
      enabled: true,
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      translatedResponse: {
        choices: [{ finish_reason: "length", message: { content: "partial answ" } }],
      },
      model: "gemini-3.5-flash",
      usage: { prompt_tokens: 10, completion_tokens: 93 },
    },
    deps(stored)
  );
  assert.equal(stored.length, 0, "truncated response must not be cached");
});

test("still caches a complete non-streaming response", () => {
  const stored: unknown[] = [];
  storeSemanticCacheResponse(
    {
      enabled: true,
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      translatedResponse: {
        choices: [{ finish_reason: "stop", message: { content: "complete answer" } }],
      },
      model: "gemini-3.5-flash",
      usage: { prompt_tokens: 10, completion_tokens: 239 },
    },
    deps(stored)
  );
  assert.equal(stored.length, 1, "complete response must still be cached");
});

test("does not cache a streaming response truncated by max_tokens", () => {
  const stored: unknown[] = [];
  storeStreamingSemanticCacheResponse(
    {
      enabled: true,
      streamStatus: 200,
      streamResponseBody: {
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      },
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      model: "gemini-3.5-flash",
      streamUsage: { prompt_tokens: 10, completion_tokens: 93 },
    },
    deps(stored)
  );
  assert.equal(stored.length, 0, "truncated streaming response must not be cached");
});

test("still caches a complete streaming response", () => {
  const stored: unknown[] = [];
  storeStreamingSemanticCacheResponse(
    {
      enabled: true,
      streamStatus: 200,
      streamResponseBody: {
        choices: [{ finish_reason: "stop", message: { content: "complete" } }],
      },
      body: { messages: [{ role: "user", content: "hi" }], temperature: 0 },
      headers: undefined,
      model: "gemini-3.5-flash",
      streamUsage: { prompt_tokens: 10, completion_tokens: 239 },
    },
    deps(stored)
  );
  assert.equal(stored.length, 1, "complete streaming response must still be cached");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-issue-14060-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getSettings() degrades to defaults (does not throw) when only the key_value table's page is corrupted", async () => {
  const db = core.getDbInstance();
  const dbPath = (db as { name?: string }).name;
  assert.ok(typeof dbPath === "string" && dbPath.length > 0, "expected a file-backed db path");

  db.prepare(
    "INSERT INTO key_value (namespace, key, value) VALUES ('settings', 'requireLogin', 'true')"
  ).run();

  const pageSize = (db.pragma("page_size") as Array<{ page_size: number }>)[0].page_size;
  const rootPageRow = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'key_value'")
    .get() as { rootpage: number } | undefined;
  assert.ok(rootPageRow?.rootpage, "expected to find key_value's rootpage in sqlite_master");
  const rootPage = rootPageRow!.rootpage;

  core.resetDbInstance();

  const buf = fs.readFileSync(dbPath as string);
  const pageStart = (rootPage - 1) * pageSize;
  for (let i = pageStart; i < Math.min(buf.length, pageStart + pageSize); i++) {
    buf[i] = 0xff;
  }
  fs.writeFileSync(dbPath as string, buf);

  const reopened = core.getDbInstance();
  const bootHealthy = !!reopened
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_connections'"
    )
    .get();
  assert.equal(bootHealthy, true, "expected the boot probe's own tables to remain readable");
  core.resetDbInstance();

  const settings = await settingsDb.getSettings();

  assert.equal(
    typeof settings,
    "object",
    "expected getSettings() to degrade to a defaults object instead of throwing"
  );
  assert.equal(
    settings.requireLogin,
    true,
    "expected the built-in default for requireLogin (row could not be read from the corrupted table)"
  );
});

/**
 * Regression test for #14487 — the opencode pool-strain marker (read from a
 * fixed /tmp path, overridable via OPENCODE_POOL_STRAIN_MARKER_PATH) was
 * trusted with no ownership/mode check, so ANY local user could plant a
 * world-writable marker and force a park decision. Also verifies the default
 * path no longer lives directly under the shared, world-writable /tmp.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MARKER_ENV = "OPENCODE_POOL_STRAIN_MARKER_PATH";
const DATA_DIR_ENV = "DATA_DIR";

describe("opencode pool-strain marker trust (#14487)", () => {
  let priorMarker: string | undefined;
  let priorDataDir: string | undefined;
  let tmpDataDir: string;

  beforeEach(() => {
    priorMarker = process.env[MARKER_ENV];
    priorDataDir = process.env[DATA_DIR_ENV];
    delete process.env[MARKER_ENV];
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-marker-datadir-"));
    process.env[DATA_DIR_ENV] = tmpDataDir;
  });

  afterEach(() => {
    if (priorMarker === undefined) delete process.env[MARKER_ENV];
    else process.env[MARKER_ENV] = priorMarker;
    if (priorDataDir === undefined) delete process.env[DATA_DIR_ENV];
    else process.env[DATA_DIR_ENV] = priorDataDir;
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it("does not default the marker path directly under the world-writable /tmp root", async () => {
    const { poolStrainMarkerPath } = await import("../../open-sse/executors/opencodeParkResume.ts");
    const resolved = poolStrainMarkerPath();
    assert.notEqual(
      resolved,
      "/tmp/opencode-pool-strain.json",
      "default marker path must not be the fixed, well-known /tmp location any local user can pre-create"
    );
  });

  it("honors an explicit OPENCODE_POOL_STRAIN_MARKER_PATH override", async () => {
    process.env[MARKER_ENV] = "/custom/path/marker.json";
    const { poolStrainMarkerPath } = await import("../../open-sse/executors/opencodeParkResume.ts");
    assert.equal(poolStrainMarkerPath(), "/custom/path/marker.json");
  });

  it("rejects a world-writable marker even though it is fresh and well-formed", async () => {
    const { readPoolStrainMarker } = await import("../../open-sse/executors/opencodeParkResume.ts");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strain-marker-"));
    const markerPath = path.join(dir, "opencode-pool-strain.json");
    fs.writeFileSync(markerPath, JSON.stringify({ since: Date.now(), ttl_s: 300 }));
    fs.chmodSync(markerPath, 0o666); // group+other writable: any local user could have planted this

    const result = await readPoolStrainMarker(markerPath);

    assert.equal(
      result.fresh,
      false,
      "a world/group-writable pool-strain marker must never be trusted as fresh"
    );

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still trusts an otherwise-fresh marker that is owner-only writable", async () => {
    const { readPoolStrainMarker } = await import("../../open-sse/executors/opencodeParkResume.ts");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "strain-marker-ok-"));
    const markerPath = path.join(dir, "opencode-pool-strain.json");
    fs.writeFileSync(markerPath, JSON.stringify({ since: Date.now(), ttl_s: 300 }));
    fs.chmodSync(markerPath, 0o600); // owner read/write only — legitimate marker

    const result = await readPoolStrainMarker(markerPath);

    assert.equal(result.fresh, true, "an owner-locked-down fresh marker must still be trusted");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

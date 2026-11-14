import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("staging probe server source is intentionally isolated from production worker", async () => {
  const source = await readFile(new URL("../src/staging-http.js", import.meta.url), "utf8");
  assert.match(source, /aiva-staging-http-probe/);
  assert.match(source, /aiva_staging_probe/);
  assert.doesNotMatch(source, /LIVE_RATES_API_KEY|socket\\.io-client|SUPABASE_SERVICE_ROLE_KEY/);
});

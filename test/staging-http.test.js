import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("staging probe server stays isolated from production credentials and worker", async () => {
  const source = await readFile(new URL("../src/staging-http.js", import.meta.url), "utf8");
  assert.match(source, /aiva-staging-http-probe/);
  assert.match(source, /aiva_staging_probe/);
  assert.doesNotMatch(source, /LIVE_RATES_API_KEY|socket\\.io-client|SUPABASE_SERVICE_ROLE_KEY/);
});

test("staging database probe only accepts GET and performs a bounded read", async () => {
  const source = await readFile(new URL("../src/staging-http.js", import.meta.url), "utf8");
  assert.match(source, /req\.method !== "GET"/);
  assert.match(source, /\/rest\/v1\/aiva_staging_probe\?select=id&limit=1/);
  assert.doesNotMatch(source, /\.insert\s*\(|\.upsert\s*\(|\.update\s*\(|\.delete\s*\(/i);
  assert.doesNotMatch(source, /market_quotes|LIVE_RATES_API_KEY|SUPABASE_SERVICE_ROLE_KEY/);
});

test("browser endurance test remains limited to 16 and 32 read-only workers", async () => {
  const source = await readFile(new URL("../src/staging-browser.js", import.meta.url), "utf8");
  assert.match(source, /var levels = \[16, 32\]/);
  assert.match(source, /var requestsPerLevel = 1000/);
  assert.match(source, /var timeoutMs = 10000/);
  assert.match(source, /\/test\/db-read/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|LIVE_RATES_API_KEY|market_quotes/);
});

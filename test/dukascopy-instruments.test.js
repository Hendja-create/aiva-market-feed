import test from "node:test";
import assert from "node:assert/strict";
import { resolveDukascopyInstrument } from "../src/dukascopy-history.js";

test("resolves the built-in index and gold instrument IDs", () => {
  assert.equal(resolveDukascopyInstrument("XAUUSD"), "xauusd");
  assert.equal(resolveDukascopyInstrument("US30"), "usa30idxusd");
  assert.equal(resolveDukascopyInstrument("NAS100"), "usatechidxusd");
  assert.equal(resolveDukascopyInstrument("SP500"), "usa500idxusd");
  assert.equal(resolveDukascopyInstrument("GER40"), "deuidxeur");
  assert.equal(resolveDukascopyInstrument("JP225"), "jpnidxjpy");
});

test("normalizes symbols and supports configured instrument overrides", () => {
  const previous = process.env.DUKASCOPY_INSTRUMENT_MAP;
  process.env.DUKASCOPY_INSTRUMENT_MAP = JSON.stringify({ NAS100: "customindexid" });
  try {
    assert.equal(resolveDukascopyInstrument("nas100"), "customindexid");
    assert.equal(resolveDukascopyInstrument("EURUSD"), "eurusd");
  } finally {
    if (previous === undefined) delete process.env.DUKASCOPY_INSTRUMENT_MAP;
    else process.env.DUKASCOPY_INSTRUMENT_MAP = previous;
  }
});

test("rejects malformed instrument mapping configuration", () => {
  const previous = process.env.DUKASCOPY_INSTRUMENT_MAP;
  process.env.DUKASCOPY_INSTRUMENT_MAP = "{invalid";
  try {
    assert.throws(() => resolveDukascopyInstrument("US30"), /must be valid JSON/);
  } finally {
    if (previous === undefined) delete process.env.DUKASCOPY_INSTRUMENT_MAP;
    else process.env.DUKASCOPY_INSTRUMENT_MAP = previous;
  }
});

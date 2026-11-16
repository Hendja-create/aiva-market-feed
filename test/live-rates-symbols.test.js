import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLiveRatesSymbol, mapLiveRatesSymbol } from "../src/live-rates-symbols.js";

test("normalizes provider instrument codes", () => {
  assert.equal(normalizeLiveRatesSymbol("GERMANY_40"), "GERMANY40");
  assert.equal(normalizeLiveRatesSymbol("JAPAN_225"), "JAPAN225");
  assert.equal(normalizeLiveRatesSymbol("SPX500"), "SPX500");
});

test("maps Live-Rates index aliases to AIVA symbols", () => {
  assert.equal(mapLiveRatesSymbol("GERMANY_40"), "GER40");
  assert.equal(mapLiveRatesSymbol("DE40"), "GER40");
  assert.equal(mapLiveRatesSymbol("JAPAN_225"), "JP225");
  assert.equal(mapLiveRatesSymbol("JPN225"), "JP225");
  assert.equal(mapLiveRatesSymbol("SPX500"), "SP500");
  assert.equal(mapLiveRatesSymbol("NAS100"), "NAS100");
});

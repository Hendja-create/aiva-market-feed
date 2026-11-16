const PROVIDER_TO_CANONICAL = Object.freeze({
  SPX500: "SP500",
  GERMANY40: "GER40",
  DE40: "GER40",
  DAX40: "GER40",
  JAPAN225: "JP225",
  JPN225: "JP225",
  NI225: "JP225",
  NIKKEI225: "JP225"
});

export function normalizeLiveRatesSymbol(value) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function mapLiveRatesSymbol(value) {
  const normalized = normalizeLiveRatesSymbol(value);
  return PROVIDER_TO_CANONICAL[normalized] || normalized;
}

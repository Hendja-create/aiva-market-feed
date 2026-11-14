export function isLiveRatesConfigured(env = process.env) {
  return Boolean(String(env.LIVE_RATES_API_KEY ?? "").trim());
}

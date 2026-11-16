export function shouldPersistHistoricalTick(lastPersistedAt, now, minIntervalMs) {
  if (!Number.isFinite(now) || !Number.isFinite(minIntervalMs) || minIntervalMs < 0) return false;
  if (lastPersistedAt === undefined || lastPersistedAt === null) return true;
  return now - lastPersistedAt >= minIntervalMs;
}

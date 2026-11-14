FROM node:22-alpine
WORKDIR /app
COPY src/monte-carlo.js ./src/monte-carlo.js
COPY src/monte-carlo-worker.js ./src/monte-carlo-worker.js
COPY src/monte-carlo-worker-pool.js ./src/monte-carlo-worker-pool.js
COPY test/monte-carlo.test.js ./test/monte-carlo.test.js
COPY test/monte-carlo-worker-pool.test.js ./test/monte-carlo-worker-pool.test.js
COPY scripts/railway-worker-pool-benchmark.js ./scripts/railway-worker-pool-benchmark.js
ENV NODE_ENV=production
CMD ["sh", "-c", "node --test test/monte-carlo.test.js test/monte-carlo-worker-pool.test.js && node scripts/railway-worker-pool-benchmark.js"]

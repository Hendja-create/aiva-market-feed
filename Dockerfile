FROM node:22-alpine
WORKDIR /app
COPY src/monte-carlo.js ./src/monte-carlo.js
COPY scripts/railway-load-benchmark.js ./scripts/railway-load-benchmark.js
ENV NODE_ENV=production
CMD ["node", "scripts/railway-load-benchmark.js"]

FROM node:22-alpine
WORKDIR /app
COPY src/monte-carlo.js ./src/monte-carlo.js
COPY scripts/railway-benchmark.js ./scripts/railway-benchmark.js
ENV NODE_ENV=production
CMD ["node", "scripts/railway-benchmark.js"]

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY test ./test
RUN node --check src/staging-browser.js && node --test test/staging-http.test.js
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]

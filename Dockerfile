FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV API_INTERNAL_URL=http://api:3001
RUN npm run build:api && npm run build
FROM node:24-bookworm-slim AS mock-runtime
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000 3001
# API NODE_ENV=production is deliberately refused until real auth is implemented.
CMD ["node", "dist/apps/api/src/main.js"]

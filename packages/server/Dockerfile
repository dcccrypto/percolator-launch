FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10

# Copy workspace config
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./

# Copy only the packages we need
COPY packages/core/package.json packages/core/
COPY packages/core/tsup.config.ts packages/core/
COPY packages/core/src/ packages/core/src/
COPY packages/server/package.json packages/server/
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src/ packages/server/src/

# Install deps (only for core + server, skip native modules)
RUN pnpm install --filter @percolator/core --filter @percolator/server --ignore-scripts --no-optional

# Build core first (server depends on it)
RUN cd packages/core && npx tsup

# Build server
RUN cd packages/server && npx tsc

# --- Runtime ---
FROM node:22-slim

WORKDIR /app

RUN npm install -g pnpm@10

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/core/node_modules/ packages/core/node_modules/
COPY --from=builder /app/packages/server/node_modules/ packages/server/node_modules/

EXPOSE 3001

CMD ["node", "packages/server/dist/index.js"]

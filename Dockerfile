FROM node:22-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@10

# Copy workspace config + lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Copy package.jsons for workspace resolution
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/

# Install deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/

# Build core then server
RUN cd packages/core && npx tsc --build
RUN cd packages/server && npx tsc

# Production stage
FROM node:22-slim

WORKDIR /app

RUN npm install -g pnpm@10

COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/core/dist packages/core/dist/
COPY --from=builder /app/packages/server/dist packages/server/dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/packages/core/node_modules packages/core/node_modules/ 
COPY --from=builder /app/packages/server/node_modules packages/server/node_modules/

EXPOSE 3001

USER node

CMD ["node", "packages/server/dist/index.js"]

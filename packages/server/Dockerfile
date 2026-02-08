FROM node:20-slim

WORKDIR /app

# Copy root workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy core package
COPY packages/core/package.json packages/core/
COPY packages/core/dist/ packages/core/dist/
COPY packages/core/tsup.config.ts packages/core/

# Copy server package
COPY packages/server/package.json packages/server/
COPY packages/server/tsconfig.json packages/server/
COPY packages/server/src/ packages/server/src/

# Install pnpm and dependencies
RUN npm install -g pnpm@10 && \
    pnpm install --frozen-lockfile --filter @percolator/server... && \
    cd packages/server && pnpm run build

WORKDIR /app/packages/server

EXPOSE 3001

CMD ["node", "dist/index.js"]

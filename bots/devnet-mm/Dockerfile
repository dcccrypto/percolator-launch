# PERC-377: Percolator Devnet Market-Making Bots
FROM node:22-slim AS base
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy workspace files
COPY package.json pnpm-lock.yaml* ./
COPY packages/core/package.json packages/core/
COPY bots/devnet-mm/package.json bots/devnet-mm/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source
COPY packages/core/ packages/core/
COPY bots/devnet-mm/ bots/devnet-mm/

WORKDIR /app/bots/devnet-mm

EXPOSE 18820

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:18820/health || exit 1

# Default: run both filler + maker
ENV BOT_MODE=both
ENV HEALTH_PORT=18820

CMD ["npx", "tsx", "src/index.ts"]

# PERC-377: Percolator Devnet Market-Making Bots
FROM node:22-slim AS base
WORKDIR /app

# Install pnpm + curl for healthcheck
RUN corepack enable && corepack prepare pnpm@9 --activate && apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r botuser && useradd -r -g botuser -d /app botuser

# Copy workspace config + all package.json files needed for install
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY bots/devnet-mm/package.json bots/devnet-mm/

# Install dependencies (workspace: links resolved via pnpm-workspace.yaml)
RUN pnpm install --frozen-lockfile --filter @percolator/devnet-mm...

# Copy source for SDK + bot
COPY packages/core/ packages/core/
COPY bots/devnet-mm/ bots/devnet-mm/

# Set ownership and switch to non-root
RUN chown -R botuser:botuser /app
USER botuser

WORKDIR /app/bots/devnet-mm

EXPOSE 18820

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:${HEALTH_PORT:-18820}/health || exit 1

# Default: run both filler + maker; bind health to 0.0.0.0 in container
ENV BOT_MODE=both
ENV HEALTH_PORT=18820
ENV HEALTH_HOST=0.0.0.0

CMD ["npx", "tsx", "src/index.ts"]

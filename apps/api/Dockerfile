# API + provider de WhatsApp (sessões).
# As sessões e mídias ficam em volumes: /app/data/sessions e /app/data/media.
FROM node:22-slim AS base
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/whatsapp/package.json packages/whatsapp/
RUN pnpm install --frozen-lockfile --filter @zapdesk/api... --filter @zapdesk/database...

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @zapdesk/database generate
RUN mkdir -p /app/data/sessions /app/data/media

EXPOSE 4000
# Aplica migrations pendentes e sobe a API.
CMD ["sh", "-c", "pnpm --filter @zapdesk/database migrate:deploy && pnpm --filter @zapdesk/api start"]

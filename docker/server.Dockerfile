# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @pdfclaudeassistant/server... --filter @pdfclaudeassistant/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
COPY apps/server apps/server
# The server also serves the web app (WEB_DIR), so one container is enough behind a proxy.
RUN pnpm --filter @pdfclaudeassistant/web build
RUN pnpm --filter @pdfclaudeassistant/server build \
 && pnpm --filter @pdfclaudeassistant/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/ \
 && cp -r apps/web/dist /out/public

FROM node:22-bookworm-slim AS runtime
# ocrmypdf/tesseract: OCR for scanned PDFs. poppler-utils: page rendering.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ocrmypdf tesseract-ocr-spa tesseract-ocr-eng poppler-utils ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# Claude Code CLI, so `docker compose exec server claude` can run /login (SPEC 6.2).
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    WEB_DIR=/app/public \
    CLAUDE_CONFIG_DIR=/data/claude-home
WORKDIR /app
COPY --from=build /out ./
RUN mkdir -p /data/claude-home && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
CMD ["node", "--enable-source-maps", "dist/main.js"]

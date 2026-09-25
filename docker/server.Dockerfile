# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @pdfclaudeassistant/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @pdfclaudeassistant/server build \
 && pnpm --filter @pdfclaudeassistant/server deploy --prod --legacy /out \
 && cp -r apps/server/dist apps/server/drizzle /out/

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

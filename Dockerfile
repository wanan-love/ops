# syntax=docker/dockerfile:1
# OpenPrintShare — 单容器同时运行 Web 控制台(:3000) 与 ops-host(:3001 REST / :3002 Realtime)
# 镜像发布：ghcr.io/wanan-love/ops（GitHub Actions，Release 触发）

FROM oven/bun:1 AS base
WORKDIR /app

# ---- 安装依赖 ----
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY mini-services/ops-host/package.json mini-services/ops-host/bun.lock* ./mini-services/ops-host/
RUN cd mini-services/ops-host && bun install

# ---- 构建 Web（Next.js standalone）----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/mini-services/ops-host/node_modules ./mini-services/ops-host/node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

# ---- 运行镜像 ----
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV OPS_DATA_DIR=/app/data/mock-printer

RUN groupadd -r ops && useradd -r -g ops ops

COPY --from=builder --chown=ops:ops /app/.next/standalone ./
COPY --from=builder --chown=ops:ops /app/.next/static ./.next/static
COPY --from=builder --chown=ops:ops /app/public ./public
COPY --from=builder --chown=ops:ops /app/mini-services/ops-host ./mini-services/ops-host
COPY --from=builder --chown=ops:ops /app/scripts/container-start.sh ./scripts/container-start.sh
RUN chmod +x ./scripts/container-start.sh && mkdir -p /app/data/mock-printer && chown -R ops:ops /app/data

USER ops
EXPOSE 3000 3001 3002
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e "fetch('http://localhost:3001/api/system/info').then(r=>{if(!r.ok)throw 1})" || exit 1

ENTRYPOINT ["./scripts/container-start.sh"]

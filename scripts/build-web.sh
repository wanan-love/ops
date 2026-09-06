#!/usr/bin/env bash
# build-web.sh — Web 控制台静态导出 + Host 嵌入清单生成
# 产物：out/（Next 静态导出，直连模式 NEXT_PUBLIC_OPS_DIRECT=1）
#       mini-services/ops-host/src/generated/web-embed.ts（资产嵌入清单）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

log "Web 控制台静态导出（Next.js 16 → out/，直连模式）"

cd "$OPS_ROOT"
[ -d node_modules ] || { log "安装根项目依赖…"; bun install; }

OPS_EXPORT=1 bunx next build

[ -f out/index.html ] || fail "静态导出失败：out/index.html 不存在"
log "导出完成：$(du -sh out/ | cut -f1)，$(find out -type f | wc -l) 个文件"

log "生成 Host 资产嵌入清单（单文件可执行内嵌 Web）"
cd "$HOST_ROOT"
bun "$OPS_ROOT/scripts/build-web-embed.ts" "$OPS_ROOT/out"

log "build-web 完成"

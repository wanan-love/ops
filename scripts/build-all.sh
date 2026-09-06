#!/usr/bin/env bash
# build-all.sh — 全平台统一构建入口
# 产物统一输出 dist/{windows,macos,linux,android,ios}/，命名：OpenPrintShare-{Platform}-{arch}-{version}[.ext]
#
# 用法：
#   scripts/build-all.sh              # 全部（本机可构建的目标；Android/iOS 自动跳过并给出指引）
#   scripts/build-all.sh linux        # 仅 Linux（含 .deb + AppImage）
#   scripts/build-all.sh windows      # 仅 Windows（exe + zip 便携版）
#   scripts/build-all.sh macos        # 仅 macOS（交叉编译单文件）
#   scripts/build-all.sh host         # 仅 Host 单文件全目标（无 deb/AppImage 等包装）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

require_bun
log "OpenPrintShare v$VERSION 全平台构建"

# 1) Web 静态导出 + 嵌入清单（所有 Host 产物共用）
bash "$OPS_ROOT/scripts/build-web.sh"

PLATFORMS=("${@:-}")
if [ ${#PLATFORMS[@]} -eq 0 ] || [ -z "${PLATFORMS[0]}" ]; then
  PLATFORMS=(linux windows macos android ios)
fi

for p in "${PLATFORMS[@]}"; do
  case "$p" in
    linux)   bash "$OPS_ROOT/scripts/build-linux.sh" x64 ;;
    windows) bash "$OPS_ROOT/scripts/build-windows.sh" ;;
    macos)   bash "$OPS_ROOT/scripts/build-macos.sh" ;;
    android) bash "$OPS_ROOT/scripts/build-android.sh" || true ;;
    ios)     bash "$OPS_ROOT/scripts/build-ios.sh" || true ;;
    host)    bash "$OPS_ROOT/scripts/build-host.sh" ;;
    *) fail "未知平台：$p（可选 linux | windows | macos | android | ios | host）" ;;
  esac
done

log "================= 构建汇总 ================="
find "$DIST" -maxdepth 2 -type f ! -path "*/.stage/*" -printf "%P\t%s bytes\n" | sort | while IFS=$'\t' read -r f s; do
  printf "  %-55s %s\n" "$f" "$(numfmt --to=iec "$s" 2>/dev/null || echo "$s")"
done
log "dist 目录：$DIST（.stage 为中间产物，可 rm -rf dist/.stage）"

#!/usr/bin/env bash
# build-host.sh — Host 单文件可执行编译（bun build --compile，Bun 运行时内嵌）
#
# 用法：
#   scripts/build-host.sh                # 全部目标
#   scripts/build-host.sh linux-x64      # 单目标：linux-x64 | linux-arm64 | windows-x64 | darwin-x64 | darwin-arm64
#
# 前置：先运行 build-web.sh（生成嵌入清单）——否则产物为纯 API 模式（无 Web 控制台）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

require_bun

TARGETS=("${@:-}")
if [ ${#TARGETS[@]} -eq 0 ] || [ -z "${TARGETS[0]}" ]; then
  TARGETS=(linux-x64 linux-arm64 windows-x64 darwin-x64 darwin-arm64)
fi

# 目标 → (bun target, 产物目录, 产物名平台, 产物扩展)
target_map() {
  case "$1" in
    linux-x64)    echo "bun-linux-x64    linux   Linux   ''" ;;
    linux-arm64)  echo "bun-linux-arm64  linux   Linux   ''" ;;
    windows-x64)  echo "bun-windows-x64  windows Windows .exe" ;;
    darwin-x64)   echo "bun-darwin-x64   macos   macOS   ''" ;;
    darwin-arm64) echo "bun-darwin-arm64 macos   macOS   ''" ;;
    *) fail "未知目标：$1（可选 linux-x64 | linux-arm64 | windows-x64 | darwin-x64 | darwin-arm64）" ;;
  esac
}

cd "$HOST_ROOT"
[ -d node_modules ] || { log "安装 ops-host 依赖…"; bun install; }

EMBEDDED=""
[ -f src/generated/web-embed.ts ] && EMBEDDED="（内嵌 Web 控制台）"

for t in "${TARGETS[@]}"; do
  read -r bun_target dir platform ext <<< "$(target_map "$t")"
  arch="${t#*-}"
  case "$arch" in x64) arch_label="x64";; arm64) arch_label="arm64";; esac
  ext="${ext//\'/}"
  name="$(out_name "$platform" "$arch_label" "$ext")"
  outdir="$DIST/$dir"
  mkdir -p "$outdir"
  log "编译 $t → $outdir/$name $EMBEDDED"
  rm -f "$outdir/$name"
  bun build --compile index.ts --target="$bun_target" --outfile "$outdir/$name"
  ls -lh "$outdir/$name" | awk '{print "[ops-build]   →", $5}'
done

log "build-host 完成（${#TARGETS[@]} 个目标）"

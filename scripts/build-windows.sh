#!/usr/bin/env bash
# build-windows.sh — Windows x64 产物
#  1) 单文件 .exe（bun cross-compile；Web 控制台内嵌 → 双击运行后浏览器打开控制台）
#  2) 便携版 .zip（exe + README 使用说明）
# .msi 安装器在 CI（github actions windows runner + NSIS/Nullsoft 或 WiX）构建——见 .github/workflows/release-build.yml
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

require_bun

ARCH="x64"
WIN_DIR="$DIST/windows"
EXE_NAME="$(out_name Windows "$ARCH" .exe)"
ZIP_NAME="$(out_name Windows "$ARCH" .zip)"

bash "$OPS_ROOT/scripts/build-host.sh" windows-x64

log "生成 Windows 便携包 → $WIN_DIR/$ZIP_NAME"
ZIPROOT="$STAGE/win-$ARCH"
rm -rf "$ZIPROOT"
mkdir -p "$ZIPROOT"
cp "$WIN_DIR/$EXE_NAME" "$ZIPROOT/OpenPrintShare.exe"

cat > "$ZIPROOT/使用说明.txt" <<EOF
OpenPrintShare v$VERSION — 跨平台局域网共享打印机（Windows 便携版）
====================================================================

运行
----
双击 OpenPrintShare.exe（无需安装任何运行时；Bun 已内嵌）。

  · 控制台地址：http://localhost:3001/
  · 首次运行会在 exe 同目录创建 data 数据文件夹（任务 PDF / 配置等运行时工件）
  · 防火墙提示「允许访问」请勾选（局域网设备需要发现并连接本机）

命令行参数
----------
  OpenPrintShare.exe [--port 3001] [--ws-port 3002] [--data-dir D:\...] [--no-vipp]

局域网客户端
------------
手机/平板/其它电脑浏览器打开 http://<本机IP>:3001/ 即可使用。

官方安装版（.msi）见 GitHub Releases：
https://github.com/wanan-love/ops/releases
EOF

cat > "$ZIPROOT/README.txt" <<EOF
OpenPrintShare v$VERSION (Windows x64, portable)
Run OpenPrintShare.exe, then open http://localhost:3001/
Docs: https://github.com/wanan-love/ops
EOF

(cd "$ZIPROOT" && zip -q -9 -r "$WIN_DIR/$ZIP_NAME" .)
log "  → $WIN_DIR/$ZIP_NAME ($(du -h "$WIN_DIR/$ZIP_NAME" | cut -f1))"

log "build-windows 完成：$(ls -1 "$WIN_DIR" | tr '\n' ' ')"

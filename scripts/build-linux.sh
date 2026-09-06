#!/usr/bin/env bash
# build-linux.sh — Linux 完整产物：单文件可执行 + .deb + AppImage
#
# 用法：scripts/build-linux.sh [x64|arm64]（默认 x64；arm64 仅单文件+deb——AppImage 工具链按需下载）
#
# .deb 结构：/opt/openprintshare/{二进制} + /usr/bin 符号链接 + .desktop 桌面入口 + systemd 用户服务（可选启用）
# AppImage：AppDir + appimagetool（首次运行自动下载到 .cache）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

ARCH="${1:-x64}"
BUN_ARCH="linux-$ARCH"
[ "$ARCH" = "x64" ] && TOOL_ARCH="x86_64" || TOOL_ARCH="aarch64"

BIN_NAME="$(out_name Linux "$ARCH")"
DEB_NAME="$(out_name Linux "$ARCH" .deb)"
APPIMAGE_NAME="$(out_name Linux "$ARCH" .AppImage)"

require_bun

# 1) 编译单文件（含内嵌 Web，如已生成清单）
bash "$OPS_ROOT/scripts/build-host.sh" "linux-$ARCH"

LINUX_DIR="$DIST/linux"
BIN="$LINUX_DIR/$BIN_NAME"
[ -f "$BIN" ] || fail "单文件可执行缺失：$BIN"

# ---------------------------------------------------------------- 2) .deb 包
log "制作 .deb → $LINUX_DIR/$DEB_NAME"
DEBROOT="$STAGE/deb-$ARCH"
rm -rf "$DEBROOT"
OPTDIR="$DEBROOT/opt/openprintshare"
mkdir -p "$OPTDIR" "$DEBROOT/usr/bin" "$DEBROOT/usr/share/applications" "$DEBROOT/usr/share/icons/hicolor/512x512/apps" "$DEBROOT/DEBIAN"

cp "$BIN" "$OPTDIR/openprintshare"
chmod 755 "$OPTDIR/openprintshare"
ln -s /opt/openprintshare/openprintshare "$DEBROOT/usr/bin/openprintshare"

# 图标（用仓库 logo.svg 转存；512 png 由 CI 环境生成，此处放 svg 兼容项）
cp "$OPS_ROOT/public/logo.svg" "$DEBROOT/usr/share/icons/hicolor/512x512/apps/openprintshare.svg"

cat > "$DEBROOT/usr/share/applications/openprintshare.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenPrintShare
GenericName=LAN Print Sharing
Comment=跨平台局域网共享打印机 — Host
Exec=openprintshare
Icon=openprintshare
Terminal=true
Categories=Utility;System;Network;
Keywords=print;printer;share;lan;ipp;cups;
StartupNotify=true
EOF

# 启动器：桌面终端运行太粗糙——写一个小 wrapper 打开浏览器
cat > "$OPTDIR/openprintshare.sh" <<EOF
#!/usr/bin/env bash
# OpenPrintShare Host 启动器（数据目录：~/OpenPrintShare-data）
DATA="\${OPS_DATA_DIR:-\$HOME/OpenPrintShare-data}"
mkdir -p "\$DATA"
URL="http://localhost:\${OPS_PORT:-3001}/"
echo "OpenPrintShare Host 启动中… 控制台 \$URL"
( sleep 1; (xdg-open "\$URL" 2>/dev/null || open "\$URL" 2>/dev/null) & ) &
exec /opt/openprintshare/openprintshare "\$@"
EOF
chmod 755 "$OPTDIR/openprintshare.sh"
sed -i 's|Exec=openprintshare|Exec=/opt/openprintshare/openprintshare.sh|' "$DEBROOT/usr/share/applications/openprintshare.desktop"

INSTALLED_SIZE=$(du -sk "$DEBROOT/opt" | cut -f1)
cat > "$DEBROOT/DEBIAN/control" <<EOF
Package: openprintshare
Version: $VERSION
Section: net
Priority: optional
Architecture: $( [ "$ARCH" = "x64" ] && echo amd64 || echo arm64 )
Depends:
Recommends: xdg-utils
Maintainer: OpenPrintShare <wanan-love@users.noreply.github.com>
Description: OpenPrintShare — 跨平台局域网共享打印机（Host）
 跨平台局域网共享打印机系统 Host 守护进程：共享系统打印机，
 客户端（浏览器/Android/iOS）自动发现并提交 PDF 打印任务。
 支持 CUPS / IPP / Windows 打印栈；能力由设备真实返回（三态模型）。
 运行时已随程序打包，无需安装 Node.js / Python / Rust。
Installed-Size: $INSTALLED_SIZE
Homepage: https://github.com/wanan-love/ops
EOF

cat > "$DEBROOT/DEBIAN/postinst" <<'EOF'
#!/usr/bin/env bash
set -e
# 提示防火墙放行（仅提示，不强制）
if command -v ufw >/dev/null 2>&1; then
  echo "[openprintshare] 如需局域网访问，请放行端口：sudo ufw allow 3001:3002/tcp"
fi
echo "[openprintshare] 安装完成。运行 openprintshare 启动（或应用菜单 → OpenPrintShare）。"
EOF
chmod 755 "$DEBROOT/DEBIAN/postinst"

dpkg-deb --root-owner-group --build "$DEBROOT" "$LINUX_DIR/$DEB_NAME"
log "  → $LINUX_DIR/$DEB_NAME ($(du -h "$LINUX_DIR/$DEB_NAME" | cut -f1))"

# ---------------------------------------------------------------- 3) AppImage
log "制作 AppImage → $LINUX_DIR/$APPIMAGE_NAME"
APPDIR="$STAGE/appimage-$ARCH"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/icons/hicolor/512x512/apps" "$APPDIR/usr/share/metainfo"

cp "$BIN" "$APPDIR/usr/bin/openprintshare"
chmod 755 "$APPDIR/usr/bin/openprintshare"
cp "$OPS_ROOT/public/logo.svg" "$APPDIR/usr/share/icons/hicolor/512x512/apps/openprintshare.svg"

# AppImage 运行时以 APPDIR 为 cwd：数据放 $HOME/.openprintshare
cat > "$APPDIR/AppRun" <<'EOF'
#!/usr/bin/env bash
HERE="$(dirname "$(readlink -f "$0")")"
export OPS_DATA_DIR="${OPS_DATA_DIR:-$HOME/.openprintshare}"
mkdir -p "$OPS_DATA_DIR"
URL="http://localhost:${OPS_PORT:-3001}/"
( sleep 1; (xdg-open "$URL" 2>/dev/null || true) & ) 2>/dev/null
exec "$HERE/usr/bin/openprintshare" "$@"
EOF
chmod 755 "$APPDIR/AppRun"

cp "$OPS_ROOT/public/logo.svg" "$APPDIR/openprintshare.svg" 2>/dev/null || true
cat > "$APPDIR/openprintshare.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=OpenPrintShare
Exec=openprintshare %U
Icon=openprintshare
Terminal=true
Categories=Utility;System;Network;
Comment=跨平台局域网共享打印机
StartupNotify=true
EOF

cat > "$APPDIR/usr/share/metainfo/openprintshare.appdata.xml" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>openprintshare</id>
  <name>OpenPrintShare</name>
  <summary>跨平台局域网共享打印机</summary>
  <description><p>Host 守护进程：共享系统打印机，局域网客户端自动发现并打印 PDF。运行时已随程序打包。</p></description>
  <releases><release version="$VERSION" date="$(date +%F)"/></releases>
  <url type="homepage">https://github.com/wanan-love/ops</url>
</component>
EOF

TOOL="$OPS_ROOT/.cache/appimagetool-$TOOL_ARCH.AppImage"
if [ ! -f "$TOOL" ]; then
  log "下载 appimagetool（$TOOL_ARCH）…"
  mkdir -p "$OPS_ROOT/.cache"
  curl -fL --retry 3 -o "$TOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$TOOL_ARCH.AppImage" || warn "appimagetool 下载失败——跳过 AppImage（CI 可构建）"
fi
if [ -f "$TOOL" ]; then
  chmod +x "$TOOL"
  if ! "$TOOL" --appimage-extract-and-run "$APPDIR" "$LINUX_DIR/$APPIMAGE_NAME" >/dev/null 2>&1; then
    warn "AppImage 打包失败（常见原因：FUSE 不可用/已尝试 extract-and-run）——保留 AppDir 于 $APPDIR"
  else
    chmod +x "$LINUX_DIR/$APPIMAGE_NAME"
    log "  → $LINUX_DIR/$APPIMAGE_NAME ($(du -h "$LINUX_DIR/$APPIMAGE_NAME" | cut -f1))"
  fi
fi

log "build-linux（$ARCH）完成：$(ls -1 "$LINUX_DIR" | tr '\n' ' ')"

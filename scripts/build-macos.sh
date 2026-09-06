#!/usr/bin/env bash
# build-macos.sh — macOS 产物
#  本地（Linux）：交叉编译 arm64 + x64 单文件可执行（含内嵌 Web）
#  macOS 宿主 / CI（github actions macos runner）：追加 .app Bundle 与 .dmg
#    ./scripts/build-macos.sh --dmg   # 仅在 macOS 上可用（hdiutil）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

require_bun

MAC_DIR="$DIST/macos"

bash "$OPS_ROOT/scripts/build-host.sh" darwin-arm64 darwin-x64

# ---------------------------------------------------------------- .app + .dmg（仅 macOS 宿主可做）
if [ "$(uname)" = "Darwin" ]; then
  for ARCH in arm64 x64; do
    BIN="$MAC_DIR/$(out_name macOS "$ARCH")"
    APP_NAME="$(out_name macOS "$ARCH" .app)"
    DMG_NAME="$(out_name macOS "$ARCH" .dmg)"
    APPROOT="$STAGE/macos-$ARCH"
    rm -rf "$APPROOT"
    MACOS_DIR="$APPROOT/$APP_NAME/Contents/MacOS"
    RES_DIR="$APPROOT/$APP_NAME/Contents/Resources"
    mkdir -p "$MACOS_DIR" "$RES_DIR"

    cp "$BIN" "$MACOS_DIR/OpenPrintShare"
    chmod 755 "$MACOS_DIR/OpenPrintShare"
    cp "$OPS_ROOT/public/logo.svg" "$RES_DIR/AppIcon.svg"

    # 启动器：打开控制台 + 运行守护进程
    cat > "$MACOS_DIR/OpenPrintShare.sh" <<EOF
#!/usr/bin/env bash
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export OPS_DATA_DIR="\${OPS_DATA_DIR:-\$HOME/OpenPrintShare-data}"
mkdir -p "\$OPS_DATA_DIR"
( sleep 1; open "http://localhost:\${OPS_PORT:-3001}/" ) &
exec "\$DIR/OpenPrintShare" "\$@"
EOF
    chmod 755 "$MACOS_DIR/OpenPrintShare.sh"

    cat > "$APPROOT/$APP_NAME/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OpenPrintShare</string>
  <key>CFBundleDisplayName</key><string>OpenPrintShare</string>
  <key>CFBundleIdentifier</key><string>io.github.wanan-love.openprintshare</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>OpenPrintShare.sh</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
EOF

    # 图标（svg → icns 需要 iconutil；CI 中用 rsvg/pngquant 生成；此处放 svg）
    log "制作 .app → $MAC_DIR/$APP_NAME"
    cp -R "$APPROOT/$APP_NAME" "$MAC_DIR/$APP_NAME"

    if [[ " $* " == *" --dmg "* ]] && command -v hdiutil >/dev/null; then
      log "制作 .dmg → $MAC_DIR/$DMG_NAME"
      rm -f "$MAC_DIR/$DMG_NAME"
      hdiutil create -volname "OpenPrintShare $VERSION ($ARCH)" -srcfolder "$APPROOT/$APP_NAME" -ov -format UDZO "$MAC_DIR/$DMG_NAME" >/dev/null
      log "  → $MAC_DIR/$DMG_NAME"
    fi
  done
else
  log "当前非 macOS 宿主：仅生成交叉编译单文件（.app/.dmg 由 CI macOS runner 构建，见 .github/workflows/release-build.yml）"
fi

log "build-macos 完成：$(ls -1 "$MAC_DIR" | tr '\n' ' ')"

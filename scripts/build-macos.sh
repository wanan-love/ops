#!/usr/bin/env bash
# build-macos.sh — macOS 产物
#  本地（Linux）：交叉编译 arm64 + x64 单文件可执行（含内嵌 Web）
#  macOS 宿主 / CI（github actions macos runner）：追加 .app Bundle 与 .dmg
#    ./scripts/build-macos.sh --dmg   # 仅在 macOS 上可用（hdiutil）
#  磁盘策略（CI macos runner 仅 ~14GB 可用）：.app 直接产出到 dist/macos（不做
#  STAGE 双份拷贝，省 ~140MB/架构）；hdiutil 失败降级 warn（.app 产物仍在，不阻塞发布链）
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
    MACOS_DIR="$MAC_DIR/$APP_NAME/Contents/MacOS"
    RES_DIR="$MAC_DIR/$APP_NAME/Contents/Resources"
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

    cat > "$MAC_DIR/$APP_NAME/Contents/Info.plist" <<EOF
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

    log "制作 .app → $MAC_DIR/$APP_NAME"

    if [[ " $* " == *" --dmg "* ]] && command -v hdiutil >/dev/null; then
      log "制作 .dmg → $MAC_DIR/$DMG_NAME"
      rm -f "$MAC_DIR/$DMG_NAME"
      # 磁盘不足等环境性失败降级为 warn（.app 产物仍在，不阻塞发布链）
      if hdiutil create -volname "OpenPrintShare $VERSION ($ARCH)" -srcfolder "$MAC_DIR/$APP_NAME" -ov -format UDZO "$MAC_DIR/$DMG_NAME" >/dev/null 2>&1; then
        log "  → $MAC_DIR/$DMG_NAME"
      else
        warn "hdiutil 失败（常见原因：runner 磁盘不足）——保留 .app 产物继续，$ARCH dmg 跳过"
      fi
    fi
  done
else
  log "当前非 macOS 宿主：仅生成交叉编译单文件（.app/.dmg 由 CI macOS runner 构建，见 .github/workflows/release-build.yml）"
fi

log "build-macos 完成：$(ls -1 "$MAC_DIR" | tr '\n' ' ')"

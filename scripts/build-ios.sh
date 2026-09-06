#!/usr/bin/env bash
# build-ios.sh — iOS 客户端构建（需要 macOS + Xcode）
#  本地（Linux/Windows）：校验工程结构完整并输出指引（CI 由 macos runner 构建）
#  macOS：xcodebuild archive → dist/ios/OpenPrintShare-iOS-<version>.ipa（需签名证书；
#         CI 用 Apple Developer secrets，TestFlight/App Store 发布走 Xcode Organizer 或 xcrun altool）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

IOS_DIR="$OPS_ROOT/clients/ios"
OUT_DIR="$DIST/ios"
mkdir -p "$OUT_DIR"

PROJ="$IOS_DIR/OpenPrintShare.xcodeproj"
for f in "$PROJ/project.pbxproj" "$IOS_DIR/OpenPrintShare/App.swift" "$IOS_DIR/OpenPrintShare/Info.plist"; do
  [ -f "$f" ] || fail "iOS 工程文件缺失：$f"
done

if [ "$(uname)" = "Darwin" ] && command -v xcodebuild >/dev/null; then
  log "xcodebuild archive（iOS）…"
  ARCHIVE="$STAGE/ops-ios.xcarchive"
  xcodebuild -project "$PROJ" -scheme OpenPrintShare -sdk iphoneos -configuration Release \
    -archivePath "$ARCHIVE" archive CODE_SIGNING_ALLOWED=NO
  IPA_NAME="$(out_name iOS universal .ipa)"
  mkdir -p "$OUT_DIR"
  xcodebuild -exportArchive -archivePath "$ARCHIVE" \
    -exportOptionsPlist <(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>development</string>
  <key>signingStyle</key><string>manual</string>
</dict></plist>
EOF
) -exportPath "$OUT_DIR" 2>/dev/null || warn "导出 ipa 需要签名身份（DEVELOPMENT_TEAM）——CI secrets 注入后自动完成"
  log "  → $OUT_DIR/$IPA_NAME（若签名配置可用）"
else
  log "非 macOS 宿主：iOS 工程已就绪（Xcode 16+ 打开 $PROJ 即可 Build/Archive）"
  cat > "$OUT_DIR/OpenPrintShare-iOS-README.txt" <<EOF
OpenPrintShare iOS 客户端构建指引
==================================

要求：macOS 14+、Xcode 16+（Swift 5，deployment target iOS 16）

本地构建：
  1. open clients/ios/OpenPrintShare.xcodeproj
  2. 选择个人开发团队（Signing & Capabilities）
  3. Cmd+R 运行 / Product → Archive 发布

命令行构建（与 CI 一致）：
  cd clients/ios
  xcodebuild -project OpenPrintShare.xcodeproj -scheme OpenPrintShare \\
    -sdk iphoneos -configuration Release archive -archivePath ../dist/ios/ops.xcarchive

TestFlight / App Store：
  Xcode Organizer 上传（或 xcrun altool / Transporter）；
  CI 见 .github/workflows/release-build.yml（macos runner，需要 APPLE 证书 secrets）。

客户端行为：连接 http://<host>:3001 加载 Web 控制台（ATS 允许本地网络），
打印任务由 Host 侧系统打印机完成，客户端无需安装厂商驱动。
EOF
  log "  → $OUT_DIR/OpenPrintShare-iOS-README.txt"
fi

log "build-ios 完成"

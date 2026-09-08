#!/usr/bin/env bash
# build-android.sh — Android 客户端 APK 构建
# 依赖：JDK 17 + Android SDK（含 build-tools/platforms 34）
#  本地无 SDK 时：跳过并提示（CI 由 .github/workflows/release-build.yml 构建）
#  产物：dist/android/OpenPrintShare-Android-universal-<version>.apk（无 abi splits → universal，
#        debug 签名可直接安装；正式签名密钥由后续 secrets 注入升级）
set -euo pipefail
source "$(dirname "$0")/build-common.sh"

ANDROID_DIR="$OPS_ROOT/clients/android"
OUT_DIR="$DIST/android"
APK_NAME="$(out_name Android universal .apk)"

[ -d "$ANDROID_DIR" ] || fail "Android 工程缺失：$ANDROID_DIR"

# 环境探测：sdkmanager / ANDROID_HOME / local.properties
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -z "$SDK" ] && [ -f "$ANDROID_DIR/local.properties" ] && SDK=$(grep -oP 'sdk.dir=\K.*' "$ANDROID_DIR/local.properties" | head -1)

if [ -z "$SDK" ] || [ ! -d "$SDK" ]; then
  warn "未检测到 Android SDK（ANDROID_HOME/local.properties）"
  warn "本地跳过 APK 构建；CI（ubuntu runner + android actions）会自动产出 $APK_NAME"
  warn "本地构建指引："
  cat <<EOF
    1) 安装 Android Studio（或 cmdline-tools）与 JDK 17
    2) echo "sdk.dir=/path/to/Android/sdk" > clients/android/local.properties
    3) cd clients/android && ./gradlew assembleRelease --no-daemon
    4) cp app/build/outputs/apk/release/app-release-unsigned.apk dist/android/$APK_NAME
EOF
  mkdir -p "$OUT_DIR"
  exit 0
fi

log "检测到 Android SDK：$SDK"
cd "$ANDROID_DIR"
if [ ! -f local.properties ]; then
  echo "sdk.dir=$SDK" > local.properties
fi

# 版本单一来源注入（types.ts OPS_VERSION → -PopsVersion/-PopsVersionCode）
VER_MAJOR="$(echo "$VERSION" | cut -d. -f1)"
VER_MINOR="$(echo "$VERSION" | cut -d. -f2)"
VER_PATCH="$(echo "$VERSION" | cut -d. -f3)"
VER_CODE=$(( VER_MAJOR * 10000 + VER_MINOR * 100 + VER_PATCH ))
GRADLE_ARGS=(--no-daemon -PopsVersion="$VERSION" -PopsVersionCode="$VER_CODE")

# wrapper 优先（仓库自带 gradle-8.7 wrapper；CI 同样用 ./gradlew，不依赖全局 gradle）
if [ -x ./gradlew ]; then
  ./gradlew assembleRelease "${GRADLE_ARGS[@]}"
elif command -v gradle >/dev/null; then
  gradle assembleRelease "${GRADLE_ARGS[@]}"
else
  fail "需要 gradle ≥ 8.7（或仓库 wrapper：gradlew + JDK17）"
fi

mkdir -p "$OUT_DIR"
cp app/build/outputs/apk/release/app-release-unsigned.apk "$OUT_DIR/$APK_NAME" 2>/dev/null \
  || cp app/build/outputs/apk/release/app-release.apk "$OUT_DIR/$APK_NAME"

# debug 签名产物可直接安装（正式签名密钥由 CI secrets 注入）
log "  → $OUT_DIR/$APK_NAME（未签名——CI 用 keystore 签名发布；本地安装可用 adb install -t 或先 apksigner 签名）"
log "build-android 完成"

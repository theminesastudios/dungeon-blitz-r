#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$ROOT_DIR/discord_social_sdk"
BUILD_DIR="$ROOT_DIR/build"
OUTPUT="$BUILD_DIR/discord_social_bridge"
DYLIB="$SDK_DIR/lib/release/libdiscord_partner_sdk.dylib"

mkdir -p "$BUILD_DIR"

clang++ \
  -std=c++17 \
  -I"$ROOT_DIR" \
  -I"$SDK_DIR/include" \
  "$ROOT_DIR/BridgeMain.cpp" \
  "$ROOT_DIR/DiscordBridge.cpp" \
  -L"$SDK_DIR/lib/release" \
  -ldiscord_partner_sdk \
  -Wl,-rpath,@executable_path \
  -o "$OUTPUT"

if [[ -f "$DYLIB" ]]; then
  cp "$DYLIB" "$BUILD_DIR/"
fi

echo "Built: $OUTPUT"

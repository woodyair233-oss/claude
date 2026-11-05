#!/usr/bin/env bash
# Builds the gatehouse-mcp stdio bridge for macOS (arm64 + x64) and, for local
# development and tests, for the host platform. Output: build/bin/<os>-<arch>/
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
OUT=build/bin
mkdir -p "$OUT"
cd bridge
build() {
  local goos=$1 goarch=$2 dir=$3
  mkdir -p "../$OUT/$dir"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath \
    -ldflags="-s -w -X main.version=$VERSION" -o "../$OUT/$dir/gatehouse-mcp" .
  echo "built $OUT/$dir/gatehouse-mcp"
}
build darwin arm64 darwin-arm64
build darwin amd64 darwin-x64
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) build linux amd64 linux-x64 ;;
  Linux-aarch64) build linux arm64 linux-arm64 ;;
esac

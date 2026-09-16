#!/usr/bin/env bash
# Builds one npm package per platform, each holding a single gnotx binary, into npm/.
# npm installs only the package whose os/cpu match the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/npm"
VERSION="$(node -p "require('$ROOT/package.json').version")"

# npm os/cpu, Go GOOS/GOARCH, binary name
TARGETS=(
  "darwin arm64 darwin  arm64 gnotx"
  "darwin x64   darwin  amd64 gnotx"
  "linux  x64   linux   amd64 gnotx"
  "linux  arm64 linux   arm64 gnotx"
  "win32  x64   windows amd64 gnotx.exe"
)

rm -rf "$OUT"
for target in "${TARGETS[@]}"; do
  read -r os cpu goos goarch bin <<<"$target"
  name="gnotx-$goos-$goarch"
  dir="$OUT/$name"
  mkdir -p "$dir"

  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go -C "$ROOT/gnotx" build -trimpath -ldflags="-s -w" -o "$dir/$bin" .
  cp "$ROOT/gnotx/LICENSE" "$dir/LICENSE"

  NAME="@gnopulse/$name" VERSION="$VERSION" OS="$os" CPU="$cpu" BIN="$bin" DIR="$dir" node -e '
    const { NAME, VERSION, OS, CPU, BIN, DIR } = process.env;
    const pkg = {
      name: NAME,
      version: VERSION,
      description: `gnotx signer for @gnopulse/mcp (${OS}-${CPU}). Built on gno.land.`,
      homepage: "https://github.com/gnopulse/mcp",
      repository: { type: "git", url: "git+https://github.com/gnopulse/mcp.git", directory: "gnotx" },
      license: "SEE LICENSE IN LICENSE",
      os: [OS],
      cpu: [CPU],
      files: [BIN, "LICENSE"],
    };
    require("fs").writeFileSync(`${DIR}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
  '
  printf '%-32s %s\n' "@gnopulse/$name" "$(du -h "$dir/$bin" | cut -f1)"
done

#!/usr/bin/env bash
# Install pinned, checksum-verified prek and pinact release binaries into a
# directory (default ~/.local/bin). Used by CI; works on a developer machine.
#
#   scripts/install-lint-tools.sh [bin-dir]
#
# Needs gh (authenticated) to download the release assets.
set -euo pipefail

PREK_VERSION="0.5.3"
PINACT_VERSION="5.0.0"
bin_dir="${1:-$HOME/.local/bin}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$bin_dir"

case "$(uname -m)" in
  x86_64 | amd64) prek_arch="x86_64" pinact_arch="amd64" ;;
  aarch64 | arm64) prek_arch="aarch64" pinact_arch="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

cd "$work"

prek_asset="prek-${prek_arch}-unknown-linux-gnu.tar.gz"
gh release download "v${PREK_VERSION}" --repo j178/prek \
  --pattern "${prek_asset}" --pattern "${prek_asset}.sha256"
sha256sum -c "${prek_asset}.sha256"
tar -xzf "${prek_asset}"
install -m 755 "$(find . -name prek -type f | head -1)" "$bin_dir/prek"

pinact_asset="pinact_linux_${pinact_arch}.tar.gz"
pinact_sums="pinact_${PINACT_VERSION}_checksums.txt"
gh release download "v${PINACT_VERSION}" --repo suzuki-shunsuke/pinact \
  --pattern "${pinact_asset}" --pattern "${pinact_sums}"
grep " ${pinact_asset}\$" "${pinact_sums}" | sha256sum -c -
tar -xzf "${pinact_asset}" pinact
install -m 755 pinact "$bin_dir/pinact"

"$bin_dir/prek" --version
"$bin_dir/pinact" --version 2>/dev/null | head -1

#!/usr/bin/env bash
# Validate, build and compose-test this plugin against an official AI-DLC
# release, for one harness. Used by CI; runs the same on a developer machine.
#
#   scripts/compose-test.sh <harness> [aidlc-version]
#
# Needs bun, and gh (authenticated) to download the release asset.
set -euo pipefail

harness="${1:?usage: compose-test.sh <harness> [aidlc-version]}"
version="${2:-${AIDLC_VERSION:-2.10.0}}"
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

asset="aidlc-copy-runtime-${version}.tar.gz"
gh release download "v${version}" --repo awslabs/aidlc-workflows \
  --pattern "${asset}" --pattern "${asset}.sha256" --dir "$work"
(cd "$work" && sha256sum -c "${asset}.sha256")
tar -xzf "$work/${asset}" -C "$work"

runtime="$work/runtime/${harness}"
tools="$(find "$runtime" -maxdepth 3 -type d -name tools -path '*/tools' | head -1)"
[ -n "$tools" ] || { echo "no tools dir for harness ${harness}" >&2; exit 1; }

# The plugin root directory must be named after the plugin.
cp -R "$plugin_root" "$work/jev"
rm -rf "$work/jev/dist" "$work/jev/.git"

project="$work/project"
mkdir "$project"
cp -R "$runtime/." "$project/"

bun "$tools/aidlc-plugin-validate.ts" "$work/jev"
bun "$tools/aidlc-plugin-build.ts" "$work/jev" "$harness"
bun "$tools/aidlc-plugin-test.ts" "$work/jev" --install "$project" --harness "$harness"

# The repo vendors AI-DLC's compose hook at hooks/compose.ts, because the
# plugin is installed straight from git and AI-DLC's sync runs that file. It
# must match what this AI-DLC release's build injects.
if ! cmp -s "$work/jev/dist/${harness}/hooks/compose.ts" "$plugin_root/hooks/compose.ts"; then
  echo "hooks/compose.ts differs from the one AI-DLC ${version} generates;" >&2
  echo "refresh it: bun <tools>/aidlc-plugin-build.ts . ${harness} && cp dist/${harness}/hooks/compose.ts hooks/" >&2
  exit 1
fi

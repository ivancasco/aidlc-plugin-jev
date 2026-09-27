#!/usr/bin/env bash
# Build this plugin's projection for every AI-DLC harness, with the plugin
# tools from an official AI-DLC release. The release workflow publishes each
# projection to its own branch; this runs the same on a developer machine.
#
#   scripts/build-dist.sh <out-dir> [aidlc-version]
#
# Writes <out-dir>/<harness>/ for each harness. Needs bun, and gh
# (authenticated) to download the release asset. Set AIDLC_RUNTIME to an
# already extracted copy-runtime directory (the one holding <harness>/) to
# skip the download.
set -euo pipefail

out="${1:?usage: build-dist.sh <out-dir> [aidlc-version]}"
version="${2:-${AIDLC_VERSION:-2.10.0}}"
harnesses=(claude codex copilot cursor kiro kiro-ide opencode)
plugin_root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

runtime="${AIDLC_RUNTIME:-}"
if [ -z "$runtime" ]; then
  asset="aidlc-copy-runtime-${version}.tar.gz"
  gh release download "v${version}" --repo awslabs/aidlc-workflows \
    --pattern "${asset}" --pattern "${asset}.sha256" --dir "$work"
  (cd "$work" && sha256sum -c "${asset}.sha256")
  tar -xzf "$work/${asset}" -C "$work"
  runtime="$work/runtime"
fi

# The plugin root directory must be named after the plugin. Copy only the
# plugin source, never local build output, git data or dependencies.
mkdir "$work/jev"
tar -C "$plugin_root" --exclude=./.git --exclude=./dist --exclude=./node_modules \
  -cf - . | tar -C "$work/jev" -xf -

mkdir -p "$out"
out="$(cd "$out" && pwd)"
for harness in "${harnesses[@]}"; do
  tools="$(find "$runtime/${harness}" -maxdepth 3 -type d -name tools -path '*/tools' | head -1)"
  [ -n "$tools" ] || { echo "no tools dir for harness ${harness}" >&2; exit 1; }
  if [ "$harness" = "${harnesses[0]}" ]; then
    bun "$tools/aidlc-plugin-validate.ts" "$work/jev"
  fi
  rm -rf "${out:?}/${harness}"
  bun "$tools/aidlc-plugin-build.ts" "$work/jev" "$harness" "$out/$harness"
done

# `codex plugin marketplace add` looks for .agents/plugins/marketplace.json (or
# the legacy .claude-plugin/marketplace.json), not the
# .codex-plugin/marketplace.json that AI-DLC 2.10.0 emits, so it rejects the
# Codex build with "marketplace root does not contain a supported manifest".
# Add the Codex-native catalogue, with the local source object Codex documents.
# shellcheck disable=SC2016 # the ${...} below is JavaScript, not shell
bun -e '
  const [dir] = process.argv.slice(1);
  const fs = require("node:fs");
  const market = JSON.parse(fs.readFileSync(`${dir}/.codex-plugin/marketplace.json`, "utf8"));
  for (const plugin of market.plugins) plugin.source = { source: "local", path: "./" };
  fs.mkdirSync(`${dir}/.agents/plugins`, { recursive: true });
  fs.writeFileSync(`${dir}/.agents/plugins/marketplace.json`, JSON.stringify(market, null, 2) + "\n");
' "$out/codex"

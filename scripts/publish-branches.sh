#!/usr/bin/env bash
# Publish each harness build from scripts/build-dist.sh to its own branch, so
# host plugin commands can install from git (see README "Install"). Run by the
# release workflow after release-please creates a release.
#
#   scripts/publish-branches.sh <dist-dir> <version> <remote>
#
# For each <dist-dir>/<harness>/ this force-updates branch <harness> to a
# single parentless commit "release: v<version> (<harness>)" holding that build
# and a short README, and pushes the annotated tag v<version>-<harness> on it,
# both in one atomic push. Run it from a checkout of the released commit;
# commit and tag dates come from that commit. A harness whose tag already
# exists on the remote is skipped, so re-running a release finishes a partial
# publish without moving a tag or rewinding a branch a later release updated.
# Authentication comes from the caller's git configuration (the workflow
# passes an app token as an HTTP header).
set -euo pipefail

dist="${1:?usage: publish-branches.sh <dist-dir> <version> <remote>}"
version="${2:?usage: publish-branches.sh <dist-dir> <version> <remote>}"
remote="${3:?usage: publish-branches.sh <dist-dir> <version> <remote>}"
version="${version#v}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] ||
  { echo "not a semver version: ${version}" >&2; exit 1; }
dist="$(cd "$dist" && pwd)"
repo_url="${REPO_URL:-https://github.com/ivancasco/aidlc-plugin-jev}"

source_sha="$(git rev-parse HEAD)"
date="$(git log -1 --format=%cI HEAD)"
export GIT_AUTHOR_DATE="$date" GIT_COMMITTER_DATE="$date"
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-jev release}"
export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-noreply@github.com}"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

shopt -s nullglob
harness_dirs=("$dist"/*/)
[ ${#harness_dirs[@]} -gt 0 ] || { echo "no harness builds in ${dist}" >&2; exit 1; }

# Host plugin managers update only when the manifest version changes, so a
# build whose version disagrees with the release must never be published.
for manifest in "$dist"/*/.*-plugin/plugin.json "$dist"/*/.plugin/plugin.json; do
  built="$(jq -r .version "$manifest")"
  [ "$built" = "$version" ] ||
    { echo "${manifest} has version ${built}, expected ${version}" >&2; exit 1; }
done

for dir in "${harness_dirs[@]}"; do
  harness="$(basename "$dir")"
  branch="$harness"
  tag="v${version}-${harness}"
  repo="$work/$harness"

  if [ -n "$(git ls-remote --tags "$remote" "refs/tags/${tag}")" ]; then
    echo "skipping ${harness}: ${tag} already published"
    continue
  fi

  git init -q -b "$branch" "$repo"
  cp -R "$dir." "$repo/"
  cat >"$repo/README.md" <<EOF
# jev ${version}, ${harness} build

This branch holds the AI-DLC jev plugin built for the ${harness} harness at
release v${version}, from commit ${source_sha} on \`main\`. The release workflow
rewrites it on every release, so do not commit to it or open pull requests
against it. Tag \`${tag}\` marks this build.

Source, documentation and install instructions: ${repo_url}#install
EOF
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "release: v${version} (${harness})"
  git -C "$repo" tag -a "$tag" -m "jev v${version} (${harness})"
  git -C "$repo" push --atomic "$remote" \
    "+refs/heads/${branch}:refs/heads/${branch}" "refs/tags/${tag}:refs/tags/${tag}"
  echo "published ${branch} and ${tag} ($(git -C "$repo" rev-parse HEAD))"
done

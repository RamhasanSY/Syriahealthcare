#!/bin/sh
# Publishes syriahc.com from the repository, isolated from the platform (installed as /usr/local/sbin/syriahc-update-website,
# run every 10 minutes by update-website.timer; safe to run by hand, "--force" rebuilds even without new commits).
#
# Why it looks like this: anything pushed to main arrives here automatically. So
#   - it runs from a fixed copy of this script outside the repository (a commit cannot change what runs as root),
#   - it builds from its own clone /opt/site-src, which holds no secrets and no backups (unlike /opt/syriahealthcare),
#   - the build container has no network, runs as "nobody", sees the source read-only and writes only to an empty folder,
#   - and only regular files are copied to /opt/www (no symbolic links that could point at other files).
# The platform itself (/opt/syriahealthcare) is never updated automatically; that stays a reviewed, manual step.
set -eu
SRC=${SRC:-/opt/site-src}
WWW=${WWW:-/opt/www}
REMOTE=${REMOTE:-https://github.com/RamhasanSY/Syriahealthcare.git}
# The build image, fixed by its digest so a changed tag cannot slip in. To update: docker pull node:22-alpine, then
# docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}' and put the new digest here.
IMAGE=${IMAGE:-node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202}

if [ ! -d "$SRC/.git" ]; then
    git clone -q --branch main --single-branch "$REMOTE" "$SRC"
    before=none
else
    before=$(git -C "$SRC" rev-parse HEAD)
    # fetch + reset instead of pull: no merge, no hooks, the clone always equals origin/main.
    git -C "$SRC" fetch -q origin main
    git -C "$SRC" reset -q --hard origin/main
fi
after=$(git -C "$SRC" rev-parse HEAD)
if [ "$before" = "$after" ] && [ -f "$WWW/index.html" ] && [ "${1:-}" != "--force" ]; then
    exit 0
fi

OUT=$(mktemp -d /tmp/syriahc-site.XXXXXX)
trap 'rm -rf "$OUT"' EXIT
chown 65534:65534 "$OUT"
docker run --rm --network none --user 65534:65534 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
    --memory 512m --pids-limit 128 \
    -v "$SRC:/repo:ro" -v "$OUT:/out" -e BUILD_OUT=/out -w /repo "$IMAGE" node scripts/build.mjs

# Only plain files and folders: refuse anything else the build may have produced.
if [ -n "$(find "$OUT" ! -type f ! -type d -print -quit)" ] || [ ! -f "$OUT/dist/index.html" ]; then
    echo "Refusing to publish: unexpected output" >&2
    exit 1
fi
mkdir -p "$WWW"
rsync -a --no-links --delete "$OUT/dist/" "$WWW/"
echo "Website published: $(git -C "$SRC" log -1 --format='%h %s')"

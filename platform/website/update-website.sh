#!/bin/sh
# Publishes the public websites on this server: pulls the latest code and data (news and jobs are collected twice a
# day by .github/workflows/update.yml), builds the pages with Node in a throw-away container and copies them to
# /opt/www (SyriaHC, served as SITE_DOMAIN) and /opt/www-news (Syria Healthcare, served as NEWS_DOMAIN).
# Runs every 10 minutes from update-website.timer; safe to run by hand.
#   update-website.sh           rebuild only when something new was pulled (or nothing is published yet)
#   update-website.sh --force   rebuild anyway
set -eu
REPO=${REPO:-/opt/syriahealthcare}
WWW=${WWW:-/opt/www}
WWW_NEWS=${WWW_NEWS:-/opt/www-news}

cd "$REPO"
before=$(git rev-parse HEAD)
git pull -q --ff-only origin main
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ] && [ -f "$WWW/index.html" ] && [ -f "$WWW_NEWS/index.html" ] && [ "${1:-}" != "--force" ]; then
    exit 0
fi

# scripts/build.mjs uses only Node's built-in modules, so no npm install is needed.
docker run --rm -v "$REPO:/repo" -w /repo node:22-alpine node scripts/build.mjs
# The build recreates dist/ and dist-news/; copying into folders that always exist keeps Caddy's mounts pointing at live files.
mkdir -p "$WWW" "$WWW_NEWS"
rsync -a --delete "$REPO/dist/" "$WWW/"
rsync -a --delete "$REPO/dist-news/" "$WWW_NEWS/"
echo "Websites published: $(git log -1 --format='%h %s')"

#!/bin/bash
# Quick push to GitHub. Usage: ./push.sh "your commit message"

set -e

MSG="${1:-update}"

cd "$(dirname "$0")"

git add -A
git commit -m "$MSG"
git push

echo "Pushed: $MSG"

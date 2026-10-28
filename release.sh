#!/usr/bin/env bash
# Publish a new Bullpen version: bump "version" in package.json, commit, then run this.
# GitHub Actions builds the Windows installer and publishes the release the app updates from.
set -euo pipefail
cd "$(dirname "$0")"
V=$(node -p "require('./package.json').version")
git tag "v$V"
git push origin main "v$V"
echo "tagged v$V: watch https://github.com/cmooney-hw/bullpen/actions"

#!/usr/bin/env bash
# Publish a new Bullpen version: bump "version" in package.json, commit, push to main.
# GitHub Actions builds the Windows installer and publishes the release the app updates from.
set -euo pipefail
cd "$(dirname "$0")"
git push origin main
echo "pushed: watch https://github.com/cmooney-hw/bullpen/actions"

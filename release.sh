#!/usr/bin/env bash
# Build Bullpen, make the Windows installer, and publish it as a GitHub release the app updates from.
# Usage: ./release.sh            (uses the version in package.json)
set -euo pipefail
cd "$(dirname "$0")"
V=$(node -p "require('./package.json').version")
NSISDIR=/root/.cache/electron-builder/nsis/nsis-3.0.4.1
export WINEDEBUG=-all

rm -rf dist
npx electron-builder --win dir --x64 2>&1 | grep -E "packaging|⨯" || true
test -f "dist/win-unpacked/Bullpen.exe"
# tell the updater where releases live
printf 'provider: github\nowner: cmooney-hw\nrepo: bullpen\nupdaterCacheDirName: bullpen-updater\n' > dist/win-unpacked/resources/app-update.yml
( cd build && "$NSISDIR/linux/makensis" -V2 -DVERSION="$V" installer.nsi )
EXE="dist/Bullpen-Setup-$V.exe"
test -f "$EXE"

# latest.yml: what the app's updater reads to know a new version exists
SHA=$(openssl dgst -sha512 -binary "$EXE" | base64 -w0)
SIZE=$(stat -c %s "$EXE")
cat > dist/latest.yml <<EOF
version: $V
files:
  - url: Bullpen-Setup-$V.exe
    sha512: $SHA
    size: $SIZE
path: Bullpen-Setup-$V.exe
sha512: $SHA
releaseDate: '$(date -u +%Y-%m-%dT%H:%M:%S.000Z)'
EOF
echo "built $EXE ($SIZE bytes)"

if [ "${1:-}" = "--publish" ]; then
  gh release create "v$V" "$EXE" dist/latest.yml --repo cmooney-hw/bullpen --title "Bullpen $V" --notes "${NOTES:-Bullpen $V}"
  echo "published v$V"
fi

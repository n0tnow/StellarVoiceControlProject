#!/usr/bin/env bash
#
# Autonomy — Developer ID release pipeline for macOS.
#
# Produces a Developer ID signed, hardened-runtime, notarized and stapled
# .app plus a .dmg that installs on any Mac without the "damaged / cannot be
# opened" Gatekeeper wall that ad-hoc signing (`codesign -s -`) leaves behind.
#
# Prerequisites (one-time, performed by a human — they involve credentials):
#
#   1. A "Developer ID Application" certificate for the team, installed in the
#      login keychain. Xcode > Settings > Accounts > Manage Certificates >
#      "+" > Developer ID Application. Requires a paid Apple Developer Program
#      membership and the Account Holder / Admin role.
#
#   2. A notarytool credential profile holding an app-specific password:
#
#        xcrun notarytool store-credentials "autonomy-notary" \
#          --apple-id "<apple-id-email>" \
#          --team-id "<TEAMID>" \
#          --password "<app-specific-password>"
#
#      App-specific passwords are created at https://account.apple.com >
#      Sign-In and Security > App-Specific Passwords.
#
# Usage:
#   bash scripts/release-macos.sh                 # build, sign, notarize, staple
#   bash scripts/release-macos.sh --skip-build    # reuse the existing bundle
#   bash scripts/release-macos.sh --skip-notarize # sign only (offline check)
#
# Everything long-running is wrapped in `caffeinate -i` per AGENTS.md section 4.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

APP_NAME="Autonomy"
BUNDLE_DIR="app/src-tauri/target/release/bundle/macos"
APP_PATH="$BUNDLE_DIR/$APP_NAME.app"
ENTITLEMENTS="app/src-tauri/Entitlements.plist"
DIST_DIR="dist/release"
NOTARY_PROFILE="${NOTARY_PROFILE:-autonomy-notary}"
VERSION="$(tr -d '[:space:]' < VERSION)"
# Tauri names its bundles `aarch64`, and the published assets follow it — keep
# the same spelling so the README download badge stays predictable.
case "$(uname -m)" in
  arm64|aarch64) ARCH="aarch64" ;;
  *) ARCH="$(uname -m)" ;;
esac
DMG_PATH="$DIST_DIR/${APP_NAME}_${VERSION}_${ARCH}.dmg"
ZIP_PATH="$DIST_DIR/${APP_NAME}_${VERSION}_${ARCH}.zip"

SKIP_BUILD=0
SKIP_NOTARIZE=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    -h|--help) sed -n "2,31p" "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

# --- 1. Resolve the signing identity ----------------------------------------
# An explicit APPLE_SIGNING_IDENTITY wins; otherwise pick the single installed
# Developer ID Application identity and refuse to guess when there are several.
step "Resolving the Developer ID signing identity"
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  # macOS ships bash 3.2, so no `mapfile` — keep the candidates as lines.
  identities="$(
    security find-identity -v -p codesigning \
      | sed -nE 's/.*"(Developer ID Application: .*)"$/\1/p'
  )"
  identity_count="$(printf '%s' "$identities" | grep -c . || true)"
  case "$identity_count" in
    0) die "no 'Developer ID Application' identity in the keychain. Create one in Xcode > Settings > Accounts > Manage Certificates, then re-run. (An 'Apple Development' certificate cannot sign for distribution.)" ;;
    1) APPLE_SIGNING_IDENTITY="$identities" ;;
    *) printf '  %s\n' "$identities" >&2
       die "several Developer ID identities found — set APPLE_SIGNING_IDENTITY to the one you want." ;;
  esac
fi
echo "  identity: $APPLE_SIGNING_IDENTITY"

if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1 \
    || die "notarytool profile '$NOTARY_PROFILE' is missing or invalid. Run 'xcrun notarytool store-credentials \"$NOTARY_PROFILE\"' (see the header of this script), or pass --skip-notarize."
fi

# --- 2. Build ----------------------------------------------------------------
if [[ $SKIP_BUILD -eq 0 ]]; then
  step "Building the release bundle"
  # Tauri ad-hoc signs the bundle; step 3 re-signs it with the real identity.
  (cd app && PATH="$HOME/.cargo/bin:$PATH" caffeinate -i npm run tauri:build)
fi
[[ -d "$APP_PATH" ]] || die "no bundle at $APP_PATH — run without --skip-build."

# --- 3. Sign -----------------------------------------------------------------
# codesign works inside-out: every nested Mach-O has to be signed before the
# bundle that contains it, otherwise the outer seal covers stale signatures.
step "Signing $APP_PATH"
sign() {
  codesign --force --timestamp --options runtime "$@"
}

# `-depth` makes find post-order, so a dylib inside a .framework is reached
# before the framework itself. Without it a nested bundle would be sealed over
# unsigned contents. Entitlements stay off the nested pass: they belong to the
# main executable, and a nested helper that needed its own would need its own
# file rather than this one.
while IFS= read -r -d '' nested; do
  echo "  nested: ${nested#$APP_PATH/}"
  sign --sign "$APPLE_SIGNING_IDENTITY" "$nested"
done < <(
  find "$APP_PATH/Contents" -depth \
    \( -name '*.dylib' -o -name '*.so' -o -name '*.framework' -o -name '*.app' \) \
    -print0
)

sign --entitlements "$ENTITLEMENTS" --sign "$APPLE_SIGNING_IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# --- 4. Notarize the app -----------------------------------------------------
# The app is notarized on its own (zipped) so the ticket can be stapled into
# the bundle before it is copied into the disk image.
mkdir -p "$DIST_DIR"

# `notarytool submit --wait` exits 0 for a finished submission even when the
# verdict is Invalid, so the status line has to be asserted explicitly —
# otherwise the first sign of trouble is a confusing `stapler` failure.
notarize() {
  local target="$1" out
  out="$(caffeinate -i xcrun notarytool submit "$target" \
    --keychain-profile "$NOTARY_PROFILE" --wait 2>&1)" || { echo "$out" >&2; return 1; }
  echo "$out"
  if ! grep -q 'status: Accepted' <<<"$out"; then
    local id
    id="$(sed -nE 's/.*id: ([0-9a-f-]{36}).*/\1/p' <<<"$out" | head -1)"
    die "notarization did not succeed for $target. Reasons: xcrun notarytool log ${id:-<submission-id>} --keychain-profile $NOTARY_PROFILE"
  fi
}

if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  step "Notarizing the app"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_PATH" "$ZIP_PATH"
  notarize "$ZIP_PATH"
  xcrun stapler staple "$APP_PATH"
  # The zip predates the staple, so the app inside it has no ticket. Leaving it
  # in dist/ next to the shippable dmg invites uploading the wrong artifact.
  rm -f "$ZIP_PATH"
fi

# --- 5. Disk image -----------------------------------------------------------
step "Building $DMG_PATH"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ditto "$APP_PATH" "$STAGING/$APP_NAME.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG_PATH"
caffeinate -i hdiutil create -volname "$APP_NAME $VERSION" -srcfolder "$STAGING" \
  -ov -format UDZO "$DMG_PATH" >/dev/null

codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"

if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  step "Notarizing the disk image"
  notarize "$DMG_PATH"
  xcrun stapler staple "$DMG_PATH"
fi

# --- 6. Verify as Gatekeeper sees it ----------------------------------------
step "Verifying"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  # `spctl -a` is the check that fails on the ad-hoc bundles: it wants a
  # Developer ID signature *and* a stapled notarization ticket.
  spctl --assess --type execute --verbose=4 "$APP_PATH"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"
  xcrun stapler validate "$APP_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

step "Done"
echo "  app: $APP_PATH"
echo "  dmg: $DMG_PATH"
if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  echo
  echo "  NOTE: --skip-notarize was used. This build is signed but NOT notarized;"
  echo "        Gatekeeper will still block it on other Macs."
fi

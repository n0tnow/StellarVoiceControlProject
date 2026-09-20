# Releasing Autonomy for macOS

Autonomy ships as a `.dmg` that people download from GitHub Releases. macOS
quarantines every downloaded bundle, so the release has to be **Developer ID
signed, hardened, notarized and stapled**. Anything less — including the ad-hoc
`codesign -s -` signature used up to v0.2.1 — makes Gatekeeper report the app as
"damaged and can't be opened" on any Mac other than the one that built it.

`scripts/release-macos.sh` (`make release-macos`) runs the whole pipeline.

## One-time setup

These two steps involve Apple credentials, so a human runs them once per
machine; the script only consumes their results.

### 1. Developer ID Application certificate

Requires a **paid** Apple Developer Program membership and the Account Holder or
Admin role. An "Apple Development" certificate is *not* a substitute — it only
signs builds for devices registered to the team.

- Xcode > Settings > Accounts > select the Apple ID > **Manage Certificates** >
  **+** > **Developer ID Application**, or
- create it at <https://developer.apple.com/account/resources/certificates> from
  a CSR and double-click the download to install it.

Confirm it landed in the login keychain:

```bash
security find-identity -v -p codesigning | grep 'Developer ID Application'
```

### 2. notarytool credential profile

Create an app-specific password at <https://account.apple.com> > Sign-In and
Security > App-Specific Passwords, then store it once:

```bash
xcrun notarytool store-credentials "autonomy-notary" \
  --apple-id "<apple-id-email>" --team-id "<TEAMID>" --password "<app-specific-password>"
```

The team ID is the `OU` field of the certificate:

```bash
security find-certificate -c "Developer ID Application" -p | openssl x509 -noout -subject
```

## Cutting a release

```bash
# 1. VERSION, app/src-tauri/tauri.conf.json and CHANGELOG.md all carry the version.
#    Bump them together, open the PR, merge it.

# 2. Build, sign, notarize, staple, verify. ~10 min including two Apple round trips.
make release-macos

# 3. Tag the merged release commit and publish.
git tag -a v<VERSION> -m "Autonomy v<VERSION>" && git push origin v<VERSION>
gh release create v<VERSION> dist/release/Autonomy_<VERSION>_arm64.dmg --notes-file <notes>
```

Useful flags while iterating:

| Flag | Effect |
|---|---|
| `--skip-build` | Re-sign the bundle already in `app/src-tauri/target/release/bundle/macos` |
| `--skip-notarize` | Sign only; skips both Apple round trips. **Output is not installable on other Macs.** |

Override `APPLE_SIGNING_IDENTITY` when the keychain holds more than one
Developer ID, and `NOTARY_PROFILE` when the credential profile is named
something other than `autonomy-notary`.

## What the script does, and why

1. **Resolves the identity** and fails loudly when only an `Apple Development`
   certificate is present — that is the mistake that produced the v0.2.1 release.
2. **Builds** via `npm run tauri:build`. Tauri ad-hoc signs the bundle; step 3
   replaces that signature.
3. **Signs inside-out** — nested Mach-O binaries first, then the bundle — with
   `--options runtime` (Hardened Runtime, required for notarization),
   `--timestamp` (a secure timestamp, so the signature outlives the certificate)
   and `app/src-tauri/Entitlements.plist`.
4. **Notarizes the app** as a zip and **staples** the ticket into the bundle, so
   the copy that ends up inside the disk image already carries it.
5. **Builds the `.dmg`** (app + `/Applications` symlink), signs it, notarizes and
   staples it too. Stapling both means first launch works offline.
6. **Verifies** with `codesign --verify --deep --strict`, `spctl --assess` and
   `stapler validate` — `spctl` is the check that an ad-hoc bundle fails.

## Entitlements

`app/src-tauri/Entitlements.plist` carries exactly one key:
`com.apple.security.device.audio-input`. Hardened Runtime revokes microphone
access unless it is granted explicitly, and Autonomy opens the input device
through `cpal` for push-to-talk. The `Info.plist` usage strings
(`NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`) are what
the system prompt displays; they do not replace the entitlement.

The app is deliberately **not** App Sandboxed — Developer ID distribution does
not require it, and the global `NSEvent` hotkey monitor needs Accessibility
rather than a sandbox exception.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `"Autonomy" is damaged and can't be opened` after download | Bundle is ad-hoc signed or the ticket was never stapled. Re-run the full pipeline. |
| notarytool status `Invalid` | Fetch the reasons: `xcrun notarytool log <submission-id> --keychain-profile autonomy-notary`. Usually a nested binary signed without `--options runtime`. |
| Microphone silent on a signed build only | `Entitlements.plist` missing from the `codesign` call. |
| `The signature does not include a secure timestamp` | `--timestamp` was omitted, or the build machine could not reach Apple's timestamp server. |

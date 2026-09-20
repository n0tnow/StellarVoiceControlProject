/**
 * Regenerates Polaris' app icon from the same blobatar the notch draws.
 *
 * Run from `app/`:
 *
 *   node scripts/generate-icon.mjs
 *
 * It is reproducible rather than a checked-in mystery binary: the seed and the
 * locked palette are imported straight from `src/notch/faceState.ts`, so the
 * icon and the in-app face can never drift onto two different characters. It
 * builds a 1024x1024 SVG (the blobatar on the shell's black), rasterises it with
 * macOS `sips`, and hands the PNG to `npx tauri icon`, which writes
 * `src-tauri/icons/`.
 *
 * macOS-only on purpose: `sips` is the system SVG rasteriser, and this app ships
 * only on macOS. If `sips` or the Tauri CLI is missing the script says so and
 * exits non-zero instead of producing a half-correct icon set.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { blobatarUri } from "blobatar/uri";

import { FACE_HUE, FACE_NAME, FACE_TONE } from "../src/notch/faceState.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const iconDir = path.join(appDir, "src-tauri", "icons");

/**
 * Share of the 100-unit viewBox the icon is framed to. The blobatar's body spans
 * ~15.5..84.2 on both axes, so an 8..92 crop leaves ~8 units (~9%) of black
 * margin all round — the glyph reads at Dock/Finder size without touching the
 * edge, and the square black tile matches the shell it belongs to.
 */
const VIEW_BOX = "8 9 84 84";
const SIZE = 1024;
const BACKGROUND = "#000000";

/** Decode the `blobatar/uri` data URI back into the SVG it wraps. */
function decode(uri) {
  const prefix = "data:image/svg+xml,";
  if (!uri.startsWith(prefix)) throw new Error(`unexpected uri prefix: ${uri.slice(0, 24)}`);
  return decodeURIComponent(uri.slice(prefix.length));
}

function buildIconSvg() {
  const uri = blobatarUri(FACE_NAME, {
    hue: FACE_HUE,
    tone: FACE_TONE,
    size: SIZE,
    background: false,
  });
  // The blobatar's own SVG is already 1024x1024; re-frame it and drop a black
  // plate behind the figure as the icon's first child.
  return decode(uri)
    .replace(/viewBox='[^']*'/, `viewBox='${VIEW_BOX}'`)
    .replace(
      /(<svg[^>]*>)/,
      `$1<rect x='0' y='0' width='100' height='100' fill='${BACKGROUND}'/>`,
    );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function main() {
  if (process.platform !== "darwin") {
    console.error("generate-icon: macOS only (needs `sips`); this app ships on macOS.");
    process.exit(1);
  }
  if (spawnSync("sips", ["--version"]).status !== 0) {
    console.error("generate-icon: `sips` is unavailable; cannot rasterise the SVG.");
    process.exit(1);
  }

  const work = mkdtempSync(path.join(tmpdir(), "polaris-icon-"));
  try {
    const svgPath = path.join(work, "polaris-icon.svg");
    const pngPath = path.join(work, "polaris-icon.png");
    writeFileSync(svgPath, buildIconSvg(), "utf8");

    run("sips", ["-s", "format", "png", svgPath, "--out", pngPath]);
    const png = readFileSync(pngPath);
    // PNG IHDR: width/height are the two big-endian u32s at offset 16/20.
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    if (width !== SIZE || height !== SIZE) {
      throw new Error(`expected a ${SIZE}x${SIZE} PNG, got ${width}x${height}`);
    }

    // `cwd: appDir` so the Tauri CLI finds `src-tauri/tauri.conf.json` and writes
    // the icon set to its configured icon directory.
    run("npx", ["tauri", "icon", pngPath], { cwd: appDir });
    pruneNonMacIcons();
    console.log(`generate-icon: wrote icon set to ${path.relative(appDir, iconDir)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * `tauri icon` emits the full cross-platform set. Polaris ships only on macOS —
 * `tauri.conf.json` lists four files and the repo tracks those plus `icon.png` —
 * so the Windows/Android/iOS output is removed rather than committed as noise.
 */
function pruneNonMacIcons() {
  const extras = [
    "android",
    "ios",
    "icon.ico",
    "64x64.png",
    "StoreLogo.png",
    "Square30x30Logo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square89x89Logo.png",
    "Square107x107Logo.png",
    "Square142x142Logo.png",
    "Square150x150Logo.png",
    "Square284x284Logo.png",
    "Square310x310Logo.png",
  ];
  for (const name of extras) {
    rmSync(path.join(iconDir, name), { recursive: true, force: true });
  }
}

main();

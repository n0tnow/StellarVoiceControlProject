# Autonomy landing page

A standalone, responsive product introduction. It uses semantic HTML and CSS, with no JavaScript runtime, build requirement, wallet connection, or desktop API dependency.

## Preview

From the repository root:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory landing
```

Open http://127.0.0.1:4173. The directory can also be deployed unchanged to any static host. DM Sans loads from Google Fonts; an installed Helvetica Neue / sans-serif fallback works offline.

## Add the demo

The demo area intentionally says “Demo coming soon.” When the video is supplied, replace `.demo-frame` in `index.html` with a native `<video controls preload="metadata" poster="...">` and a video source, remove its placeholder ARIA label, and update the adjacent coming-soon copy. Provide captions for narration and retain the 16:9 aspect ratio. No fake player or unavailable download is advertised.

Card artwork is created in CSS and illustrates product concepts; it is not a screenshot or a live wallet. Product remains a macOS / Stellar testnet prototype.

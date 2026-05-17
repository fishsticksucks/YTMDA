# YMDA — YouTube Music Desktop App
---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Run the app
npm start
```

> Requires Node.js 18+ and Git. Electron will be downloaded on first `npm install` (~100MB).

---

## Features

### ✦ Custom Chrome
- Frameless window with a custom dark titlebar
- Windows-native window controls (min/max/close)
- YouTube Music loads in a persistent webview — your login is saved across sessions

### ✦ Synced Lyrics Panel
- Click the **♫** button in the titlebar to toggle the lyrics panel
- Lyrics are automatically fetched from [LRClib](https://lrclib.net) (free, no API key)
- Apple Music-style display: active line is bold + white + glowing, past lines are dimmed, smooth scroll tracks playback
- Falls back to plain lyrics if time-synced aren't available

### ✦ OBS Browser Source Overlay
- A local HTTP server runs at `http://localhost:6969`
- In OBS: **Add Source → Browser Source → URL: `http://localhost:6969`**
- Set size to 480×120 (or wider), enable **"Refresh browser when scene becomes active"**
- Shows: album art, title, artist, current lyric line, progress bar
- Updates every second in real time

---

## Project Structure

```
ymda/
├── src/
│   ├── main/
│   │   ├── main.js          # Electron main process, OBS server, LRClib fetcher
│   │   └── preload.js       # Context bridge (IPC) between main and renderer
│   ├── renderer/
│   │   ├── index.html       # App shell — titlebar + webview + lyrics panel
│   │   ├── style.css        # Dark theme, lyrics animations
│   │   └── renderer.js      # Song detection, lyrics engine, overlay sync
│   └── overlay/
│       └── overlay.html     # OBS browser source page
└── package.json
```

---


## Notes

- YTM song detection works by injecting a script into the webview DOM. If YTM ever changes their player markup, selectors in `renderer.js → INJECT_SCRIPT` may need updating.
- LRClib has no rate limits for reasonable use, but it may not have every song (especially deep cuts or new releases).

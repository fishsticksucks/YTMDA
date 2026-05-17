const { app, BrowserWindow, ipcMain, session, nativeTheme, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

nativeTheme.themeSource = 'dark';

let mainWindow;
let overlayData = { title: '', artist: '', album: '', albumArt: '', lyric: '', progress: 0, duration: 0 };

// ─── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(app.getPath('userData'), 'ymda-settings.json');

const DEFAULT_SETTINGS = {
  lyricsSources: ['lrclib', 'musixmatch', 'netease', 'ovh'],
  obsPort: 6969,
  fontSize: 22,
  accentColor: '#ff4444',
  overlayPosition: 'bottom-left',
  discordRpc: false,
  discordClientId: '',
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH))
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch (_) {}
}

let settings = loadSettings();

// ─── OBS HTTP Server ──────────────────────────────────────────────────────────
let obsServer = null;

function startOBSServer(port) {
  if (obsServer) { try { obsServer.close(); } catch (_) {} obsServer = null; }
  obsServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/data') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...overlayData, overlayPosition: settings.overlayPosition }));
      return;
    }
    const overlayPath = path.join(__dirname, '../overlay/overlay.html');
    if (fs.existsSync(overlayPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(overlayPath).pipe(res);
    } else { res.writeHead(404); res.end('Not found'); }
  });

  obsServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[YMDA] Port ${port} in use, trying ${port + 1}`);
      obsServer.close();
      startOBSServer(port + 1);
    } else {
      console.error('[YMDA] OBS server error:', err.message);
    }
  });

  obsServer.listen(port, '127.0.0.1', () => {
    const actualPort = obsServer.address().port;
    settings.obsPort = actualPort; // update in memory so UI reflects real port
    console.log(`[YMDA] OBS server → http://localhost:${actualPort}`);
    mainWindow?.webContents.send('settings-updated', settings);
  });
}

// ─── Discord Rich Presence ────────────────────────────────────────────────────
// You need a Discord App ID from https://discord.com/developers/applications
// Create a new app, copy the Client ID, paste it in YMDA Settings → Discord.
// No redirect URIs or bot setup needed — just the Client ID.

let rpc = null;
let rpcConnected = false;
let rpcRetryTimer = null;
let rpcCurrentActivity = null;
let songStartTime = null;
let lastRpcKey = '';

async function connectDiscord() {
  if (!settings.discordRpc) return;

  const clientId = settings.discordClientId?.trim();
  if (!clientId) {
    console.warn('[YMDA] Discord RPC: no Client ID set. Add one in Settings → Discord.');
    mainWindow?.webContents.send('discord-rpc-state', 'no-client-id');
    return;
  }

  try {
    const DiscordRPC = require('discord-rpc');
    DiscordRPC.register(clientId);
    rpc = new DiscordRPC.Client({ transport: 'ipc' });

    rpc.on('ready', () => {
      rpcConnected = true;
      console.log('[YMDA] Discord RPC connected');
      mainWindow?.webContents.send('discord-rpc-state', 'connected');
      if (rpcCurrentActivity) rpc.setActivity(rpcCurrentActivity).catch(() => {});
    });

    rpc.on('disconnected', () => {
      rpcConnected = false;
      console.log('[YMDA] Discord RPC disconnected');
      mainWindow?.webContents.send('discord-rpc-state', 'disconnected');
      scheduleRpcRetry();
    });

    await rpc.login({ clientId });
  } catch (err) {
    console.warn('[YMDA] Discord RPC connect failed:', err.message);
    mainWindow?.webContents.send('discord-rpc-state', 'error');
    scheduleRpcRetry();
  }
}

function scheduleRpcRetry() {
  if (rpcRetryTimer) return;
  rpcRetryTimer = setTimeout(() => {
    rpcRetryTimer = null;
    if (settings.discordRpc) connectDiscord();
  }, 15000);
}

function disconnectDiscord() {
  if (rpcRetryTimer) { clearTimeout(rpcRetryTimer); rpcRetryTimer = null; }
  if (rpc) {
    try { rpc.clearActivity(); rpc.destroy(); } catch (_) {}
    rpc = null;
  }
  rpcConnected = false;
  mainWindow?.webContents.send('discord-rpc-state', 'disconnected');
}

function updateDiscordActivity({ title, artist, album, albumArt, progress, duration }) {
  if (!settings.discordRpc || !rpcConnected || !rpc) return;
  const key = `${title}::${artist}`;

  if (key !== lastRpcKey) {
    songStartTime = Date.now() - Math.round(progress * 1000);
    lastRpcKey = key;
  }

  const now = Date.now();
  const endTime = duration > 0 ? songStartTime + Math.round(duration * 1000) : undefined;

  const activity = {
    type: 2,                                    // 2 = Listening (shows "Listening to" instead of "Playing")
    details: title || 'Unknown Track',          // Song title — big line
    state: artist || 'YouTube Music',           // Artist — small line
    startTimestamp: songStartTime,              // Elapsed time from song start
    largeImageKey: 'ytmusic_logo',
    largeImageText: album || 'YouTube Music',
    smallImageKey: 'playing',
    smallImageText: 'Via YMDA',
    instance: false,
    buttons: [
      { label: '▶ Open YouTube Music', url: 'https://music.youtube.com' },
    ],
  };

  // discord-rpc v4 supports passing URLs directly via type 1 assets
  // Try to set album art as external image if URL looks valid
  if (albumArt && albumArt.startsWith('http')) {
    activity.largeImageKey = albumArt;
  }

  rpcCurrentActivity = activity;
  rpc.setActivity(activity).catch(err => {
    console.warn('[YMDA] RPC setActivity failed:', err.message);
  });
}

function clearDiscordActivity() {
  if (!rpcConnected || !rpc) return;
  rpcCurrentActivity = null;
  lastRpcKey = '';
  rpc.clearActivity().catch(() => {});
}

// ─── LRC Parser ───────────────────────────────────────────────────────────────
function parseLRC(lrc) {
  const lines = [];
  const regex = /\[(\d+):(\d+(?:\.\d+)?)\](.*)/;
  for (const line of lrc.split('\n')) {
    const m = line.match(regex);
    if (m) lines.push({ time: parseInt(m[1]) * 60 + parseFloat(m[2]), text: m[3].trim() });
  }
  return lines.sort((a, b) => a.time - b.time);
}

function plainLines(text) {
  return text.split('\n').map(l => ({ time: null, text: l.trim() })).filter(l => l.text);
}

// ─── Matching Utilities ───────────────────────────────────────────────────────
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, '')        // strip (feat. xxx), (remix), etc.
    .replace(/\[.*?\]/g, '')        // strip [explicit], [live], etc.
    .replace(/[^\w\s]/g, '')        // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

// Returns 0–1 similarity score between two strings
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  // word overlap
  const wa = new Set(a.split(' ').filter(w => w.length > 1));
  const wb = new Set(b.split(' ').filter(w => w.length > 1));
  if (wa.size === 0 || wb.size === 0) return a === b ? 1 : 0;
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / Math.max(wa.size, wb.size);
}

function isGoodMatch(title, artist, rTitle, rArtist) {
  const ts = similarity(title, rTitle);
  const as = similarity(artist, rArtist);
  // Short artist names (like "cfx", "SZA") need exact match
  const artistOk = normalize(artist).length <= 4
    ? normalize(artist) === normalize(rArtist)
    : as >= 0.35;
  return ts >= 0.75 && artistOk;
}

// ─── Lyrics Cache ─────────────────────────────────────────────────────────────
const lyricsCache = new Map(); // key → result | null

function cacheKey(title, artist) {
  return `${normalize(title)}::${normalize(artist)}`;
}

// ─── Source: LRClib ──────────────────────────────────────────────────────────
async function fetchLRClib(title, artist, album) {
  const headers = { 'Lrclib-Client': 'YMDA v1.0' };

  // Try exact lookup variants (no duration — causes mismatches)
  const attempts = [
    { track_name: title, artist_name: artist },
  ];
  if (album) attempts.unshift({ track_name: title, artist_name: artist, album_name: album });

  for (const p of attempts) {
    try {
      const res = await fetch(`https://lrclib.net/api/get?${new URLSearchParams(p)}`, { headers });
      console.log(`[YMDA] LRClib /get status: ${res.status} for`, JSON.stringify(p));
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.error) { console.log('[YMDA] LRClib /get error:', data.error); continue; }
      console.log(`[YMDA] LRClib /get returned: "${data.trackName}" by "${data.artistName}" synced:${!!data.syncedLyrics} plain:${!!data.plainLyrics}`);
      if (!isGoodMatch(title, artist, data.trackName, data.artistName)) {
        console.log(`[YMDA] LRClib /get rejected — similarity too low`);
        continue;
      }
      if (data.syncedLyrics) return { type: 'synced', lines: parseLRC(data.syncedLyrics), source: 'LRClib' };
      if (data.plainLyrics)  return { type: 'plain',  lines: plainLines(data.plainLyrics),  source: 'LRClib' };
    } catch (e) { console.log('[YMDA] LRClib /get threw:', e.message); }
  }

  // Search fallback with strict validation
  try {
    const res = await fetch(
      `https://lrclib.net/api/search?q=${encodeURIComponent(`${artist} ${title}`)}`,
      { headers }
    );
    if (!res.ok) return null;
    const results = await res.json();
    if (!results?.length) return null;

    // Score and filter
    const candidates = results
      .map(r => ({
        r,
        ts: similarity(title, r.trackName),
        as: similarity(artist, r.artistName),
      }))
      .filter(({ ts, as, r }) => isGoodMatch(title, artist, r.trackName, r.artistName))
      .sort((a, b) => {
        const scoreA = a.ts + a.as * 0.5 + (a.r.syncedLyrics ? 0.2 : 0);
        const scoreB = b.ts + b.as * 0.5 + (b.r.syncedLyrics ? 0.2 : 0);
        return scoreB - scoreA;
      });

    if (!candidates.length) {
      console.log(`[YMDA] LRClib search: no confident match for "${title}" by "${artist}"`);
      return null;
    }

    const { r } = candidates[0];
    console.log(`[YMDA] LRClib matched: "${r.trackName}" by "${r.artistName}"`);
    if (r.syncedLyrics) return { type: 'synced', lines: parseLRC(r.syncedLyrics), source: 'LRClib' };
    if (r.plainLyrics)  return { type: 'plain',  lines: plainLines(r.plainLyrics),  source: 'LRClib' };
  } catch (_) {}

  return null;
}

// ─── Source: Musixmatch ───────────────────────────────────────────────────────
let MXM_TOKEN = '2005218b74f939209bda92cb633c7380612e9e31a50b1f2e4a2b9';
const MXM_BASE  = 'https://apic-desktop.musixmatch.com/ws/1.1';
const MXM_HEADERS = {
  'authority': 'apic-desktop.musixmatch.com',
  'cookie': 'x-mxm-token-guid=',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};
let mxmTokenFetched = false;

async function refreshMXMToken() {
  try {
    for (const app_id of ['web-desktop-app-v1.0', 'mac-ios-v2.0', 'android-player-v1.0']) {
      const res = await fetch(
        `https://apic.musixmatch.com/ws/1.1/token.get?app_id=${app_id}&format=json`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const token = data?.message?.body?.user_token;
      if (token && token !== 'UpgradeMe') {
        MXM_TOKEN = token;
        console.log(`[YMDA] Fresh Musixmatch token via ${app_id}`);
        return true;
      }
    }
  } catch (err) {
    console.warn('[YMDA] MXM token refresh failed:', err.message);
  }
  return false;
}

async function mxmFetch(endpoint, params) {
  if (!mxmTokenFetched) { mxmTokenFetched = true; await refreshMXMToken(); }
  const makeReq = (token) => {
    const p = new URLSearchParams({ ...params, usertoken: token, app_id: 'web-desktop-app-v1.0', format: 'json' });
    return fetch(`${MXM_BASE}/${endpoint}?${p}`, { headers: MXM_HEADERS });
  };
  let res = await makeReq(MXM_TOKEN);
  if (res.status === 401 || res.status === 403) {
    const ok = await refreshMXMToken();
    if (ok) res = await makeReq(MXM_TOKEN);
  }
  if (!res.ok) throw new Error(`MXM ${res.status}`);
  return res.json();
}

async function fetchMusixmatch(title, artist) {
  try {
    const matchData = await mxmFetch('macro.subtitles.get', { q_track: title, q_artist: artist, q_artists: artist });
    const body = matchData?.message?.body?.macro_calls;

    // Validate matched track
    const track = body?.['matcher.track.get']?.message?.body?.track;
    console.log(`[YMDA] MXM matched track: "${track?.track_name}" by "${track?.artist_name}"`);
    if (track) {
      if (!isGoodMatch(title, artist, track.track_name, track.artist_name)) {
        console.log(`[YMDA] Musixmatch rejected — similarity too low`);
        return null;
      }
    }

    // Try synced
    const subtitleList = body?.['track.subtitles.get']?.message?.body?.subtitle_list;
    if (subtitleList?.length) {
      try {
        const raw = JSON.parse(subtitleList[0].subtitle.subtitle_body);
        const lines = raw.map(l => ({ time: l.time.total, text: l.text || '' })).filter(l => l.text.trim());
        if (lines.length) return { type: 'synced', lines, source: 'Musixmatch' };
      } catch (_) {}
    }

    // Try plain
    const lyricsBody = body?.['track.lyrics.get']?.message?.body?.lyrics?.lyrics_body;
    if (lyricsBody) {
      const clean = lyricsBody.replace(/\*{7}.*$/s, '').trim();
      if (clean) return { type: 'plain', lines: plainLines(clean), source: 'Musixmatch' };
    }
  } catch (err) {
    console.warn('[YMDA] Musixmatch error:', err.message);
  }
  return null;
}

// ─── Source: NetEase ──────────────────────────────────────────────────────────
async function fetchNetEase(title, artist) {
  try {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://music.163.com/' };
    const sRes = await fetch(
      `https://music.163.com/api/search/get?s=${encodeURIComponent(`${artist} ${title}`)}&type=1&limit=5`,
      { headers }
    );
    if (!sRes.ok) return null;
    const songs = (await sRes.json())?.result?.songs;
    if (!songs?.length) return null;

    const best = songs.find(s =>
      isGoodMatch(title, artist, s.name, s.artists?.[0]?.name || '')
    );
    if (!best) {
      console.log(`[YMDA] NetEase: no confident match for "${title}" by "${artist}"`);
      return null;
    }

    const lRes = await fetch(`https://music.163.com/api/song/lyric?id=${best.id}&lv=1&kv=1&tv=-1`, { headers });
    if (!lRes.ok) return null;
    const lrc = (await lRes.json())?.lrc?.lyric;
    if (lrc) {
      const lines = parseLRC(lrc).filter(l => l.text && !/^(作词|作曲|编曲|制作人|Guitar|Bass|Drum|Mixed|Mastered)/.test(l.text));
      if (lines.length > 2) return { type: 'synced', lines, source: 'NetEase' };
    }
  } catch (_) {}
  return null;
}

// ─── Source: lyrics.ovh ───────────────────────────────────────────────────────
async function fetchOVH(title, artist) {
  try {
    const res = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.lyrics) return { type: 'plain', lines: plainLines(data.lyrics), source: 'lyrics.ovh' };
  } catch (_) {}
  return null;
}

// ─── Master Fetch — parallel with timeout ────────────────────────────────────
const SOURCE_FNS = {
  lrclib:     (t, a, al) => fetchLRClib(t, a, al),
  musixmatch: (t, a)     => fetchMusixmatch(t, a),
  netease:    (t, a)     => fetchNetEase(t, a),
  ovh:        (t, a)     => fetchOVH(t, a),
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(null), ms)),
  ]);
}

async function fetchLyrics({ title, artist, album }) {
  const key = cacheKey(title, artist);
  if (lyricsCache.has(key)) {
    const cached = lyricsCache.get(key);
    console.log(`[YMDA] Cache hit: "${title}" → ${cached ? cached.source : 'no lyrics'}`);
    return cached;
  }

  const order = settings.lyricsSources?.length ? settings.lyricsSources : DEFAULT_SETTINGS.lyricsSources;

  // Run synced-capable sources in parallel, plain sources as fallback
  const syncedSources = order.filter(s => ['lrclib', 'musixmatch', 'netease'].includes(s));
  const plainSources  = order.filter(s => ['ovh'].includes(s));

  // Race all synced sources simultaneously
  console.log(`[YMDA] Fetching lyrics for "${title}" by "${artist}" — racing: ${syncedSources.join(', ')}`);
  const syncedResults = await Promise.all(
    syncedSources.map(src => SOURCE_FNS[src]
      ? withTimeout(SOURCE_FNS[src](title, artist, album).catch(() => null), 5000)
      : Promise.resolve(null)
    )
  );

  // Prefer synced over plain from the parallel results
  const synced = syncedResults.find(r => r?.type === 'synced');
  const plain  = syncedResults.find(r => r?.type === 'plain');
  const result = synced || plain || null;

  if (result) {
    console.log(`[YMDA] ✓ ${result.source} — ${result.type} (${result.lines.length} lines)`);
    lyricsCache.set(key, result);
    return result;
  }

  // Fallback to plain-only sources sequentially
  for (const src of plainSources) {
    if (!SOURCE_FNS[src]) continue;
    try {
      const r = await withTimeout(SOURCE_FNS[src](title, artist, album), 4000);
      if (r) {
        console.log(`[YMDA] ✓ ${r.source} (fallback) — ${r.type} (${r.lines.length} lines)`);
        lyricsCache.set(key, r);
        return r;
      }
    } catch (_) {}
  }

  console.log(`[YMDA] No lyrics found for "${title}" by "${artist}"`);
  lyricsCache.set(key, null); // cache miss so we don't retry every time
  return null;
}

// ─── Login via Default Browser ────────────────────────────────────────────
ipcMain.handle('open-browser-login', async () => {
  await shell.openExternal('https://music.youtube.com');
  return { success: true };
});

ipcMain.handle('import-cookies-from-browser', async () => {
  const { execSync } = require('child_process');
  const tmpPath = path.join(app.getPath('temp'), 'ymda-cookie-import.db');

  // ── Find cookie file ──────────────────────────────────────────────────────
  // Firefox uses a different profile folder structure
  function findFirefoxCookies() {
    const profilesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
    if (!fs.existsSync(profilesDir)) return null;
    // Pick the default-release profile, then any profile
    const profiles = fs.readdirSync(profilesDir);
    const preferred = profiles.find(p => p.endsWith('.default-release')) || profiles[0];
    if (!preferred) return null;
    const cookiePath = path.join(profilesDir, preferred, 'cookies.sqlite');
    return fs.existsSync(cookiePath) ? cookiePath : null;
  }

  // Build Chrome paths for all profiles (Default, Profile 1, Profile 2, etc.)
  function chromePaths(base) {
    const paths = [];
    const userDataDir = path.join(os.homedir(), 'AppData', 'Local', base);
    if (!fs.existsSync(userDataDir)) return paths;
    const entries = fs.readdirSync(userDataDir).filter(e =>
      e === 'Default' || e.startsWith('Profile')
    );
    for (const profile of entries) {
      paths.push(path.join(userDataDir, profile, 'Network', 'Cookies'));
      paths.push(path.join(userDataDir, profile, 'Cookies'));
    }
    return paths;
  }

  const sources = [
    { name: 'Chrome', paths: chromePaths('Google\\Chrome\\User Data') },
    { name: 'Chrome Beta', paths: chromePaths('Google\\Chrome Beta\\User Data') },
    { name: 'Firefox', paths: [findFirefoxCookies()].filter(Boolean), isFirefox: true },
    { name: 'Brave', paths: chromePaths('BraveSoftware\\Brave-Browser\\User Data') },
    { name: 'Edge', paths: chromePaths('Microsoft\\Edge\\User Data') },
  ];

  let usedBrowser = null;
  let isFirefox = false;

  function tryReadLocked(p) {
    // Try direct read first
    try { return fs.readFileSync(p); } catch (_) {}
    // PowerShell fallback for locked files (WAL mode browsers)
    try {
      const escaped = p.replace(/'/g, "''");
      const tmpEsc  = tmpPath.replace(/'/g, "''");
      const ps = `[System.IO.File]::Open('${escaped}','Open','Read','ReadWrite') | % { $d = [System.IO.File]::OpenWrite('${tmpEsc}'); $_.CopyTo($d); $d.Close(); $_.Close() }`;
      execSync(`powershell -NoProfile -WindowStyle Hidden -Command "${ps}"`, { timeout: 8000 });
      if (fs.existsSync(tmpPath)) return fs.readFileSync(tmpPath);
    } catch (_) {}
    return null;
  }

  let buf = null;
  for (const src of sources) {
    for (const p of src.paths) {
      if (!p || !fs.existsSync(p)) continue;
      // For Firefox, also copy the -wal file so WAL mode works
      if (src.isFirefox) {
        const walPath = p + '-wal';
        try {
          fs.copyFileSync(p, tmpPath);
          if (fs.existsSync(walPath)) fs.copyFileSync(walPath, tmpPath + '-wal');
          buf = fs.readFileSync(tmpPath);
        } catch (_) {
          buf = tryReadLocked(p);
        }
      } else {
        buf = tryReadLocked(p);
      }
      if (buf) { usedBrowser = src.name; isFirefox = src.isFirefox || false; break; }
    }
    if (usedBrowser) break;
  }

  if (!usedBrowser || !buf)
    return { success: false, error: 'Could not find cookies from Chrome, Firefox, Brave, or Edge.\nMake sure you have logged into YouTube Music in one of those browsers.' };

  try { fs.writeFileSync(tmpPath, buf); } catch (err) {
    return { success: false, error: 'Temp write failed: ' + err.message };
  }

  // ── Read with sql.js ──────────────────────────────────────────────────────
  let rows = [];
  try {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const uint8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const db = new SQL.Database(uint8);

    if (isFirefox) {
      // Firefox schema: moz_cookies table, different column names
      // Only import the specific cookies YTM needs — not all google.com cookies
      // (too many causes 413 errors)
      const ESSENTIAL = ['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID',
        '__Secure-3PSID','__Secure-1PAPISID','__Secure-3PAPISID','LOGIN_INFO',
        'VISITOR_INFO1_LIVE','YSC','PREF','GPS','CONSENT','__Secure-YEC',
        '__Secure-1PSIDTS','__Secure-3PSIDTS','NID','SIDCC',
        '__Secure-1PSIDCC','__Secure-3PSIDCC'];
      const inList = ESSENTIAL.map(n => `'${n}'`).join(',');
      const result = db.exec(`
        SELECT host, name, value, path, expiry, isSecure, isHttpOnly
        FROM moz_cookies
        WHERE (host LIKE '%youtube.com%' OR host LIKE '%google.com%')
          AND value != ''
          AND name IN (${inList})
      `);
      if (result.length) {
        rows = result[0].values.map(r => Object.fromEntries(result[0].columns.map((c, i) => [c, r[i]])));
      }
    } else {
      // Chrome/Edge/Brave schema
      const ESSENTIAL = ['SID','HSID','SSID','APISID','SAPISID','__Secure-1PSID',
        '__Secure-3PSID','__Secure-1PAPISID','__Secure-3PAPISID','LOGIN_INFO',
        'VISITOR_INFO1_LIVE','YSC','PREF','GPS','CONSENT','__Secure-YEC',
        '__Secure-1PSIDTS','__Secure-3PSIDTS','NID','SIDCC',
        '__Secure-1PSIDCC','__Secure-3PSIDCC'];
      const inList = ESSENTIAL.map(n => `'${n}'`).join(',');
      const result = db.exec(`
        SELECT host_key, name, value, path, expires_utc, is_secure, is_httponly
        FROM cookies
        WHERE (host_key LIKE '%youtube.com%' OR host_key LIKE '%google.com%')
          AND value != ''
          AND name IN (${inList})
      `);
      if (result.length) {
        rows = result[0].values.map(r => Object.fromEntries(result[0].columns.map((c, i) => [c, r[i]])));
      }
    }
    db.close();
  } catch (err) {
    return { success: false, error: 'Could not parse cookie database: ' + err.message };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    try { fs.unlinkSync(tmpPath + '-wal'); } catch (_) {}
  }

  // ── Inject cookies into session ───────────────────────────────────────────
  let imported = 0;
  for (const row of rows) {
    try {
      let cookieData;
      if (isFirefox) {
        cookieData = {
          url: `https://${row.host.replace(/^\./, '')}`,
          name: row.name, value: row.value,
          domain: row.host, path: row.path || '/',
          secure: !!row.isSecure, httpOnly: !!row.isHttpOnly,
          expirationDate: row.expiry > 0 ? row.expiry : undefined,
        };
      } else {
        const exp = row.expires_utc ? (row.expires_utc / 1000000) - 11644473600 : undefined;
        cookieData = {
          url: `https://${row.host_key.replace(/^\./, '')}`,
          name: row.name, value: row.value,
          domain: row.host_key, path: row.path || '/',
          secure: !!row.is_secure, httpOnly: !!row.is_httponly,
          expirationDate: exp && exp > Date.now() / 1000 ? exp : undefined,
        };
      }
      await session.defaultSession.cookies.set(cookieData);
      imported++;
    } catch (_) {}
  }

  console.log(`[YMDA] Imported ${imported} cookies from ${usedBrowser}`);
  mainWindow?.webContents.send('reload-ytm');
  return { success: true, imported, browser: usedBrowser };
});

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.handle('fetch-lyrics', async (_, meta) => fetchLyrics(meta));
ipcMain.on('update-overlay', (_, data) => {
  overlayData = { ...overlayData, ...data };
  if (data.title) updateDiscordActivity(overlayData);
  else clearDiscordActivity();
});

ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (_, newSettings) => {
  const prevPort = settings.obsPort;
  const prevRpc  = settings.discordRpc;
  settings = { ...settings, ...newSettings };
  saveSettings(settings);
  if (settings.obsPort !== prevPort) startOBSServer(settings.obsPort);
  if (settings.discordRpc && !prevRpc) connectDiscord();
  if (!settings.discordRpc && prevRpc) disconnectDiscord();
  mainWindow?.webContents.send('settings-updated', settings);
  return settings;
});

ipcMain.on('open-external', (_, url) => shell.openExternal(url));
ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () =>
  mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()
);
ipcMain.on('window-close', () => mainWindow?.close());

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, minWidth: 920, minHeight: 600,
    frame: false,
    show: false,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      webSecurity: false,
    },
  });

  // Use default session for the webview so Google login works
  // (persist:ytm partition gets flagged; default session doesn't)
  session.defaultSession.setUserAgent(UA);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = UA;
    details.requestHeaders['sec-ch-ua'] = '"Google Chrome";v="120", "Chromium";v="120", "Not-A.Brand";v="99"';
    details.requestHeaders['sec-ch-ua-mobile'] = '?0';
    details.requestHeaders['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['x-frame-options'];
    delete headers['X-Frame-Options'];
    headers['content-security-policy'] = ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"];
    callback({ responseHeaders: headers });
  });

  // Inject fingerprint spoof preload into the YTM webview
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'ytm-preload.js');
    webPreferences.contextIsolation = false;
    // Remove partition — use default session so Google login works
    delete webPreferences.partition;
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => mainWindow.webContents.send('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-state', 'normal'));
}

ipcMain.on('lyrics-panel-toggle', (_, open) => {});
ipcMain.handle('ytm-execute', async () => null);


app.whenReady().then(() => {
  createWindow();
  startOBSServer(settings.obsPort);
  if (settings.discordRpc) connectDiscord();
});

app.on('window-all-closed', () => {
  if (obsServer) { try { obsServer.close(); } catch (_) {} }
  disconnectDiscord();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

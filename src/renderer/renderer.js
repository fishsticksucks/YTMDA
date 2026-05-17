// ─── YMDA Renderer ────────────────────────────────────────────────────────────

const webview        = document.getElementById('ytm-webview');
const lyricsPanel    = document.getElementById('lyrics-panel');
const lyricsLines    = document.getElementById('lyrics-lines');
const lyricsTitleEl  = document.getElementById('lyrics-title');
const lyricsArtistEl = document.getElementById('lyrics-artist');
const lyricsTypeBadge = document.getElementById('lyrics-type-badge');
const lyricsSrcBadge  = document.getElementById('lyrics-src-badge');
const lyricsBody      = document.getElementById('lyrics-body');
const lyricsPill      = document.getElementById('lyrics-source-pill');
const stateLoading    = document.getElementById('lyrics-state-loading');
const stateEmpty      = document.getElementById('lyrics-state-empty');
const stateIdle       = document.getElementById('lyrics-state-idle');
const obsPortLabel    = document.getElementById('obs-port-label');

// ─── State ────────────────────────────────────────────────────────────────────
let settings      = {};
let lyricsOpen    = false;
let currentKey    = '';
let syncedLines   = [];
let lyricsType    = null;
let currentIdx    = -1;
let pollTimer     = null;

// ─── Source metadata (for settings UI) ───────────────────────────────────────
const SOURCE_META = {
  lrclib:     { name: 'LRClib',      desc: 'Open lyrics database — best for synced',  type: 'both' },
  musixmatch: { name: 'Musixmatch',  desc: 'DistroKid / Spotify source, huge catalog', type: 'both' },
  netease:    { name: 'NetEase',     desc: 'Great for Asian artists & K-pop',          type: 'synced' },
  ovh:        { name: 'lyrics.ovh',  desc: 'Plain lyrics fallback, broad catalog',     type: 'plain' },
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  settings = await window.ymda.getSettings();
  applySettings(settings);

  window.ymda.onWindowState(s => {
    document.getElementById('btn-max').textContent = s === 'maximized' ? '❐' : '□';
  });

  window.ymda.onSettingsUpdate(s => {
    settings = s;
    applySettings(s);
  });

  window.ymda.onDiscordState(state => {
    const dot  = document.getElementById('discord-rpc-status');
    const text = document.getElementById('discord-rpc-status-text');
    const states = {
      'connected':    { cls: 'connected',    label: 'Connected' },
      'disconnected': { cls: 'disconnected', label: 'Disconnected' },
      'error':        { cls: 'disconnected', label: 'Failed — is Discord open?' },
      'no-client-id': { cls: 'disconnected', label: 'Enter a Client ID first' },
    };
    const s = states[state] || states.disconnected;
    if (dot)  dot.className  = `discord-status-dot ${s.cls}`;
    if (text) text.textContent = s.label;
  });

  document.getElementById('btn-back').onclick = () => {
    const wv = document.getElementById('ytm-webview');
    if (wv && wv.canGoBack()) wv.goBack();
  };

  document.getElementById('btn-import-login').onclick = doImportCookies;

  // Login banner
  const loginBanner = document.getElementById('login-banner');
  document.getElementById('login-banner-open').onclick = async () => {
    await window.ymda.openBrowserLogin();
    // Update banner to guide user to next step
    document.getElementById('login-banner-text').innerHTML =
      '<strong>Signed in? Click "Done, import"</strong><span>Log into YouTube Music in your browser, then come back here.</span>';
  };
  document.getElementById('login-banner-import').onclick = doImportCookies;
  document.getElementById('login-banner-dismiss').onclick = () => loginBanner.classList.add('hidden');

  window.ymda.onReloadYTM(() => {
    const wv = document.getElementById('ytm-webview');
    if (wv) wv.src = 'https://music.youtube.com';
  });

  // Titlebar buttons
  document.getElementById('btn-min').onclick  = () => window.ymda.minimize();
  document.getElementById('btn-max').onclick  = () => window.ymda.maximize();
  document.getElementById('btn-close').onclick = () => window.ymda.close();
  document.getElementById('btn-lyrics').onclick   = toggleLyrics;
  document.getElementById('btn-settings').onclick = openSettings;

async function doImportCookies() {
  const btn = document.getElementById('btn-import-login');
  const banner = document.getElementById('login-banner');
  btn.style.color = 'var(--accent)';
  const result = await window.ymda.importCookiesFromBrowser();
  if (result.success) {
    btn.style.color = '#4ade80';
    banner.classList.add('hidden');
    setTimeout(() => { btn.style.color = ''; }, 3000);
    console.log(`[YMDA] Imported ${result.imported} cookies from ${result.browser}`);
  } else {
    btn.style.color = '#f87171';
    setTimeout(() => { btn.style.color = ''; }, 3000);
    document.getElementById('login-banner-text').innerHTML =
      `<strong>Import failed</strong><span>${result.error}</span>`;
    banner.classList.remove('hidden');
  }
}

  webview.addEventListener('dom-ready', () => {
    // Force player controls visible — YTM sometimes hides them at certain window sizes
    webview.insertCSS(`
      /* Force all player controls visible regardless of window size */
      ytmusic-player-bar {
        --ytmusic-player-bar-background: #030303;
      }
      .middle-controls-buttons,
      .middle-controls,
      #left-controls,
      #right-controls,
      .left-controls,
      .right-controls,
      tp-yt-paper-icon-button,
      ytmusic-player-bar tp-yt-paper-icon-button,
      ytmusic-player-bar #play-pause-button,
      ytmusic-player-bar #skip-back-button,
      ytmusic-player-bar #skip-forward-button,
      ytmusic-player-bar .prev-button,
      ytmusic-player-bar .next-button {
        display: flex !important;
        visibility: visible !important;
        opacity: 1 !important;
        pointer-events: all !important;
      }
      /* Prevent controls from collapsing at narrow widths */
      ytmusic-player-bar .content-info-wrapper {
        flex: 1 1 200px !important;
        min-width: 0 !important;
      }
      ytmusic-player-bar .middle-controls {
        flex: 0 0 auto !important;
      }
    `).catch(() => {});
    showState('idle');
    startPolling();
    setTimeout(() => checkLoginState(), 4000);
  });
  setTimeout(startPolling, 4000);

async function checkLoginState() {
  try {
    const isLoggedIn = await webview.executeJavaScript(`
      // Signed in = avatar button exists, sign-in button does NOT
      const hasAvatar = !!document.querySelector('#avatar-btn, ytmusic-settings-button img, .ytmusic-settings-button img');
      const hasSignIn = !!document.querySelector('ytmusic-sign-in-card, a[href*="ServiceLogin"], [aria-label="Sign in"]');
      hasAvatar || !hasSignIn;
    `);
    const banner = document.getElementById('login-banner');
    if (banner) {
      if (!isLoggedIn) banner.classList.remove('hidden');
      else banner.classList.add('hidden');
    }
  } catch (_) {}
}
}

// ─── Apply settings to UI ─────────────────────────────────────────────────────
function applySettings(s) {
  document.documentElement.style.setProperty('--accent', s.accentColor || '#ff4444');
  // Derive glow from accent
  document.documentElement.style.setProperty(
    '--accent-glow', hexToRgba(s.accentColor || '#ff4444', 0.15)
  );
  document.documentElement.style.setProperty('--accent-bg',
    hexToRgba(s.accentColor || '#ff4444', 0.12)
  );
  document.documentElement.style.setProperty('--lyric-size', `${s.fontSize || 22}px`);
  obsPortLabel.textContent = `:${s.obsPort || 6969}`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── Lyrics Panel ─────────────────────────────────────────────────────────────
function toggleLyrics() {
  lyricsOpen = !lyricsOpen;
  lyricsPanel.classList.toggle('hidden', !lyricsOpen);
  document.getElementById('btn-lyrics').classList.toggle('active', lyricsOpen);
  window.ymda.lyricsPanelToggle(lyricsOpen);
}

function showState(name) {
  stateLoading.classList.add('hidden');
  stateEmpty.classList.add('hidden');
  stateIdle.classList.add('hidden');
  lyricsLines.innerHTML = '';
  if (name) document.getElementById(`lyrics-state-${name}`)?.classList.remove('hidden');
}

// ─── YTM Polling ─────────────────────────────────────────────────────────────
const INJECT = `(function(){
  try {
    // Try every known selector YTM has used across versions
    const title =
      document.querySelector('ytmusic-player-bar .title.ytmusic-player-bar')?.textContent?.trim() ||
      document.querySelector('.title.ytmusic-player-bar')?.textContent?.trim() ||
      document.querySelector('ytmusic-player-bar yt-formatted-string.title')?.textContent?.trim() ||
      document.querySelector('yt-formatted-string.title')?.textContent?.trim() || '';

    let artist = '', album = '';
    // All anchor tags inside the byline
    const bylineLinks = [
      ...document.querySelectorAll('ytmusic-player-bar .byline a'),
      ...document.querySelectorAll('.byline.ytmusic-player-bar a'),
    ];
    if (bylineLinks.length >= 1) artist = bylineLinks[0].textContent.trim();
    if (bylineLinks.length >= 2) album  = bylineLinks[1].textContent.trim();

    // Fallback: raw byline text split on bullet
    if (!artist) {
      const raw =
        document.querySelector('ytmusic-player-bar .byline')?.textContent ||
        document.querySelector('.byline.ytmusic-player-bar')?.textContent || '';
      const parts = raw.split(/[•·|]/).map(s => s.trim()).filter(Boolean);
      if (parts[0]) artist = parts[0];
      if (parts[1]) album  = parts[1];
    }

    const art =
      document.querySelector('ytmusic-player-bar #thumbnail img')?.src ||
      document.querySelector('#thumbnail img')?.src || '';

    const bar = document.querySelector(
      'ytmusic-player-bar #progress-bar, tp-yt-paper-slider#progress-bar, #progress-bar'
    );
    const progress = bar ? parseFloat(bar.value || 0) : 0;
    const duration = bar ? parseFloat(bar.max   || 0) : 0;

    return { title, artist, album, albumArt: art, progress, duration };
  } catch(e) { return null; }
})();`;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  showState('idle');
  pollTimer = setInterval(async () => {
    try {
      const meta = await webview.executeJavaScript(INJECT);
      if (meta?.title) await handleSong(meta);
    } catch (_) {}
  }, 500);
}

async function handleSong(meta) {
  const { title, artist, album, albumArt, progress, duration } = meta;
  const key = `${title}::${artist}`;

  // Update overlay every tick
  const lyric = getActiveLyricText(progress);
  window.ymda.updateOverlay({ title, artist, album, albumArt, lyric, progress, duration });

  // New song → fetch lyrics
  if (key !== currentKey && title) {
    currentKey  = key;
    currentIdx  = -1;
    syncedLines = [];
    lyricsType  = null;

    lyricsTitleEl.textContent  = title;
    lyricsArtistEl.textContent = artist;
    lyricsTypeBadge.classList.add('hidden');
    lyricsSrcBadge.classList.add('hidden');
    lyricsPill.classList.remove('visible');

    if (lyricsOpen) showState('loading');

    const result = await window.ymda.fetchLyrics({ title, artist, album, duration });

    if (result) {
      lyricsType  = result.type;
      syncedLines = result.lines;
      renderLyrics(result);
    } else {
      showState('empty');
    }
  }

  // Update active line
  if (lyricsType === 'synced' && syncedLines.length) {
    updateActiveLine(progress);
  }
}

// ─── Render Lyrics ────────────────────────────────────────────────────────────
function renderLyrics({ type, lines, source }) {
  showState(null); // clear states

  // Update badges
  lyricsTypeBadge.textContent = type === 'synced' ? 'SYNCED' : 'PLAIN';
  lyricsTypeBadge.classList.remove('hidden');
  lyricsSrcBadge.textContent = source;
  lyricsSrcBadge.classList.remove('hidden');
  lyricsPill.textContent = source;
  lyricsPill.classList.add('visible');

  lines.forEach((line, i) => {
    const el = document.createElement('div');
    el.className = line.text ? 'lyric-line' : 'lyric-line blank';
    el.textContent = line.text;
    el.dataset.idx = i;
    lyricsLines.appendChild(el);
  });
}

// ─── Active Line Tracking ─────────────────────────────────────────────────────
function updateActiveLine(time) {
  let newIdx = -1;
  for (let i = 0; i < syncedLines.length; i++) {
    if (syncedLines[i].time <= time) newIdx = i;
    else break;
  }
  if (newIdx === currentIdx) return;
  currentIdx = newIdx;

  const els = lyricsLines.querySelectorAll('.lyric-line');
  els.forEach((el, i) => {
    el.classList.remove('active', 'past');
    if (i < newIdx) el.classList.add('past');
    else if (i === newIdx) el.classList.add('active');
  });

  if (newIdx >= 0 && els[newIdx]) scrollToLine(els[newIdx]);
}

function scrollToLine(el) {
  const top = el.offsetTop - lyricsBody.clientHeight * 0.38 + el.offsetHeight / 2;
  lyricsBody.scrollTo({ top, behavior: 'smooth' });
}

function getActiveLyricText(time) {
  if (lyricsType !== 'synced' || !syncedLines.length) return '';
  let text = '';
  for (const l of syncedLines) {
    if (l.time <= time) text = l.text;
    else break;
  }
  return text;
}

// ─── Settings Modal ───────────────────────────────────────────────────────────
let pendingSettings = {};
let dragSrcIdx = null;

function openSettings() {
  pendingSettings = { ...settings };
  renderSettingsModal();
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

document.getElementById('settings-close').onclick  = closeSettings;
document.getElementById('settings-cancel').onclick = closeSettings;
document.getElementById('settings-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('settings-overlay')) closeSettings();
});

document.getElementById('settings-save').onclick = async () => {
  settings = await window.ymda.saveSettings(pendingSettings);
  applySettings(settings);
  // Re-fetch lyrics for current song if sources changed
  currentKey = '';
  closeSettings();
};

document.getElementById('open-overlay-btn').onclick = () => {
  window.ymda.openExternal(`http://localhost:${settings.obsPort || 6969}`);
};

function renderSettingsModal() {
  // Discord RPC toggle + client ID
  const discordToggle   = document.getElementById('discord-rpc-toggle');
  const discordClientId = document.getElementById('discord-client-id');
  const discordDevLink  = document.getElementById('discord-dev-link');
  if (discordToggle) {
    discordToggle.checked = !!pendingSettings.discordRpc;
    discordToggle.onchange = () => { pendingSettings.discordRpc = discordToggle.checked; };
  }
  if (discordClientId) {
    discordClientId.value = pendingSettings.discordClientId || '';
    discordClientId.oninput = () => { pendingSettings.discordClientId = discordClientId.value.trim(); };
  }
  if (discordDevLink) {
    discordDevLink.onclick = (e) => {
      e.preventDefault();
      window.ymda.openExternal('https://discord.com/developers/applications');
    };
  }

  // Font size
  const slider = document.getElementById('font-size-slider');
  const sizeVal = document.getElementById('font-size-value');
  slider.value = pendingSettings.fontSize || 22;
  sizeVal.textContent = `${slider.value}px`;
  slider.oninput = () => {
    sizeVal.textContent = `${slider.value}px`;
    pendingSettings.fontSize = parseInt(slider.value);
    document.documentElement.style.setProperty('--lyric-size', `${slider.value}px`);
  };

  // Accent color swatches
  const swatches = document.querySelectorAll('.swatch');
  swatches.forEach(s => {
    s.classList.toggle('active', s.dataset.color === pendingSettings.accentColor);
    s.onclick = () => {
      swatches.forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      pendingSettings.accentColor = s.dataset.color;
      document.documentElement.style.setProperty('--accent', s.dataset.color);
    };
  });
  const colorPicker = document.getElementById('color-custom');
  colorPicker.value = pendingSettings.accentColor || '#ff4444';
  colorPicker.oninput = () => {
    swatches.forEach(x => x.classList.remove('active'));
    pendingSettings.accentColor = colorPicker.value;
    document.documentElement.style.setProperty('--accent', colorPicker.value);
  };

  // OBS port
  const portInput = document.getElementById('obs-port-input');
  portInput.value = pendingSettings.obsPort || 6969;
  portInput.onchange = () => { pendingSettings.obsPort = parseInt(portInput.value); };

  // OBS position
  const posSelect = document.getElementById('obs-position-select');
  posSelect.value = pendingSettings.overlayPosition || 'bottom-left';
  posSelect.onchange = () => { pendingSettings.overlayPosition = posSelect.value; };

  // Source list
  renderSourceList();
}

function renderSourceList() {
  const list = document.getElementById('source-list');
  list.innerHTML = '';

  const order = pendingSettings.lyricsSources || ['lrclib', 'musixmatch', 'netease', 'ovh'];
  // Ensure all known sources appear (enabled = in list, disabled = appended at end)
  const allSources = [...new Set([...order, ...Object.keys(SOURCE_META)])];
  const enabled = new Set(order);

  allSources.forEach((srcId, idx) => {
    const meta = SOURCE_META[srcId];
    if (!meta) return;

    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.src = srcId;
    item.draggable = true;

    item.innerHTML = `
      <div class="source-drag-handle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
          <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
          <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
        </svg>
      </div>
      <div class="source-info">
        <div class="source-name">${meta.name}</div>
        <div class="source-desc">${meta.desc}</div>
      </div>
      <span class="source-type-tag ${meta.type}">${meta.type}</span>
      <label class="source-toggle">
        <input type="checkbox" ${enabled.has(srcId) ? 'checked' : ''} data-src="${srcId}" />
        <span class="source-toggle-track"></span>
      </label>
    `;

    // Toggle handler
    item.querySelector('input[type="checkbox"]').onchange = (e) => {
      updateSourceOrder();
    };

    // Drag handlers
    item.addEventListener('dragstart', e => {
      dragSrcIdx = idx;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      list.querySelectorAll('.source-item').forEach(x => x.classList.remove('drag-over'));
    });
    item.addEventListener('dragover', e => {
      e.preventDefault();
      list.querySelectorAll('.source-item').forEach(x => x.classList.remove('drag-over'));
      item.classList.add('drag-over');
    });
    item.addEventListener('drop', e => {
      e.preventDefault();
      const items = [...list.querySelectorAll('.source-item')];
      const fromEl = items[dragSrcIdx];
      const toEl   = item;
      if (fromEl && toEl && fromEl !== toEl) {
        const fromPos = fromEl.compareDocumentPosition(toEl);
        if (fromPos & Node.DOCUMENT_POSITION_FOLLOWING) {
          list.insertBefore(fromEl, toEl.nextSibling);
        } else {
          list.insertBefore(fromEl, toEl);
        }
      }
      // Re-index
      list.querySelectorAll('.source-item').forEach((el, i) => { el._idx = i; });
      dragSrcIdx = null;
      updateSourceOrder();
    });

    item._idx = idx;
    list.appendChild(item);
  });
}

function updateSourceOrder() {
  const list = document.getElementById('source-list');
  const ordered = [];
  list.querySelectorAll('.source-item').forEach(el => {
    const checkbox = el.querySelector('input[type="checkbox"]');
    if (checkbox?.checked) ordered.push(el.dataset.src);
  });
  pendingSettings.lyricsSources = ordered;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init();

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ymda', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close:    () => ipcRenderer.send('window-close'),

  onWindowState:    (cb) => ipcRenderer.on('window-state', (_, s) => cb(s)),
  onSettingsUpdate: (cb) => ipcRenderer.on('settings-updated', (_, s) => cb(s)),
  onDiscordState:   (cb) => ipcRenderer.on('discord-rpc-state', (_, s) => cb(s)),
  onYTMReady:       (cb) => ipcRenderer.on('ytm-ready', () => cb()),

  ytmExecute:       (script) => ipcRenderer.invoke('ytm-execute', script),
  lyricsPanelToggle:(open)   => ipcRenderer.send('lyrics-panel-toggle', open),

  openBrowserLogin:        () => ipcRenderer.invoke('open-browser-login'),
  importCookiesFromBrowser:() => ipcRenderer.invoke('import-cookies-from-browser'),
  onReloadYTM: (cb) => ipcRenderer.on('reload-ytm', () => cb()),

  fetchLyrics:  (meta)     => ipcRenderer.invoke('fetch-lyrics', meta),
  updateOverlay: (data)    => ipcRenderer.send('update-overlay', data),

  getSettings:  ()         => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  openExternal: (url)      => ipcRenderer.send('open-external', url),
});

// Nyx: a tabbed browser with an Edge-style site sidebar.
// Every page (tab or sidebar site) is its own WebContentsView — a real page, never an iframe.
const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, nativeTheme, net, shell, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---------- constants ----------
const PARTITION = 'persist:main';
const STRIP = 52;          // icon strip width (right edge)
const GAP = 6;             // drag handle between page and sidebar panel
const MIN_PANEL = 280;
const MIN_BROWSER = 300;
const TABS_H = 36, TOOLBAR_H = 42, BAR_H = 30, FIND_H = 38;
const INTERNAL_URL = pathToFileURL(path.join(__dirname, 'internal.html')).href;
const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];

const SEARCH = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
};

const DEFAULT_SETTINGS = {
  panelWidth: 420,
  homePage: 'https://www.google.com',
  searchEngine: 'google',
  startup: 'restore',        // 'restore' | 'home'
  showBookmarksBar: true,
  askDownload: false,
  downloadDir: '',           // '' = system Downloads folder
  theme: 'dark',             // 'dark' | 'light' | 'system' — what websites see (prefers-color-scheme)
};

const DEFAULT_SITES = [
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com' },
  { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com' },
  { id: 'translate', name: 'Google Translate', url: 'https://translate.google.com' },
];

// ---------- state ----------
let win, ses;
let settings = { ...DEFAULT_SETTINGS };
let sites = [];
const siteViews = {};
let activeSite = null;
let addMode = false;
let dragging = false;
let tabs = [];
let activeTab = null;
let nextTabId = 1;
const closedTabs = [];
let bookmarks = [];
let history = [];
let downloads = [];
let nextDownloadId = 1;
const downloadItems = {};
const find = { open: false, text: '', active: 0, total: 0 };

// ---------- storage ----------
const dataFile = name => path.join(app.getPath('userData'), name);
function readJSON(name, fallback) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), 'utf8')); } catch { return fallback; }
}
function writeJSON(name, data) {
  try { fs.writeFileSync(dataFile(name), JSON.stringify(data, null, 1)); } catch (e) { console.error('Save failed:', name, e.message); }
}
const timers = {};
function saveLater(name, getData, ms = 800) {
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => writeJSON(name, getData()), ms);
}
const saveSites = () => writeJSON('sites.json', sites);
const saveSettings = () => writeJSON('settings.json', settings);
const saveHistory = () => saveLater('history.json', () => history, 2000);
const saveBookmarks = () => writeJSON('bookmarks.json', bookmarks);
const saveDownloads = () => saveLater('downloads.json', () => downloads.slice(0, 200).map(d => ({ ...d, state: d.state === 'progressing' ? 'interrupted' : d.state })));
const sessionData = () => ({
  tabs: tabs.map(t => { try { return t.view.webContents.getURL() || t.url; } catch { return t.url; } }).filter(Boolean),
  active: tabs.findIndex(t => t.id === activeTab),
});
const saveSession = () => saveLater('session.json', sessionData);
function flushAll() {
  Object.values(timers).forEach(clearTimeout);
  writeJSON('history.json', history);
  writeJSON('session.json', sessionData());
  writeJSON('downloads.json', downloads.slice(0, 200));
}

// ---------- helpers ----------
const tab = id => tabs.find(t => t.id === id);
const activeWc = () => { const t = tab(activeTab); return t ? t.view.webContents : null; };
const isInternal = url => typeof url === 'string' && url.startsWith(INTERNAL_URL);
const internalUrl = page => INTERNAL_URL + '#' + page;
const engine = () => SEARCH[settings.searchEngine] || SEARCH.google;
const searchUrl = q => engine().url + encodeURIComponent(q);
const isWeb = url => /^https?:\/\//i.test(url || '');

function displayUrl(url) {
  if (isInternal(url)) return 'nyx://' + (url.split('#')[1] || 'settings');
  return !url || url === 'about:blank' ? '' : url;
}

function toUrl(text) {
  const t = (text || '').trim();
  if (!t) return null;
  const nyx = t.match(/^nyx:\/\/(\w+)/i);
  if (nyx) return internalUrl(nyx[1].toLowerCase());
  if (/^(https?|file):\/\//i.test(t)) return t;
  if (/^localhost(:\d+)?(\/|$)/i.test(t)) return 'http://' + t;
  if (!/\s/.test(t) && /\.[a-z]{2,}(\/|$|:|\?|#)/i.test(t)) return 'https://' + t;
  return searchUrl(t);
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let p = path.join(dir, name);
  for (let i = 1; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// Google's icon service 404s for some subdomains (e.g. web.whatsapp.com) and shows a blank globe.
const s2 = host => `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
const iconFor = site => site.icon || s2(new URL(site.url).hostname);
async function resolveIcon(site) {
  if (site.icon) return;
  const parts = new URL(site.url).hostname.split('.');
  const hosts = [parts.join('.')];
  if (parts.length > 2) hosts.push(parts.slice(-2).join('.'));
  for (const h of hosts) {
    try {
      const r = await net.fetch(s2(h));
      if (r.ok) { site.icon = s2(h); saveSites(); pushState(); return; }
    } catch {}
  }
}

// ---------- layout + state ----------
const topHeight = () => TABS_H + TOOLBAR_H + (settings.showBookmarksBar ? BAR_H : 0) + (find.open ? FIND_H : 0);

function sizes() {
  const [W, H] = win.getContentSize();
  const open = activeSite || addMode;
  const maxPanel = Math.max(MIN_PANEL, W - STRIP - GAP - MIN_BROWSER);
  const panelW = open ? Math.min(Math.max(settings.panelWidth, MIN_PANEL), maxPanel) : 0;
  const gap = open ? GAP : 0;
  return { W, H, panelW, gap, top: topHeight(), browserW: Math.max(0, W - STRIP - panelW - gap) };
}

function layout() {
  if (!win) return;
  const { H, panelW, gap, top, browserW } = sizes();
  const bodyH = Math.max(0, H - top);
  const t = tab(activeTab);
  if (t) t.view.setBounds({ x: 0, y: top, width: browserW, height: bodyH });
  if (activeSite) siteViews[activeSite].setBounds({ x: browserW + gap, y: top, width: panelW, height: bodyH });
  pushState();
}

// Pages sit above the UI and would swallow the mouse mid-drag, so hide them while dragging.
function setPagesVisible(visible) {
  const list = [tab(activeTab) && tab(activeTab).view, activeSite && siteViews[activeSite]].filter(Boolean);
  list.forEach(v => visible ? win.contentView.addChildView(v) : win.contentView.removeChildView(v));
}

function pushState() {
  if (!win || win.isDestroyed()) return;
  const { panelW, gap, top, browserW } = sizes();
  const t = tab(activeTab);
  const wc = t && t.view.webContents;
  const url = wc ? wc.getURL() : '';
  const active = downloads.filter(d => d.state === 'progressing');
  const recv = active.reduce((a, d) => a + d.received, 0);
  const total = active.reduce((a, d) => a + (d.total || 0), 0);
  win.webContents.send('state', {
    tabs: tabs.map(x => ({ id: x.id, title: x.title, favicon: x.favicon, loading: x.loading })),
    activeTab,
    url: displayUrl(url),
    canBack: wc ? wc.navigationHistory.canGoBack() : false,
    canFwd: wc ? wc.navigationHistory.canGoForward() : false,
    zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
    bookmarkable: isWeb(url),
    bookmarked: !!bookmarks.find(b => b.url === url),
    bookmarks: bookmarks.map(b => ({ id: b.id, title: b.title, favicon: b.favicon })),
    showBar: settings.showBookmarksBar,
    find: { ...find },
    downloads: { count: downloads.length, active: active.length, progress: total ? recv / total : null },
    engineName: engine().name,
    sites: sites.map(s => ({ ...s, icon: iconFor(s) })),
    activeSite, addMode, panelW, gap, browserW, dragging, top, strip: STRIP,
  });
}

// Tell open nyx:// pages that their data changed.
function notifyInternal(what) {
  tabs.forEach(t => { if (isInternal(t.view.webContents.getURL())) t.view.webContents.send('nyx:changed', what); });
}

// ---------- shared wiring for any page ----------
function wire(wc) {
  wc.setWindowOpenHandler(({ url, disposition }) => {
    newTab(url, { background: disposition === 'background-tab' });
    return { action: 'deny' };
  });
  wc.on('before-input-event', (e, input) => { if (shortcut(input)) e.preventDefault(); });
  wc.on('context-menu', (_e, p) => contextMenu(wc, p));
  wc.on('zoom-changed', (_e, dir) => zoomWc(wc, dir === 'in' ? 1 : -1));
}

const isMac = process.platform === 'darwin';

function shortcut(input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const shift = input.shift;
  const k = input.key.toLowerCase();
  const wc = activeWc();
  const nav = wc && wc.navigationHistory;
  if (ctrl && shift && k === 't') { reopenTab(); return true; }
  if (ctrl && shift && k === 'b') { setSetting('showBookmarksBar', !settings.showBookmarksBar); return true; }
  if (ctrl && shift && k === 'delete') { openInternal('settings'); return true; }
  if (ctrl && k === 't') { newTab(); focusUrl(); return true; }
  if (ctrl && k === 'w') { closeTab(activeTab); return true; }
  if (ctrl && k === 'l') { focusUrl(); return true; }
  if ((ctrl && k === 'r') || k === 'f5') { wc && wc.reload(); return true; }
  if (isMac && input.meta && k === '[') { nav && nav.canGoBack() && nav.goBack(); return true; }
  if (isMac && input.meta && k === ']') { nav && nav.canGoForward() && nav.goForward(); return true; }
  if (isMac && input.meta && k === ',') { openInternal('settings'); return true; }
  if (input.alt && k === 'arrowleft') { nav && nav.canGoBack() && nav.goBack(); return true; }
  if (input.alt && k === 'arrowright') { nav && nav.canGoForward() && nav.goForward(); return true; }
  if (input.alt && k === 'home') { wc && wc.loadURL(settings.homePage); return true; }
  if (ctrl && k === 'tab' && tabs.length > 1) {
    const i = tabs.findIndex(t => t.id === activeTab);
    selectTab(tabs[(i + (shift ? -1 : 1) + tabs.length) % tabs.length].id);
    return true;
  }
  if (ctrl && /^[1-9]$/.test(k)) { const t = k === '9' ? tabs[tabs.length - 1] : tabs[+k - 1]; if (t) selectTab(t.id); return true; }
  if (ctrl && k === 'f') { openFind(); return true; }
  if (ctrl && k === 'p') { wc && wc.print(); return true; }
  if (ctrl && k === 's') { wc && savePage(wc); return true; }
  if (ctrl && k === 'h') { openInternal('history'); return true; }
  if (ctrl && k === 'j') { openInternal('downloads'); return true; }
  if (ctrl && k === 'd') { toggleBookmark(); return true; }
  if (ctrl && (k === '=' || k === '+')) { zoom(1); return true; }
  if (ctrl && (k === '-' || k === '_')) { zoom(-1); return true; }
  if (ctrl && k === '0') { zoom(0); return true; }
  if (k === 'f12') { wc && wc.toggleDevTools(); return true; }
  if (k === 'escape' && find.open) { closeFind(); return true; }
  return false;
}

function focusUrl() { win.webContents.focus(); win.webContents.send('focus-url'); }

// ---------- tabs ----------
function newTab(url = settings.homePage, { background = false } = {}) {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, preload: path.join(__dirname, 'page-preload.js') },
  });
  const t = { id: nextTabId++, view, url, title: 'New tab', favicon: null, loading: true };
  const wc = view.webContents;
  wire(wc);
  wc.on('page-title-updated', (_e, title) => { t.title = title; updateHistory(wc.getURL(), { title }); pushState(); });
  wc.on('page-favicon-updated', (_e, icons) => { t.favicon = icons[0] || null; updateHistory(wc.getURL(), { favicon: t.favicon }); pushState(); });
  wc.on('did-start-loading', () => { t.loading = true; pushState(); });
  wc.on('did-stop-loading', () => { t.loading = false; pushState(); });
  wc.on('did-navigate', (_e, u) => { t.url = u; t.favicon = isInternal(u) ? t.favicon : null; addHistory(u, wc.getTitle()); pushState(); saveSession(); });
  wc.on('did-navigate-in-page', (_e, u, isMain) => { if (!isMain) return; t.url = u; addHistory(u, wc.getTitle()); pushState(); saveSession(); });
  wc.on('found-in-page', (_e, r) => {
    if (t.id !== activeTab) return;
    find.active = r.activeMatchOrdinal; find.total = r.matches; pushState();
  });
  tabs.push(t);
  if (!background || activeTab === null) selectTab(t.id); else pushState();
  wc.loadURL(url);
  saveSession();
  return t;
}

function selectTab(id) {
  if (find.open) closeFind();
  const old = tab(activeTab);
  if (old) win.contentView.removeChildView(old.view);
  activeTab = id;
  win.contentView.addChildView(tab(id).view);
  layout();
  saveSession();
}

function closeTab(id) {
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  const url = t.view.webContents.getURL() || t.url;
  if (url) closedTabs.push(url);
  if (closedTabs.length > 25) closedTabs.shift();
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  if (!tabs.length) { activeTab = null; newTab(); return; }
  if (activeTab === id) { activeTab = null; selectTab(tabs[Math.min(i, tabs.length - 1)].id); }
  else pushState();
  saveSession();
}

function reopenTab() { const u = closedTabs.pop(); if (u) newTab(u); }

function openInternal(page) {
  const existing = tabs.find(t => isInternal(t.view.webContents.getURL()) && t.view.webContents.getURL().endsWith('#' + page));
  if (existing) selectTab(existing.id);
  else newTab(internalUrl(page));
}

function openStartupTabs() {
  const s = readJSON('session.json', null);
  if (settings.startup === 'restore' && s && Array.isArray(s.tabs) && s.tabs.length) {
    s.tabs.forEach(u => newTab(u, { background: true }));
    const idx = Math.max(0, Math.min(s.active, tabs.length - 1));
    selectTab(tabs[idx].id);
  } else {
    newTab();
  }
}

// ---------- zoom / find / print / save ----------
function zoomWc(wc, dir) {
  if (!wc) return;
  const cur = Math.round(wc.getZoomFactor() * 100);
  let next = 100;
  if (dir > 0) next = ZOOM_LEVELS.find(l => l > cur) || 500;
  if (dir < 0) next = [...ZOOM_LEVELS].reverse().find(l => l < cur) || 25;
  wc.setZoomFactor(next / 100);
  pushState();
}
const zoom = dir => zoomWc(activeWc(), dir);

function openFind() {
  find.open = true;
  layout();
  win.webContents.focus();
  win.webContents.send('focus-find');
  if (find.text) runFind(find.text);
}
function closeFind() {
  if (!find.open) return;
  find.open = false; find.active = 0; find.total = 0;
  const wc = activeWc();
  if (wc) wc.stopFindInPage('clearSelection');
  layout();
}
// Electron: findNext=true starts a new search; false continues the current one.
function runFind(text, next = false, back = false) {
  find.text = text;
  const wc = activeWc();
  if (!wc) return;
  if (!text) { wc.stopFindInPage('clearSelection'); find.active = 0; find.total = 0; pushState(); return; }
  wc.findInPage(text, { findNext: !next, forward: !back });
}

async function savePage(wc) {
  const name = (wc.getTitle() || 'page').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) + '.html';
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(settings.downloadDir || app.getPath('downloads'), name),
    filters: [{ name: 'Web page, complete', extensions: ['html'] }],
  });
  if (!r.canceled && r.filePath) wc.savePage(r.filePath, 'HTMLComplete').catch(e => console.error(e.message));
}

// ---------- history ----------
function addHistory(url, title) {
  if (!isWeb(url)) return;
  const last = history[history.length - 1];
  if (last && last.url === url) { last.time = Date.now(); }
  else history.push({ url, title: title || url, favicon: null, time: Date.now() });
  if (history.length > 5000) history.splice(0, history.length - 5000);
  saveHistory();
  notifyInternal('history');
}
function updateHistory(url, fields) {
  for (let i = history.length - 1; i >= Math.max(0, history.length - 30); i--) {
    if (history[i].url === url) { Object.assign(history[i], fields); saveHistory(); notifyInternal('history'); return; }
  }
}

// ---------- bookmarks ----------
function toggleBookmark() {
  const t = tab(activeTab);
  if (!t) return;
  const url = t.view.webContents.getURL();
  if (!isWeb(url)) return;
  const b = bookmarks.find(x => x.url === url);
  if (b) bookmarks = bookmarks.filter(x => x !== b);
  else bookmarks.push({ id: 'bm-' + Date.now(), title: t.title || url, url, favicon: t.favicon });
  saveBookmarks();
  pushState();
  notifyInternal('bookmarks');
}
function removeBookmark(id) {
  bookmarks = bookmarks.filter(b => b.id !== id);
  saveBookmarks(); pushState(); notifyInternal('bookmarks');
}

// ---------- downloads ----------
function setupDownloads() {
  let lastNotify = 0;
  ses.on('will-download', (_e, item) => {
    const d = {
      id: nextDownloadId++, filename: item.getFilename(), url: item.getURL(), path: '',
      state: 'progressing', received: 0, total: item.getTotalBytes(), time: Date.now(),
    };
    if (!settings.askDownload) {
      const dir = settings.downloadDir && fs.existsSync(settings.downloadDir) ? settings.downloadDir : app.getPath('downloads');
      d.path = uniquePath(dir, d.filename);
      item.setSavePath(d.path);
    }
    downloads.unshift(d);
    downloadItems[d.id] = item;
    item.on('updated', (_e2, state) => {
      d.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      d.received = item.getReceivedBytes();
      d.total = item.getTotalBytes();
      d.path = item.getSavePath() || d.path;
      if (d.path) d.filename = path.basename(d.path);
      if (Date.now() - lastNotify > 400) { lastNotify = Date.now(); pushState(); notifyInternal('downloads'); }
    });
    item.once('done', (_e2, state) => {
      d.state = state; // completed | cancelled | interrupted
      d.received = item.getReceivedBytes();
      d.path = item.getSavePath() || d.path;
      if (d.path) d.filename = path.basename(d.path);
      delete downloadItems[d.id];
      saveDownloads(); pushState(); notifyInternal('downloads');
      if (state === 'completed' && win && !win.isFocused()) win.flashFrame(true);
    });
    pushState(); notifyInternal('downloads');
  });
}

// ---------- right-click menu on pages ----------
function contextMenu(wc, p) {
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' }); };
  const nav = wc.navigationHistory;
  const sel = (p.selectionText || '').trim();

  if (p.misspelledWord) {
    p.dictionarySuggestions.slice(0, 5).forEach(s => items.push({ label: s, click: () => wc.replaceMisspelling(s) }));
    if (!p.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
    items.push({ label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(p.misspelledWord) });
    sep();
  }
  if (p.linkURL) {
    items.push(
      { label: 'Open link in new tab', click: () => newTab(p.linkURL, { background: true }) },
      { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
    );
    sep();
  }
  if (p.mediaType === 'image' && p.srcURL) {
    items.push(
      { label: 'Open image in new tab', click: () => newTab(p.srcURL, { background: true }) },
      { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
      { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
      { label: 'Copy image address', click: () => clipboard.writeText(p.srcURL) },
    );
    sep();
  }
  if (p.isEditable) {
    const f = p.editFlags;
    items.push(
      { label: 'Undo', enabled: f.canUndo, click: () => wc.undo() },
      { label: 'Redo', enabled: f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Cut', enabled: f.canCut, click: () => wc.cut() },
      { label: 'Copy', enabled: f.canCopy, click: () => wc.copy() },
      { label: 'Paste', enabled: f.canPaste, click: () => wc.paste() },
      { label: 'Paste as plain text', enabled: f.canPaste, click: () => wc.pasteAndMatchStyle() },
      { label: 'Select all', enabled: f.canSelectAll, click: () => wc.selectAll() },
    );
    sep();
  } else if (sel) {
    const short = sel.length > 30 ? sel.slice(0, 30) + '…' : sel;
    items.push(
      { label: 'Copy', click: () => wc.copy() },
      { label: `Search ${engine().name} for “${short}”`, click: () => newTab(searchUrl(sel)) },
    );
    sep();
  }
  if (!p.linkURL && !p.isEditable && !sel && p.mediaType !== 'image') {
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Save page as…', click: () => savePage(wc) },
      { label: 'Print…', click: () => wc.print() },
    );
    sep();
  }
  items.push({ label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

// ---------- settings ----------
function setSetting(key, value) {
  switch (key) {
    case 'homePage': { const u = toUrl(value); if (!u || !/^(https?|file):/.test(u) || u.startsWith(engine().url)) return false; settings.homePage = u; break; }
    case 'searchEngine': if (!SEARCH[value]) return false; settings.searchEngine = value; break;
    case 'startup': if (!['restore', 'home'].includes(value)) return false; settings.startup = value; break;
    case 'showBookmarksBar': settings.showBookmarksBar = !!value; layout(); break;
    case 'theme': if (!['dark', 'light', 'system'].includes(value)) return false; settings.theme = value; nativeTheme.themeSource = value; break;
    case 'askDownload': settings.askDownload = !!value; break;
    default: return false;
  }
  saveSettings();
  pushState();
  notifyInternal('settings');
  return true;
}

async function clearData({ history: h, cookies, cache }) {
  if (!h && !cookies && !cache) return false;
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Clear', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Clear the selected browsing data?',
    detail: cookies ? 'Clearing cookies and site data logs you out of every site, including WhatsApp and Instagram in the sidebar.' : 'This cannot be undone.',
  });
  if (r.response !== 0) return false;
  if (h) { history = []; writeJSON('history.json', history); notifyInternal('history'); }
  if (cookies) await ses.clearStorageData();
  if (cache) await ses.clearCache();
  return true;
}

// ---------- sidebar sites ----------
function hideSite() {
  if (activeSite && siteViews[activeSite]) win.contentView.removeChildView(siteViews[activeSite]);
  activeSite = null;
}

function toggleSite(id) {
  const wasActive = activeSite === id;
  hideSite();
  addMode = false;
  if (!wasActive) {
    if (!siteViews[id]) {
      const view = new WebContentsView({ webPreferences: { partition: PARTITION } });
      wire(view.webContents);
      const site = sites.find(s => s.id === id);
      // Once the site loads, use the icon it reports itself — the most accurate one.
      view.webContents.on('page-favicon-updated', (_e, icons) => {
        const ico = icons.find(i => /^https:/.test(i));
        if (ico && site.icon !== ico) { site.icon = ico; saveSites(); pushState(); }
      });
      view.webContents.loadURL(site.url);
      siteViews[id] = view;
    }
    win.contentView.addChildView(siteViews[id]);
    activeSite = id;
  }
  layout();
}

function addSite(text) {
  const t = (text || '').trim();
  if (!t || /\s/.test(t)) return;
  const url = /^https?:\/\//i.test(t) ? t : 'https://' + t;
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return; }
  const site = { id: 'site-' + Date.now(), name: host, url };
  sites.push(site);
  saveSites();
  resolveIcon(site);
  addMode = false;
  toggleSite(site.id);
}

function removeSite(id) {
  if (activeSite === id) hideSite();
  if (siteViews[id]) { siteViews[id].webContents.close(); delete siteViews[id]; }
  sites = sites.filter(s => s.id !== id);
  saveSites();
  layout();
}

// ---------- IPC from the browser UI (ui.html) ----------
const withWc = fn => () => { const wc = activeWc(); if (wc) fn(wc); };
ipcMain.on('tab:new', () => { newTab(); focusUrl(); });
ipcMain.on('tab:select', (_e, id) => selectTab(id));
ipcMain.on('tab:close', (_e, id) => closeTab(id));
ipcMain.on('nav:go', (_e, text) => { const u = toUrl(text); const wc = activeWc(); if (u && wc) { wc.loadURL(u); wc.focus(); } });
ipcMain.on('nav:back', withWc(wc => wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack()));
ipcMain.on('nav:fwd', withWc(wc => wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward()));
ipcMain.on('nav:reload', withWc(wc => wc.reload()));
ipcMain.on('nav:home', withWc(wc => wc.loadURL(settings.homePage)));
ipcMain.on('zoom:reset', () => zoom(0));
ipcMain.on('bm:toggle', () => toggleBookmark());
ipcMain.on('bm:open', (_e, { id, newTab: inNew }) => {
  const b = bookmarks.find(x => x.id === id);
  if (!b) return;
  if (inNew) newTab(b.url, { background: true }); else { const wc = activeWc(); if (wc) wc.loadURL(b.url); }
});
ipcMain.on('bm:menu', (_e, id) => {
  const b = bookmarks.find(x => x.id === id);
  if (!b) return;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => { const wc = activeWc(); if (wc) wc.loadURL(b.url); } },
    { label: 'Open in new tab', click: () => newTab(b.url) },
    { label: 'Copy link', click: () => clipboard.writeText(b.url) },
    { type: 'separator' },
    { label: 'Edit bookmarks…', click: () => openInternal('bookmarks') },
    { label: 'Remove', click: () => removeBookmark(id) },
  ]).popup({ window: win });
});
ipcMain.on('find:query', (_e, text) => runFind(text));
ipcMain.on('find:next', (_e, back) => runFind(find.text, true, !!back));
ipcMain.on('find:close', () => closeFind());
ipcMain.on('downloads:open', () => openInternal('downloads'));
ipcMain.on('site:click', (_e, id) => toggleSite(id));
ipcMain.on('site:add', (_e, text) => addSite(text));
ipcMain.on('add:open', () => { hideSite(); addMode = true; layout(); });
ipcMain.on('add:cancel', () => { addMode = false; layout(); });
ipcMain.on('resize:start', () => { if (dragging) return; dragging = true; setPagesVisible(false); pushState(); });
ipcMain.on('resize:move', (_e, x) => {
  if (!dragging) return;
  const [W] = win.getContentSize();
  settings.panelWidth = W - STRIP - GAP - x;
  settings.panelWidth = sizes().panelW; // keep the clamped value
  pushState();
});
ipcMain.on('resize:end', () => { if (!dragging) return; dragging = false; setPagesVisible(true); layout(); saveSettings(); });
ipcMain.on('site:menu', (_e, id) => {
  const s = sites.find(x => x.id === id);
  if (!s) return;
  Menu.buildFromTemplate([
    { label: `Open ${s.name} in a tab`, click: () => newTab(s.url) },
    { label: `Reload ${s.name}`, enabled: !!siteViews[id], click: () => siteViews[id].webContents.reload() },
    { type: 'separator' },
    { label: `Remove ${s.name}`, click: () => removeSite(id) },
  ]).popup({ window: win });
});

// The ⋮ menu.
ipcMain.on('menu:open', (_e, pos) => {
  const wc = activeWc();
  const url = wc ? wc.getURL() : '';
  const z = wc ? Math.round(wc.getZoomFactor() * 100) : 100;
  const label = (text, accel, extra = {}) => ({ label: text, accelerator: accel && accel.replace('Ctrl+', 'CommandOrControl+'), registerAccelerator: false, ...extra });
  Menu.buildFromTemplate([
    label('New tab', 'Ctrl+T', { click: () => { newTab(); focusUrl(); } }),
    label('Reopen closed tab', 'Ctrl+Shift+T', { enabled: closedTabs.length > 0, click: reopenTab }),
    { type: 'separator' },
    { label: `Zoom (${z}%)`, submenu: [
      label('Zoom in', 'Ctrl+=', { click: () => zoom(1) }),
      label('Zoom out', 'Ctrl+-', { click: () => zoom(-1) }),
      label('Reset to 100%', 'Ctrl+0', { click: () => zoom(0) }),
    ] },
    label('Find on page…', 'Ctrl+F', { click: openFind }),
    label('Print…', 'Ctrl+P', { enabled: !!wc, click: () => wc.print() }),
    label('Save page as…', 'Ctrl+S', { enabled: !!wc, click: () => savePage(wc) }),
    { type: 'separator' },
    { label: 'Bookmarks', submenu: [
      label(bookmarks.find(b => b.url === url) ? 'Remove bookmark' : 'Bookmark this page', 'Ctrl+D', { enabled: isWeb(url), click: toggleBookmark }),
      label('Show bookmarks bar', 'Ctrl+Shift+B', { type: 'checkbox', checked: settings.showBookmarksBar, click: () => setSetting('showBookmarksBar', !settings.showBookmarksBar) }),
      { type: 'separator' },
      { label: 'Manage bookmarks', click: () => openInternal('bookmarks') },
    ] },
    label('History', 'Ctrl+H', { click: () => openInternal('history') }),
    label('Downloads', 'Ctrl+J', { click: () => openInternal('downloads') }),
    { label: 'Theme (websites)', submenu: ['dark', 'light', 'system'].map(t => ({ label: t[0].toUpperCase() + t.slice(1), type: 'radio', checked: settings.theme === t, click: () => setSetting('theme', t) })) },
    { type: 'separator' },
    label('Settings', '', { click: () => openInternal('settings') }),
    label('Clear browsing data…', 'Ctrl+Shift+Delete', { click: () => openInternal('settings') }),
    label('Developer tools', 'F12', { enabled: !!wc, click: () => wc.toggleDevTools() }),
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() },
  ]).popup({ window: win, x: Math.round(pos.x), y: Math.round(pos.y) });
});

// ---------- IPC from nyx:// pages (internal.html) ----------
ipcMain.handle('nyx:get', (e, what) => {
  if (!isInternal(e.sender.getURL())) return null;
  switch (what) {
    case 'history': return history.slice(-3000).reverse();
    case 'bookmarks': return bookmarks;
    case 'downloads': return downloads.map(d => ({ ...d, exists: !!d.path && fs.existsSync(d.path) }));
    case 'settings': return {
      ...settings,
      downloadDir: settings.downloadDir || app.getPath('downloads'),
      engines: Object.entries(SEARCH).map(([id, s]) => ({ id, name: s.name })),
      versions: { nyx: app.getVersion(), chrome: process.versions.chrome, electron: process.versions.electron },
    };
  }
  return null;
});

ipcMain.handle('nyx:do', async (e, action, data = {}) => {
  if (!isInternal(e.sender.getURL())) return null;
  const d = data.id !== undefined ? downloads.find(x => x.id === data.id) : null;
  switch (action) {
    case 'open': {
      const u = toUrl(data.url);
      if (!u) return null;
      if (data.newTab) newTab(u, { background: true }); else e.sender.loadURL(u);
      return null;
    }
    case 'history:delete':
      history = history.filter(h => !(h.url === data.url && h.time === data.time));
      saveHistory(); notifyInternal('history'); return null;
    case 'history:clear': return clearData({ history: true });
    case 'bookmark:remove': removeBookmark(data.id); return null;
    case 'bookmark:rename': {
      const b = bookmarks.find(x => x.id === data.id);
      if (b && data.title && data.title.trim()) { b.title = data.title.trim(); saveBookmarks(); pushState(); notifyInternal('bookmarks'); }
      return null;
    }
    case 'download:open': if (d && d.path) shell.openPath(d.path); return null;
    case 'download:show': if (d && d.path) shell.showItemInFolder(d.path); return null;
    case 'download:cancel': if (d && downloadItems[d.id]) downloadItems[d.id].cancel(); return null;
    case 'download:retry': if (d) e.sender.downloadURL(d.url); return null;
    case 'download:remove': downloads = downloads.filter(x => x !== d); saveDownloads(); pushState(); notifyInternal('downloads'); return null;
    case 'downloads:clear':
      downloads = downloads.filter(x => x.state === 'progressing');
      saveDownloads(); pushState(); notifyInternal('downloads'); return null;
    case 'downloads:folder': shell.openPath(settings.downloadDir || app.getPath('downloads')); return null;
    case 'settings:set': return setSetting(data.key, data.value);
    case 'settings:pickFolder': {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: settings.downloadDir || app.getPath('downloads') });
      if (!r.canceled && r.filePaths[0]) { settings.downloadDir = r.filePaths[0]; saveSettings(); notifyInternal('settings'); }
      return null;
    }
    case 'clear-data': return clearData(data);
  }
  return null;
});

// ---------- startup ----------
// Keep using the original data folder so logins, sites and settings survive the rename to Nyx.
// The self-check (SNAP_DIR) uses a throwaway profile so it never touches real data.
// The installed app (app.isPackaged) gets its own fresh "Nyx" folder on each PC — nothing from this dev copy ships.
app.setPath('userData', process.env.SNAP_DIR
  ? path.join(process.env.SNAP_DIR, 'nyx-test-profile')
  : path.join(app.getPath('appData'), app.isPackaged ? 'Nyx' : 'Sidebar Browser'));
if (process.platform === 'win32') app.setAppUserModelId('Nyx');

app.whenReady().then(() => {
  ses = session.fromPartition(PARTITION);
  // Present as plain Chrome so sites (WhatsApp) don't reject us.
  const osUA = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'Windows NT 10.0; Win64; x64';
  ses.setUserAgent(`Mozilla/5.0 (${osUA}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`);
  setupDownloads();
  nativeTheme.themeSource = ['dark', 'light', 'system'].includes(readJSON('settings.json', {}).theme) ? readJSON('settings.json', {}).theme : 'dark';

  settings = { ...DEFAULT_SETTINGS, ...readJSON('settings.json', {}) };
  if (process.env.SNAP_DIR) { settings.downloadDir = path.join(process.env.SNAP_DIR, 'nyx-test-downloads'); fs.mkdirSync(settings.downloadDir, { recursive: true }); }
  sites = readJSON('sites.json', DEFAULT_SITES.slice());
  sites.forEach(resolveIcon);
  bookmarks = readJSON('bookmarks.json', []);
  history = readJSON('history.json', []);
  downloads = readJSON('downloads.json', []);
  nextDownloadId = downloads.reduce((m, d) => Math.max(m, d.id || 0), 0) + 1;

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Nyx',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#1f1f23',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  if (isMac) {
    // macOS needs an application menu for Cmd+C/V/X/A, Cmd+Q, Cmd+H and Cmd+M to work.
    // Browser shortcuts are handled in shortcut(), so only roles are listed here.
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    if (app.dock) app.dock.setIcon(path.join(__dirname, 'icon.png'));
  }
  win.webContents.on('before-input-event', (e, input) => { if (shortcut(input)) e.preventDefault(); });
  win.on('resize', layout);
  win.on('focus', () => win.flashFrame(false));
  win.on('close', flushAll);
  win.loadFile('ui.html');
  win.webContents.once('did-finish-load', () => {
    openStartupTabs();
    if (process.env.SNAP_DIR) require('./selfcheck')({ win, tabs, tab, siteViews, newTab, openInternal, toggleSite, toggleBookmark, openFind, runFind, zoom, activeWc, find, bookmarks: () => bookmarks, history: () => history, downloads: () => downloads, flushAll });
  });
});

app.on('before-quit', flushAll);
app.on('window-all-closed', () => app.quit()); // simple: closing the window quits, on every OS

# Nyx

A Windows browser with an Edge-style sidebar for WhatsApp, Instagram and any site.
Built with Electron. Each sidebar site runs as a real page (not an iframe), so sites that block embedding still work.

## Features
- Tabs, address bar, back/forward/reload/home
- Sidebar icon strip with resizable panel; add/remove any site
- Bookmarks (bar + manager), history, downloads, find on page, zoom, print, save page
- Settings: startup/restore tabs, home page, search engine, download folder, clear browsing data
- Right-click menus on pages

## Run from source
```
npm install
npx.cmd electron .
```

## Build the Windows installer
Double-click `Build Installer.cmd` (or run `npx.cmd electron-builder --win nsis`).
The installer appears in `dist/`.

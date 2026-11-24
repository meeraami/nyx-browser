<p align="center"><img src="icon.png" width="96" alt="Nyx black cat icon"></p>

# Nyx

A lightweight Windows and macOS browser with an Edge-style sidebar, so WhatsApp, Instagram or any other site stays open next to the page you're browsing.

## Why Nyx exists
Microsoft Edge used to have a handy sidebar for keeping apps like WhatsApp open beside your tabs, and then removed it in an update. Nyx started as a replacement for that feature and grew into a full browser built around it.

## The name
Nyx is dedicated to my black cat, **Shadow** 🐈‍⬛. She isn't called Nyx, but Nyx, the Greek goddess of night, felt right for a little black cat. That's her on the icon.

## How it works
Each sidebar site runs as a real browser page, not an iframe. Sites that block embedding, like WhatsApp Web and Instagram, work normally, and you stay logged in between restarts.

## Download
Get the latest `Nyx-Setup-x.x.x.exe` from [Releases](../../releases) and run it.

> The installer isn't code-signed, so Windows SmartScreen may warn you. Click **More info → Run anyway**.

## Features
- **Sidebar:** icon strip with a resizable panel. Add or remove any site, and site icons are fetched automatically.
- **Browsing:** tabs, address bar with a choice of search engine, back/forward/reload/home, and tabs restored on startup
- **Tools:** bookmarks (bar and manager), history, downloads, find on page, zoom, print, save page
- **Settings (`nyx://settings`):** home page, search engine, download folder, bookmarks bar, clear browsing data
- Right-click menus and the usual keyboard shortcuts (Ctrl+T, Ctrl+W, Ctrl+L, Ctrl+F, Ctrl+D, Ctrl+H, Ctrl+J…)

## Privacy
Nyx has no accounts, no telemetry and no servers of its own. Your logins, history and bookmarks stay on your PC in `%APPDATA%\Nyx`.

## Run from source
Requires [Node.js](https://nodejs.org).
```
npm install
npx electron .
```

## Build for macOS
```
npm install
npm run dist:mac
```
The `.dmg` is written to `dist/`. It isn't signed or notarized, so on first launch right-click the app and choose **Open**. Keyboard shortcuts use ⌘ instead of Ctrl on Mac.

## Build the Windows installer
Double-click `Build Installer.cmd`, or run `npx electron-builder --win nsis`. The installer is written to `dist/`.

## License
[MIT](LICENSE)

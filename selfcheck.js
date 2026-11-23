// Automated smoke test. Runs only when SNAP_DIR is set, in a throwaway profile (see main.js).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('CHECK |', ...a);

module.exports = async n => {
  const dir = process.env.SNAP_DIR;
  const snap = async (wc, name) => fs.writeFileSync(path.join(dir, name + '.png'), (await wc.capturePage()).toPNG());
  const text = wc => wc.executeJavaScript('document.body.innerText.replace(/\\s+/g, " ").slice(0, 260)');
  try {
    await wait(6000);
    log('home tab:', n.activeWc().getTitle(), n.activeWc().getURL());

    n.toggleBookmark();
    log('bookmarks after Ctrl+D:', n.bookmarks().map(b => b.title).join(', '));

    n.zoom(1); n.zoom(1);
    log('zoom after 2x zoom-in:', Math.round(n.activeWc().getZoomFactor() * 100) + '%');
    n.zoom(0);

    n.openFind(); n.runFind('Google'); await wait(1500);
    log('find "Google":', n.find.active, 'of', n.find.total);
    await snap(n.win.webContents, 'v2-ui');

    n.activeWc().downloadURL('https://www.google.com/favicon.ico');
    await wait(4000);
    const d = n.downloads()[0];
    log('download:', d && d.state, d && d.filename, d && fs.existsSync(d.path));

    n.newTab('https://example.com'); await wait(3000);
    log('history entries:', n.history().length, n.history().map(h => h.title).join(' | '));

    for (const page of ['settings', 'history', 'bookmarks', 'downloads']) {
      n.openInternal(page); await wait(1500);
      const wc = n.activeWc();
      log(`nyx://${page}:`, wc.getTitle(), '|', await text(wc));
      await snap(wc, 'v2-' + page);
    }

    n.flushAll();
    log('session.json:', fs.readFileSync(path.join(app.getPath('userData'), 'session.json'), 'utf8').replace(/\s+/g, ' '));
  } catch (e) {
    log('ERROR', e.stack);
  }
  app.quit();
};

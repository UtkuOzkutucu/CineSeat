/**
 * Update checking, straight against the GitHub Releases API.
 *
 * No updater library. The alternative (electron-updater) needs a `latest.yml`
 * manifest uploaded beside every build, and if that file is ever missing the
 * app stops updating with no error at all — a silent failure of exactly the
 * kind this project keeps getting bitten by. Reading the release directly means
 * a release is just its `.exe`: nothing to forget.
 *
 * The cost is that each update downloads the whole installer rather than a
 * delta. At this release cadence that is not worth defending against.
 *
 * Nothing lands in Downloads: the installer goes to a temp folder, runs from
 * there, and is cleaned up on the next launch — it cannot be deleted while
 * running, because by then this process has already quit.
 */

import { app, dialog, shell } from 'electron';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const REPO = 'UtkuOzkutucu/CineSeat';
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const STAGING_DIR = join(tmpdir(), 'cineseat-update');

/** An installer that is plainly too small to be one — usually an error page. */
const MIN_INSTALLER_BYTES = 20 * 1024 * 1024;

let status = { state: 'idle', version: null, message: null };

export function updateStatus() {
  return { ...status, current: app.getVersion() };
}

/**
 * Compare two dotted versions numerically.
 *
 * String comparison gets this wrong in a way that only shows up later: "1.0.10"
 * sorts before "1.0.9" alphabetically, so the tenth patch release would never
 * be offered.
 */
function isNewer(candidate, current) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** Remove the installer left behind by a previous update. */
async function cleanStaging() {
  try {
    for (const name of await readdir(STAGING_DIR)) {
      await rm(join(STAGING_DIR, name), { force: true });
    }
  } catch {
    // Nothing staged, or still locked. Neither is worth reporting.
  }
}

async function fetchLatestRelease() {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CineSeat' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  return res.json();
}

async function download(url, target) {
  const res = await fetch(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'CineSeat' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`indirme başarısız (HTTP ${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(target));

  // A short file here means an error page or a truncated transfer, not an
  // installer. Running it would fail confusingly.
  const { size } = await stat(target);
  if (size < MIN_INSTALLER_BYTES) {
    throw new Error(`indirilen dosya bozuk görünüyor (${Math.round(size / 1024)} KB)`);
  }
  return size;
}

/**
 * Check, ask, download, install. Silent on failure by design — an update check
 * must never be the reason the app looks broken.
 *
 * @param {import('electron').BrowserWindow} parentWindow
 */
export async function checkForUpdates(parentWindow) {
  // Only a packaged build can be replaced by an installer, and only a packaged
  // build has a meaningful version to compare.
  if (!app.isPackaged) {
    status = { state: 'disabled', version: null, message: 'geliştirme modunda kapalı' };
    return;
  }

  await cleanStaging();

  let release;
  try {
    status = { state: 'checking', version: null, message: null };
    release = await fetchLatestRelease();
  } catch (err) {
    status = { state: 'error', version: null, message: err.message };
    console.warn(`[updater] check failed: ${err.message}`);
    return;
  }

  const latest = String(release.tag_name ?? '').replace(/^v/, '');
  if (!isNewer(latest, app.getVersion())) {
    status = { state: 'current', version: latest, message: null };
    return;
  }

  const asset = (release.assets ?? []).find((a) => a.name?.toLowerCase().endsWith('.exe'));
  if (!asset) {
    // A release with no installer is a publishing mistake; say so rather than
    // pretending the app is up to date.
    status = { state: 'error', version: latest, message: 'sürümde kurulum dosyası yok' };
    return;
  }

  status = { state: 'available', version: latest, message: null };

  const { response } = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    buttons: ['Evet, güncelle', 'Daha sonra'],
    defaultId: 0,
    cancelId: 1,
    title: 'Güncelleme',
    message: `Yeni sürüm var: ${latest}`,
    detail: `Şu an ${app.getVersion()} kullanıyorsun. İndirilip kurulsun mu? Uygulama kapanıp kendiliğinden yeniden açılacak.`,
  });
  if (response !== 0) {
    status = { state: 'postponed', version: latest, message: null };
    return;
  }

  const target = join(STAGING_DIR, asset.name);
  try {
    status = { state: 'downloading', version: latest, message: null };
    await mkdir(STAGING_DIR, { recursive: true });
    await download(asset.browser_download_url, target);
  } catch (err) {
    status = { state: 'error', version: latest, message: err.message };
    // Downloading is the step most likely to fail, and the user explicitly
    // asked for this — so unlike the check, tell them, and offer the page.
    const { response: r } = await dialog.showMessageBox(parentWindow, {
      type: 'error',
      buttons: ['Sayfayı aç', 'Kapat'],
      defaultId: 0,
      title: 'Güncelleme başarısız',
      message: 'Güncelleme indirilemedi.',
      detail: `${err.message}\n\nSürümü elle indirebilirsin.`,
    });
    if (r === 0) shell.openExternal(RELEASES_PAGE);
    return;
  }

  status = { state: 'installing', version: latest, message: null };

  // /S is the NSIS silent switch; --force-run tells the electron-builder
  // installer to relaunch the app when it finishes. Detached and unref'd so it
  // outlives this process, which has to exit for its own files to be replaced.
  spawn(target, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();

  setImmediate(() => app.quit());
}

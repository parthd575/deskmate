#!/usr/bin/env node
// Packs the Chrome extension as Deskmate.zip (with a bumped version) and puts it on Google Drive,
// replacing the previous Deskmate.zip there, so the share link people already have keeps working.
// Runs after `npm run deploy` (in cloudflare/ or the repo root).
//
// How it reaches Drive, first one that works:
//   1. Google Drive for desktop: copies into "My Drive/<folder>/Deskmate.zip". Drive syncs it as
//      a new version of the same file (same link). Auto-detected under ~/Library/CloudStorage.
//   2. rclone: `rclone copyto Deskmate.zip <remote>/Deskmate.zip` (updates the existing file).
//      Set DESKMATE_RCLONE_REMOTE, e.g. gdrive:Deskmate
//
// Options (environment variables):
//   DESKMATE_DRIVE_DIR      exact folder to copy into (overrides auto-detect)
//   DESKMATE_DRIVE_FOLDER   folder inside My Drive (default: Deskmate)
//   DESKMATE_RCLONE_REMOTE  rclone destination folder, e.g. gdrive:Deskmate
//   DESKMATE_NO_BUMP=1      don't change the version number
//   DESKMATE_SKIP_RELEASE=1 skip this step entirely
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.env.DESKMATE_SKIP_RELEASE) process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extDir = path.join(root, 'extension');
const distDir = path.join(root, 'dist');
const zipPath = path.join(distDir, 'Deskmate.zip');
const log = (...a) => console.log('[release]', ...a);

// 1) bump the extension version (0.1.4 → 0.1.5) so people can see they have the new one
const manifestPath = path.join(extDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!process.env.DESKMATE_NO_BUMP) {
  const v = String(manifest.version || '0.1.0').split('.').map(n => parseInt(n, 10) || 0);
  while (v.length < 3) v.push(0);
  v[2] += 1;
  manifest.version = v.join('.');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
log(`extension version ${manifest.version}`);

// 2) zip it (contents at the top level, so unzipping gives a folder you can "Load unpacked")
fs.mkdirSync(distDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
try {
  execFileSync('zip', ['-r', '-q', '-X', zipPath, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: extDir, stdio: 'inherit' });
} catch {
  console.error('[release] couldn’t run `zip` (it ships with macOS). Install zip and try again.');
  process.exit(1);
}
log(`packed ${path.relative(root, zipPath)} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);

// 3) Google Drive
const folderName = process.env.DESKMATE_DRIVE_FOLDER || 'Deskmate';

function driveForDesktopDir() {
  if (process.env.DESKMATE_DRIVE_DIR) return process.env.DESKMATE_DRIVE_DIR;
  const cloud = path.join(os.homedir(), 'Library', 'CloudStorage');
  let accounts = [];
  try { accounts = fs.readdirSync(cloud).filter(n => n.startsWith('GoogleDrive-')); } catch {}
  // prefer the work account if there are several
  accounts.sort((a, b) => Number(b.includes('elevationservices')) - Number(a.includes('elevationservices')));
  for (const acct of accounts) {
    for (const mine of ['My Drive', 'Il mio Drive', 'Mi unidad', 'Mon Drive', 'Meine Ablage']) {
      const p = path.join(cloud, acct, mine);
      if (fs.existsSync(p)) return path.join(p, folderName);
    }
  }
  // older Drive for desktop on a mounted volume
  for (const p of ['/Volumes/GoogleDrive/My Drive', path.join(os.homedir(), 'Google Drive', 'My Drive')]) {
    if (fs.existsSync(p)) return path.join(p, folderName);
  }
  return null;
}

const driveDir = driveForDesktopDir();
if (driveDir) {
  fs.mkdirSync(driveDir, { recursive: true });
  const dest = path.join(driveDir, 'Deskmate.zip');
  // overwrite in place: Drive keeps it as the same file (new version), so the link stays the same
  fs.copyFileSync(zipPath, dest);
  log(`copied to ${dest}`);
  log('Google Drive for desktop will upload it as a new version of the same file in a moment.');
  process.exit(0);
}

const remote = process.env.DESKMATE_RCLONE_REMOTE;
if (remote) {
  const r = spawnSync('rclone', ['copyto', zipPath, `${remote.replace(/\/+$/, '')}/Deskmate.zip`, '--progress'], { stdio: 'inherit' });
  if (r.status === 0) { log(`uploaded to ${remote}/Deskmate.zip (replaced the previous one)`); process.exit(0); }
  console.error('[release] rclone upload failed (is the remote set up? try `rclone config`).');
  process.exit(1);
}

console.log(`
[release] Built ${path.relative(root, zipPath)}, but found no way to reach Google Drive. Pick one:
  • Install Google Drive for desktop and sign in (https://www.google.com/drive/download/).
    Next deploy copies Deskmate.zip into "My Drive/${folderName}/" and Drive replaces the old one.
  • Or use rclone: brew install rclone && rclone config  (add a "drive" remote called gdrive),
    then: DESKMATE_RCLONE_REMOTE=gdrive:${folderName} npm run deploy
`);

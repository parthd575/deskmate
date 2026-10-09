// Detects whether macOS Focus / Do Not Disturb is on.
// macOS keeps the active Focus in ~/Library/DoNotDisturb/DB/Assertions.json (macOS 12+).
// Reading it needs Full Disk Access for the app on newer macOS versions.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DB = path.join(os.homedir(), 'Library', 'DoNotDisturb', 'DB');

/** Pure parser (exported for tests). Returns { on, modeId } */
export function parseAssertions(json) {
  const records = (json?.data || []).flatMap(d => d?.storeAssertionRecords || []);
  const active = records.find(r => r?.assertionDetails?.assertionDetailsModeIdentifier) || records[0];
  return { on: records.length > 0, modeId: active?.assertionDetails?.assertionDetailsModeIdentifier || null };
}

/** Pure parser: mode id → display name ("Work", "Do Not Disturb"...) */
export function modeName(json, modeId) {
  if (!modeId) return null;
  for (const d of json?.data || []) {
    const m = d?.modeConfigurations?.[modeId]?.mode;
    if (m?.name) return m.name;
  }
  return /donotdisturb\.mode\.default/.test(modeId) ? 'Do Not Disturb' : null;
}

/** Returns { on, name } or { error: 'permission' | 'unsupported' } */
export async function readMacFocus() {
  try {
    const a = JSON.parse(await fs.readFile(path.join(DB, 'Assertions.json'), 'utf8'));
    const { on, modeId } = parseAssertions(a);
    let name = null;
    if (on) {
      try { name = modeName(JSON.parse(await fs.readFile(path.join(DB, 'ModeConfigurations.json'), 'utf8')), modeId); } catch {}
    }
    return { on, name: name || (on ? 'Focus' : null) };
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') return { error: 'permission', detail: e.code };
    return { error: 'unsupported', detail: e.code || e.message };
  }
}

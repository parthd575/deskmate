// Copies the shared UI from the Chrome extension into the Mac app,
// so both always ship the same desk, bubble and call screens.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, '../../extension');
const out = path.resolve(here, '../app');
fs.rmSync(out, { recursive: true, force: true });
for (const dir of ['lib', 'sidepanel', 'bubble', 'call', 'models']) {
  fs.cpSync(path.join(ext, dir), path.join(out, dir), { recursive: true });
}
console.log('Synced shared UI → companion/app');

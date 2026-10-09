// One place that decides which character to build for a teammate.
// If extension/models/manifest.json lists rigged models, use those (three.js
// AnimationMixer + clips); otherwise fall back to the built-in procedural avatar.
import { createAvatar } from './avatar.js';
import { createMixamoAvatar, loadManifest } from './mixamo.js';

export const manifest = await loadManifest();
export const usingModels = !!manifest?.characters?.length;

/** opts: { id (stable per person), color, avatar: { model, skin, hair, style, glasses } } */
export function makeCharacter({ id = '', color, avatar = {} } = {}) {
  if (usingModels) {
    const def = manifest.characters.find(c => c.id === avatar.model);
    return createMixamoAvatar(manifest, { model: avatar.model, seed: id, color: def?.color || color });
  }
  return createAvatar({ color, skin: avatar.skin || '#F5D0B5', hair: avatar.hair || '#2B2118', style: avatar.style || 'short', glasses: avatar.glasses || 'none' });
}

const FALLBACK = [{ id: 'kid', name: 'Teammate', color: '#6C8CFF' }];
/** Characters people can choose from in setup. */
export function characterList() {
  if (!usingModels) return FALLBACK;
  return manifest.characters.map(c => ({ id: c.id, name: c.name, color: c.color || '#6C8CFF' }));
}

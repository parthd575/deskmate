// Status vocabulary shared by every surface (side panel, bubble, call, companion).

// the team's hosted server (Cloudflare). Local development: ws://localhost:8787
export const DEFAULT_SERVER = 'wss://deskmate.techguidebro.workers.dev';

export const STATUS = {
  desk:    { label: 'At desk',       short: 'Here',     emoji: '💻', color: '#22C55E', present: true },
  lunch:   { label: 'At lunch',      short: 'Lunch',    emoji: '🍜', color: '#F59E0B', present: false },
  brb:     { label: 'Be right back', short: 'BRB',      emoji: '☕', color: '#A78BFA', present: false },
  afk:     { label: 'Away',          short: 'Away',     emoji: '💤', color: '#94A3B8', present: false },
  dnd:     { label: 'Focusing',      short: 'Focus',    emoji: '🎧', color: '#EF4444', present: true },
  meeting: { label: 'In a meeting',  short: 'Meeting',  emoji: '📅', color: '#3B82F6', present: true },
  leave:   { label: 'On leave',      short: 'Leave',    emoji: '🌴', color: '#14B8A6', present: false },
};

export const QUICK = ['desk', 'lunch', 'brb', 'dnd', 'leave'];

export const PETS = [
  { id: '', label: 'None', emoji: '🚫' },
  { id: 'cat', label: 'Cat', emoji: '🐱' },
  { id: 'dog', label: 'Dog', emoji: '🐶' },
  { id: 'chick', label: 'Chick', emoji: '🐥' },
  { id: 'lion', label: 'Lion', emoji: '🦁' },
  { id: 'tiger', label: 'Tiger', emoji: '🐯' },
];

export const SKIN = ['#F5D0B5', '#E8B48F', '#C68B62', '#8D5A3B', '#5C3A24'];
export const HAIR = ['#2B2118', '#5A3825', '#A0522D', '#D9B26F', '#9AA0A6', '#E4572E'];
export const COLORS = ['#6C8CFF', '#22C55E', '#F59E0B', '#EF4444', '#A78BFA', '#14B8A6', '#EC4899', '#0EA5E9'];

/** What to show for a member, taking calls and help into account. */
export function display(member, helps = []) {
  const s = STATUS[member.state] || STATUS.desk;
  const needsHelp = helps.some(h => h.from === member.id && !h.claimedBy);
  if (needsHelp) return { ...s, label: 'Needs help', emoji: '🙋', color: '#F43F5E', key: 'help' };
  if (member.inCall) return { ...s, label: 'On a call', emoji: '📞', color: '#14B8A6', key: 'call' };
  return { ...s, key: member.state };
}

export function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}

export function since(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function untilText(ts) {
  if (!ts) return '';
  const m = Math.round((ts - Date.now()) / 60000);
  if (m > 0) return `back in ${m}m`;
  if (m === 0) return 'back any moment';
  return `${-m}m over`;
}

export function localTime(tz) {
  if (!tz) return '';
  try {
    return new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date());
  } catch { return ''; }
}

export function nameFromEmail(email = '') {
  const local = email.split('@')[0] || '';
  return local.split(/[._-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

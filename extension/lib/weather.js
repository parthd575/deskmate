// Local weather from Open-Meteo (free, no API key). Used to give the desk a sky that matches
// each person's weather and time of day.
const cache = {};

export const WEATHER = (code) => {
  if (code === 0) return { kind: 'clear', emoji: '☀️', label: 'Clear' };
  if (code <= 2) return { kind: 'partly', emoji: '⛅', label: 'Partly cloudy' };
  if (code === 3) return { kind: 'cloudy', emoji: '☁️', label: 'Cloudy' };
  if (code === 45 || code === 48) return { kind: 'fog', emoji: '🌫️', label: 'Fog' };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { kind: 'snow', emoji: '🌨️', label: 'Snow' };
  if (code >= 95) return { kind: 'storm', emoji: '⛈️', label: 'Thunderstorm' };
  if (code >= 51) return { kind: 'rain', emoji: '🌧️', label: code <= 57 ? 'Drizzle' : 'Rain' };
  return { kind: 'cloudy', emoji: '☁️', label: 'Cloudy' };
};

export function weatherEmoji(w) {
  if (!w) return '';
  const k = WEATHER(w.code);
  if (!w.isDay && (k.kind === 'clear' || k.kind === 'partly')) return k.kind === 'clear' ? '🌙' : '☁️';
  return k.emoji;
}

// "Europe/London" → "London". Used when no city is set in Settings.
export const cityFromTz = (tz = '') => (tz.split('/').pop() || '').replace(/_/g, ' ');

async function locate(place) {
  if (cache[place]) return cache[place];
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&format=json&name=${encodeURIComponent(place)}`);
  const j = await r.json();
  const hit = j.results?.[0];
  if (!hit) throw new Error(`no place called "${place}"`);
  return (cache[place] = { lat: hit.latitude, lon: hit.longitude, name: hit.name });
}

export async function fetchWeather({ place, tz }) {
  const where = (place || '').trim() || cityFromTz(tz);
  if (!where) return null;
  const loc = await locate(where);
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day`);
  const c = (await r.json()).current;
  if (!c) return null;
  return { code: c.weather_code, isDay: !!c.is_day, temp: Math.round(c.temperature_2m), place: loc.name };
}

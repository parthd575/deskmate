// Sky above the desk: follows the viewer's local time of day (dawn, day, dusk, night) and their
// weather (sun, clouds, rain, snow, fog, storms with lightning), and tints the scene lighting.
import { THREE } from './avatar.js';
import { WEATHER } from './weather.js';

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const sunTex = () => canvasTex(128, 128, (g) => {
  const r = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,248,200,1)'); r.addColorStop(0.32, 'rgba(255,214,90,1)'); r.addColorStop(0.36, 'rgba(255,200,80,0.55)'); r.addColorStop(1, 'rgba(255,190,80,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
});
const moonTex = () => canvasTex(128, 128, (g) => {
  const r = g.createRadialGradient(64, 64, 20, 64, 64, 64);
  r.addColorStop(0, 'rgba(220,230,255,0.5)'); r.addColorStop(1, 'rgba(220,230,255,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#F4F1E1'; g.beginPath(); g.arc(64, 64, 26, 0, Math.PI * 2); g.fill();
  g.globalCompositeOperation = 'destination-out';
  g.beginPath(); g.arc(78, 56, 24, 0, Math.PI * 2); g.fill();   // crescent
});
const cloudTex = () => canvasTex(256, 128, (g) => {
  g.fillStyle = '#ffffff';
  for (const [x, y, r] of [[70, 80, 34], [110, 62, 44], [155, 70, 38], [190, 86, 28], [130, 92, 36], [92, 96, 26]]) {
    const gr = g.createRadialGradient(x, y, r * 0.4, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
});
const dropTex = () => canvasTex(32, 32, (g) => {
  const gr = g.createLinearGradient(16, 0, 16, 32);
  gr.addColorStop(0, 'rgba(200,220,255,0)'); gr.addColorStop(1, 'rgba(200,220,255,0.9)');
  g.fillStyle = gr; g.fillRect(15, 0, 2, 32);
});
const flakeTex = () => canvasTex(32, 32, (g) => {
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
});

const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k);

// time of day from the local clock: 0 = midnight … 24
export function dayPhase(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 5.5 || h >= 21) return 'night';
  if (h < 7.5) return 'dawn';
  if (h < 17.5) return 'day';
  return 'dusk';
}

// Everything hangs off the camera, far behind the desks (the camera looks down at the desk, so
// the "sky" is the top part of the view, behind everything).
const D = 40;

export class Sky {
  constructor(camera, container) {
    this.camera = camera;
    this.container = container;
    this.group = new THREE.Group();
    this.group.position.z = -D;
    camera.add(this.group);
    this.weather = null;
    this.kind = 'clear';
    this.flash = 0;
    this.nextFlash = 4;

    const sprite = (tex, size) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
      s.scale.set(size, size, 1);
      s.renderOrder = -10;
      this.group.add(s);
      return s;
    };
    this.sun = sprite(sunTex(), 1);
    this.moon = sprite(moonTex(), 1);
    const ct = cloudTex();
    this.clouds = Array.from({ length: 6 }, (_, i) => {
      const c = sprite(ct, 1);
      c.userData = { u0: i / 6, v: 0.5 + (i % 3) * 0.17, w: 0.42 + (i % 3) * 0.1, speed: 0.006 + (i % 4) * 0.003 };
      return c;
    });
    // stars
    const N = 90, sp = new Float32Array(N * 3);
    this.starSeed = Array.from({ length: N }, () => [Math.random() * 2 - 1, 0.25 + Math.random() * 0.75]);
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: '#ffffff', size: 0.35, transparent: true, opacity: 0, depthWrite: false }));
    this.group.add(this.stars);
    // rain / snow, out in the background
    const P = 520;
    this.precipSeed = Array.from({ length: P }, () => ({ u: Math.random() * 2 - 1, v: Math.random() * 2 - 1, z: (Math.random() - 0.5) * 6, s: 0.7 + Math.random() * 0.6, w: Math.random() * 6 }));
    const pg = new THREE.BufferGeometry(); pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P * 3), 3));
    this.dropTex = dropTex(); this.flakeTex = flakeTex();
    this.precip = new THREE.Points(pg, new THREE.PointsMaterial({ map: this.dropTex, size: 1.5, transparent: true, opacity: 0, depthWrite: false }));
    this.group.add(this.precip);
    this.set(null);
  }

  // weather: { code, isDay, temp } for the viewer (or null for "just the clock")
  // light / dark panel: precipitation needs a different tint to show up on each
  setTheme(dark) { this.dark = dark; this.set(this.weather); }

  set(weather) {
    this.weather = weather;
    this.kind = weather ? WEATHER(weather.code).kind : 'clear';
    const snow = this.kind === 'snow';
    this.precip.material.map = snow ? this.flakeTex : this.dropTex;
    this.precip.material.size = snow ? 0.9 : 2.2;
    this.precip.material.color.set(snow ? (this.dark ? '#ffffff' : '#8FA6C8') : (this.dark ? '#A9C6FF' : '#4F6FA3'));
    this.precip.material.needsUpdate = true;
  }

  // Lighting multipliers for the scene, plus the backdrop colour (applied by the desk)
  look(date = new Date()) {
    const phase = dayPhase(date);
    const k = this.kind;
    const grey = { clear: 0, partly: 0.15, cloudy: 0.55, fog: 0.6, rain: 0.65, snow: 0.35, storm: 0.85 }[k] ?? 0;
    let sky = { night: '#1F2A5C', dawn: '#FFB08A', day: '#79C2FF', dusk: '#FF8E6E' }[phase];
    sky = mix(sky, k === 'storm' ? '#4B5568' : k === 'snow' ? '#DCE6F2' : '#A9B4C4', phase === 'night' ? grey * 0.3 : grey);
    const sunColor = phase === 'night' ? '#8FA6FF' : phase === 'day' ? mix('#ffffff', '#cfd8e6', grey).getStyle() : '#FFB37A';
    const sun = (phase === 'night' ? 0.35 : phase === 'day' ? 1 : 0.75) * (1 - grey * 0.4);
    const hemi = (phase === 'night' ? 0.6 : phase === 'day' ? 1 : 0.85) * (1 - grey * 0.15);
    return { phase, sky: '#' + sky.getHexString(), sunColor, sun, hemi, mix: phase === 'night' ? 34 : 22 };
  }

  update(t, dt) {
    const now = new Date();
    const L = this.look(now);
    if (L.sky !== this.lastSky) {
      this.lastSky = L.sky;
      this.container.style.setProperty('--sky', L.sky);
      this.container.style.setProperty('--sky-mix', L.mix + '%');
    }
    // size of the view at the sky's distance: positions below are fractions of it
    const cam = this.camera;
    const hH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * D;
    const hW = hH * cam.aspect;
    const k = this.kind, night = L.phase === 'night';
    const cloudy = { clear: 0, partly: 2, cloudy: 5, fog: 4, rain: 5, snow: 4, storm: 6 }[k] ?? 0;
    // sun / moon travel across the sky with the clock
    const h = now.getHours() + now.getMinutes() / 60;
    const dayK = THREE.MathUtils.clamp((h - 6) / 13, 0, 1);            // 6:00 → 19:00
    const nightK = THREE.MathUtils.clamp(((h + 24 - 19) % 24) / 11, 0, 1); // 19:00 → 06:00
    const arc = (u) => [(-0.8 + u * 1.6) * hW, (0.45 + Math.sin(u * Math.PI) * 0.4) * hH];
    const sz = hH * 0.42;
    this.sun.position.set(...arc(dayK), 0); this.sun.scale.set(sz, sz, 1);
    this.moon.position.set(...arc(nightK), 0); this.moon.scale.set(sz * 0.6, sz * 0.6, 1);
    this.sun.material.opacity = night ? 0 : Math.max(0, 1 - cloudy * 0.16);
    this.moon.material.opacity = night ? Math.max(0.15, 1 - cloudy * 0.15) : 0;
    // stars
    const sa = this.stars.geometry.attributes.position.array;
    this.starSeed.forEach(([u, v], i) => { sa[i * 3] = u * hW; sa[i * 3 + 1] = v * hH; sa[i * 3 + 2] = -1; });
    this.stars.geometry.attributes.position.needsUpdate = true;
    this.stars.material.opacity = night ? Math.max(0, 0.9 - cloudy * 0.2) * (0.8 + 0.2 * Math.sin(t * 2)) : 0;
    // clouds drift by
    this.clouds.forEach((c, i) => {
      const u = c.userData;
      const show = i < cloudy;
      c.material.opacity += ((show ? (k === 'storm' ? 0.95 : 0.85) : 0) - c.material.opacity) * Math.min(1, dt);
      c.material.color.set(k === 'storm' || k === 'rain' ? '#9aa3b2' : night ? '#6b7699' : '#ffffff');
      const x = (((u.u0 + t * u.speed) % 1) * 2.6 - 1.3) * hW;
      c.position.set(x, u.v * hH, 0.5);
      c.scale.set(u.w * hW, u.w * hW * 0.5, 1);
    });
    // rain / snow, falling behind the desks
    const wet = k === 'rain' || k === 'storm' || k === 'snow';
    this.precip.material.opacity += ((wet ? 0.85 : 0) - this.precip.material.opacity) * Math.min(1, dt * 2);
    if (this.precip.material.opacity > 0.01) {
      const arr = this.precip.geometry.attributes.position.array;
      const fall = (k === 'snow' ? 0.12 : 1.1);
      this.precipSeed.forEach((p, i) => {
        p.v -= fall * p.s * dt;
        if (p.v < -1) p.v += 2;
        arr[i * 3] = (p.u + (k === 'snow' ? Math.sin(t + p.w) * 0.02 : 0)) * hW;
        arr[i * 3 + 1] = p.v * hH;
        arr[i * 3 + 2] = p.z;
      });
      this.precip.geometry.attributes.position.needsUpdate = true;
    }
    // lightning
    if (k === 'storm') {
      this.nextFlash -= dt;
      if (this.nextFlash < 0) { this.flash = 1; this.nextFlash = 5 + Math.random() * 8; }
    }
    this.flash = Math.max(0, this.flash - dt * 3);
    return { ...L, flash: this.flash };
  }
}

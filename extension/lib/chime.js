// Short notification sounds, synthesised with Web Audio (no sound files to ship).
//   help   - a soft rising three-note bell: "someone needs a hand"
//   invite - a two-tone ring, played twice: "someone is calling you"
//   standup - a warm gong, struck twice: "stand-up time"
let ctx = null;

function bell(ac, out, freq, at, len = 0.9, gain = 0.22) {
  // a sine with a quiet octave partial, quick attack and a long decay = a gentle bell
  for (const [mult, g] of [[1, gain], [2, gain * 0.25], [3, gain * 0.08]]) {
    const o = ac.createOscillator();
    const v = ac.createGain();
    o.type = 'sine';
    o.frequency.value = freq * mult;
    v.gain.setValueAtTime(0.0001, at);
    v.gain.exponentialRampToValueAtTime(g, at + 0.015);
    v.gain.exponentialRampToValueAtTime(0.0001, at + len / mult);
    o.connect(v).connect(out);
    o.start(at);
    o.stop(at + len + 0.05);
  }
}

export async function playChime(kind = 'help', volume = 0.8) {
  ctx ||= new (globalThis.AudioContext || globalThis.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  const out = ctx.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume));
  out.connect(ctx.destination);
  const t = ctx.currentTime + 0.03;
  if (kind === 'invite') {
    for (const start of [0, 1.1]) {
      bell(ctx, out, 784, t + start, 0.5, 0.2);        // G5
      bell(ctx, out, 1047, t + start + 0.18, 0.7, 0.2); // C6
    }
    return 2.0;
  }
  if (kind === 'standup') {
    // a warm gong, struck twice: "gather round"
    bell(ctx, out, 220, t, 2.6, 0.3);
    bell(ctx, out, 330, t, 2.2, 0.12);
    bell(ctx, out, 220, t + 0.9, 2.6, 0.24);
    bell(ctx, out, 330, t + 0.9, 2.2, 0.1);
    return 3.5;
  }
  // help: E5 → G#5 → B5
  bell(ctx, out, 659.3, t, 0.9);
  bell(ctx, out, 830.6, t + 0.14, 0.9);
  bell(ctx, out, 987.8, t + 0.28, 1.2);
  return 1.5;
}

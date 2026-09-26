/** Soft chime synthesised with Web Audio (no audio files to ship). */
let ctx: AudioContext | null = null;

/** Browsers only allow audio after a user gesture: call this from a click. */
export function unlockAudio() {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

/** Rising notes when a focus block starts, falling ones when a break starts. */
export function chime(next: 'focus' | 'break') {
  unlockAudio();
  if (!ctx) return;
  const notes = next === 'break' ? [880, 659.25, 523.25] : [523.25, 659.25, 880];
  const t0 = ctx.currentTime + 0.05;
  notes.forEach((freq, i) => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t = t0 + i * 0.22;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.connect(gain).connect(ctx!.destination);
    osc.start(t);
    osc.stop(t + 1);
  });
}

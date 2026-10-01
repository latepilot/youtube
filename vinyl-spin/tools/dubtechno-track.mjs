#!/usr/bin/env node
// Синтетический даб-техно трек с точной разметкой — эталон для проверки анализа в viz.html.
//   node tools/dubtechno-track.mjs out/test/dub.wav   → dub.wav + dub.truth.json
// 122 BPM, 4/4. Секции: intro (без кика) → groove → break (без кика и хэтов, аккорды с дилеем) → groove (дроп) → outro.
// Есть то, что мешает анализу в жизни: саб-бас с медленной атакой, эхо аккордов, винил-треск.
import fs from 'node:fs';
import path from 'node:path';

// варианты для проверки устойчивости: --bpm 118.5 --swing 18 --soft --bass --clap
const opt = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? Number(process.argv[i + 1]) : true); };
const SR = 44100;
const BPM = opt('bpm', 122), BEAT = 60 / BPM, BAR = 4 * BEAT;
const SWING = opt('swing', 0) / 1000, SOFT = !!opt('soft', false), BASS = !!opt('bass', false), CLAP = !!opt('clap', false);
const T0 = 0.25;                 // первая сильная доля
const SECTIONS = [               // [тип, первый такт, такт после конца]
  ['intro', 0, 8], ['groove', 8, 24], ['break', 24, 32], ['groove', 32, 48], ['outro', 48, 56],
];
const BARS = 56;
const DUR = T0 + BARS * BAR + 3;
const N = Math.ceil(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N);

// детерминированный шум
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;

const sectionOf = (bar) => SECTIONS.find(([, a, b]) => bar >= a && bar < b)[0];
const tBeat = (bar, beat) => T0 + (bar * 4 + beat) * BEAT;
const add = (i, l, r) => { if (i >= 0 && i < N) { L[i] += l; R[i] += r; } };

const truth = { bpm: BPM, beat0: T0, barPhase: 0, kicks: [], hats: [], stabs: [], sections: [] };

// ---------- кик: синус с падающей высотой + щелчок ----------
function kick(t, amp = SOFT ? 0.6 : 0.9) {
  const i0 = Math.round(t * SR); let ph = 0;
  for (let n = 0; n < 0.45 * SR; n++) {
    const tau = n / SR, f = (SOFT ? 44 + 60 * Math.exp(-tau / 0.04) : 46 + 120 * Math.exp(-tau / 0.028));
    ph += 2 * Math.PI * f / SR;
    const att = SOFT ? Math.min(1, tau / 0.004) : 1;
    const s = Math.sin(ph) * att * Math.exp(-tau / 0.2) * amp + (SOFT ? 0 : noise() * Math.exp(-tau / 0.0015) * 0.25);
    add(i0 + n, s, s);
  }
  truth.kicks.push(+t.toFixed(4));
}
// ---------- хэт: шум, дважды продифференцированный (только верх) ----------
function hat(t, amp = 0.22, open = false) {
  const i0 = Math.round(t * SR); let x1 = 0, x2 = 0;
  const len = open ? 0.18 : 0.06, dec = open ? 0.06 : 0.018;
  for (let n = 0; n < len * SR; n++) {
    const x = noise(), d1 = x - x1, d2 = d1 - x2; x1 = x; x2 = d1;
    const s = d2 * 0.5 * Math.exp(-n / SR / dec) * amp;
    add(i0 + n, s * 0.9, s);
  }
}
// ---------- клэп (2 и 4) и катящийся бас на синкопах — мешают отличать кик и аккорды ----------
function clap(t) {
  const i0 = Math.round(t * SR); let lp = 0, hp = 0;
  for (let n = 0; n < 0.2 * SR; n++) {
    const tau = n / SR, x = noise(); lp += 0.25 * (x - lp); hp = lp - hp * 0.0;
    const env = (tau < 0.02 ? 0.6 + 0.4 * Math.cos(tau * 900) : 1) * Math.exp(-tau / 0.06);
    const s = (x - lp) * env * 0.25; add(i0 + n, s, s * 0.95);
  }
}
function bassPluck(t) {
  const i0 = Math.round(t * SR); let ph = 0;
  for (let n = 0; n < 0.2 * SR; n++) { const tau = n / SR; ph += 2 * Math.PI * 55 / SR; const s = Math.sin(ph) * Math.min(1, tau / 0.006) * Math.exp(-tau / 0.07) * 0.35; add(i0 + n, s, s); }
}
// ---------- даб-аккорд: Dm7 из расстроенных пил через фильтр, эхо 3/16 с затуханием ----------
const CHORD = [146.83, 174.61, 220.0, 261.63];
function stab(t, amp, cutoff, pan) {
  const i0 = Math.round(t * SR), len = 0.7 * SR;
  const a = 1 - Math.exp(-2 * Math.PI * cutoff / SR);
  let y1 = 0, y2 = 0;
  const ph = CHORD.flatMap(f => [0, 0]);
  for (let n = 0; n < len; n++) {
    const tau = n / SR;
    let x = 0;
    CHORD.forEach((f, k) => {
      for (let v = 0; v < 2; v++) {
        const ff = f * (v ? 1.004 : 0.996);
        ph[k * 2 + v] = (ph[k * 2 + v] + ff / SR) % 1;
        x += ph[k * 2 + v] * 2 - 1;
      }
    });
    y1 += a * (x - y1); y2 += a * (y1 - y2);         // 12 дБ/окт
    const env = Math.min(1, tau / 0.003) * Math.exp(-tau / 0.13);
    const s = y2 * env * amp * 0.12;
    add(i0 + n, s * (1 - pan), s * (1 + pan));
  }
}
function dubStab(t, amp = 1) {
  truth.stabs.push(+t.toFixed(4));
  stab(t, amp, 1800, 0);
  for (let k = 1; k <= 5; k++) stab(t + k * 0.75 * BEAT, amp * Math.pow(0.55, k), 1800 * Math.pow(0.72, k), k % 2 ? -0.6 : 0.6);
}

// ---------- раскладка по тактам ----------
for (let bar = 0; bar < BARS; bar++) {
  const sec = sectionOf(bar);
  const hasKick = sec === 'groove' || sec === 'outro';
  const hasHats = (sec === 'intro' && bar >= 4) || sec === 'groove' || sec === 'outro';
  const hasStab = (sec === 'intro' && bar >= 2) || sec === 'groove' || sec === 'break';
  for (let b = 0; b < 4; b++) {
    if (hasKick) kick(tBeat(bar, b));
    if (hasHats) { const th = tBeat(bar, b + 0.5) + SWING; hat(th, 0.22, b === 3 && bar % 4 === 3); truth.hats.push(+th.toFixed(4)); }
    if (CLAP && hasKick && (b === 1 || b === 3)) clap(tBeat(bar, b));
    if (BASS && hasKick) bassPluck(tBeat(bar, b + 0.75));
    if (hasHats && sec !== 'intro') hat(tBeat(bar, b + 0.75), 0.07);           // тихие шестнадцатые (не в разметке)
  }
  if (hasStab) dubStab(tBeat(bar, 1.5), sec === 'break' ? 1.15 : 0.9);
}
for (const [type, a] of SECTIONS) truth.sections.push({ t: +tBeat(a, 0).toFixed(4), bar: a, type });

// ---------- саб-бас: медленная атака каждые 2 такта (не должен считаться киком) ----------
for (let bar = 0; bar < BARS; bar += 2) {
  const sec = sectionOf(bar); if (sec === 'intro' && bar < 4) continue;
  const i0 = Math.round(tBeat(bar, 0) * SR), len = Math.round(2 * BAR * SR), f = 36.71;
  const amp = sec === 'break' ? 0.18 : 0.28;
  for (let n = 0; n < len; n++) {
    const tau = n / SR, env = Math.min(1, tau / 0.25) * Math.min(1, (len - n) / SR / 0.3);
    const s = Math.sin(2 * Math.PI * f * tau) * env * amp; add(i0 + n, s, s);
  }
}
// ---------- пэд в брейке (шумовая «вода») и винил-треск по всему треку ----------
{
  let lp = 0, lp2 = 0;
  for (let n = 0; n < N; n++) {
    const t = n / SR;
    lp += 0.02 * (noise() - lp); lp2 += 0.3 * (noise() - lp2);
    let s = lp * 0.03 + lp2 * 0.004;                                       // шумовой пол
    const b0 = tBeat(24, 0), b1 = tBeat(32, 0);
    if (t > b0 && t < b1) s += lp * 0.25 * Math.sin(Math.PI * (t - b0) / (b1 - b0)) * (0.6 + 0.4 * Math.sin(t * 1.3));
    if (rnd() < 2.5 / SR) { const c = noise() * 0.12; for (let k = 0; k < 20; k++) add(n + k, c * Math.exp(-k / 4), c * Math.exp(-k / 4)); }
    L[n] += s; R[n] += s * 0.97;
  }
}

// ---------- запись WAV 16 бит ----------
let peak = 0; for (let n = 0; n < N; n++) peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
const g = 0.89 / peak;
const out = process.argv[2] || 'dub.wav';
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let n = 0; n < N; n++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[n] * g * 32767))), 44 + n * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[n] * g * 32767))), 46 + n * 4);
}
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, buf);
truth.duration = N / SR;
fs.writeFileSync(out.replace(/\.wav$/i, '') + '.truth.json', JSON.stringify(truth, null, 1));
console.log(`${out}: ${(N / SR).toFixed(2)} с, ${truth.kicks.length} киков, ${truth.hats.length} хэтов, ${truth.stabs.length} аккордов, секции: ${truth.sections.map(s => s.type + '@' + s.bar).join(' ')}`);

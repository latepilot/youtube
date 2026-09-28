#!/usr/bin/env node
// Проверки vinyl-spin: тестовые исходники, детерминизм кадра, звук бит-в-бит во всех форматах, скорость.
//   node test.mjs            всё
//   node test.mjs assets     только сгенерировать исходники в out/test
//   node test.mjs hash|audio|speed|webcodecs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'out', 'test');
const what = process.argv[2] || 'all';
const browserName = process.env.VS_BROWSER || (process.platform === 'darwin' ? 'chrome' : 'chromium');
fs.mkdirSync(DIR, { recursive: true });

let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };
const sh = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0 && r.status !== 2) throw new Error(`${cmd} ${argv.join(' ')}\n${r.stderr}\n${r.stdout}`);
  return r;
};
const render = (argv) => sh('node', [path.join(HERE, 'render.mjs'), '--browser', browserName, ...argv]);

// ---------- исходники ----------
async function makeAssets() {
  const b = await chromium.launch({ channel: browserName });
  const p = await b.newPage();
  await p.goto(pathToFileURL(path.join(HERE, 'index.html')).href);
  const imgs = await p.evaluate(() => ({ bg: placeholderBg().toDataURL('image/png'), disk: placeholderDisk().toDataURL('image/png') }));
  await b.close();
  for (const [k, v] of Object.entries(imgs)) fs.writeFileSync(path.join(DIR, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
  fs.copyFileSync(path.join(HERE, 'assets', 'logo-from-reference.png'), path.join(DIR, 'logo.png'));
  // звук: синус + розовый шум, чтобы работали все младшие биты
  const src = ['-f', 'lavfi', '-i', 'sine=f=220:d=8:sample_rate=96000', '-f', 'lavfi', '-i', 'anoisesrc=d=8:a=0.08:c=pink:r=96000:seed=5',
    '-filter_complex', '[0][1]amix=inputs=2:normalize=0,pan=stereo|c0=c0|c1=0.7*c0'];
  const audio = [
    ['wav24.wav', ['-ar', '48000', '-c:a', 'pcm_s24le']],
    ['wav16.wav', ['-ar', '44100', '-c:a', 'pcm_s16le']],
    ['float32.wav', ['-ar', '48000', '-c:a', 'pcm_f32le']],
    ['aiff24.aiff', ['-ar', '48000', '-c:a', 'pcm_s24be']],
    ['flac24-96.flac', ['-ar', '96000', '-sample_fmt', 's32', '-c:a', 'flac']],
    ['flac16.flac', ['-ar', '44100', '-sample_fmt', 's16', '-c:a', 'flac']],
    ['mp3-320.mp3', ['-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '320k']],
    ['aac.m4a', ['-ar', '48000', '-c:a', 'aac', '-b:a', '256k']],
  ];
  for (const [name, enc] of audio) sh('ffmpeg', ['-v', 'error', '-y', ...src, ...enc, path.join(DIR, name)]);
  fs.writeFileSync(path.join(DIR, 'preset.json'), JSON.stringify({ app: 'vinyl-spin', version: 1, params: {}, files: { bg: 'bg.png', disk: 'disk.png', logo: 'logo.png', audio: 'wav24.wav' } }, null, 2));
  console.log(`исходники: ${DIR}`);
}

// ---------- детерминизм: кадр рендерится в двух разных запусках браузера ----------
function testHash() {
  const n = 300;
  const hash = () => /sha256 ([0-9a-f]{64})/.exec(render(['--preset', path.join(DIR, 'preset.json'), '--frame', String(n), '--hash']).stdout)?.[1];
  const a = hash(), b = hash();
  ok(a && a === b, `детерминизм: кадр ${n} в двух запусках, sha256 ${a?.slice(0, 16)}… ${a === b ? '=' : '≠'} ${b?.slice(0, 16)}…`);
  const c = /sha256 ([0-9a-f]{64})/.exec(render(['--preset', path.join(DIR, 'preset.json'), '--frame', String(n + 1), '--hash']).stdout)?.[1];
  ok(c && c !== a, 'соседний кадр отличается (зерно и диск анимированы)');
}

// ---------- звук бит-в-бит для каждого формата ----------
function testAudio() {
  for (const f of fs.readdirSync(DIR).filter(f => /\.(wav|aiff|flac|mp3|m4a)$/.test(f) && !f.includes('.vinyl'))) {
    const enc = process.platform === 'darwin' ? ['--encoder', 'auto'] : ['--encoder', 'x264', '--x264-preset', 'ultrafast'];
    const r = render(['--preset', path.join(DIR, 'preset.json'), '--audio', path.join(DIR, f), '--res', '720', ...enc, '--out', path.join(DIR, 'audio-' + f.replace(/\./g, '_') + '.mov')]);
    const o = r.stdout;
    const same = /звук бит-в-бит.*✓/.test(o);
    const frames = /кадров (\d+) ✓/.test(o);
    const pk = /пакеты .*: (✓|✗)/.exec(o)?.[1];
    const aline = /звук в файле: (.*)/.exec(o)?.[1];
    ok(same && frames && pk !== '✗', `${f.padEnd(16)} → ${/→ (.*)/.exec(o)?.[1]?.split('/').pop()}: ${aline}; PCM md5 ${same ? 'совпал' : 'НЕ совпал'}${pk ? `, пакеты ${pk}` : ''}, число кадров ${frames ? 'верное' : 'НЕВЕРНОЕ'}`);
    if (!same) console.log(o);
  }
}

// ---------- скорость: 1080p30, VS_SPEED_SEC секунд (по умолчанию 60 на маке, 20 здесь), зум рассчитан на час ----------
function testSpeed() {
  const mac = process.platform === 'darwin';
  const sec = process.env.VS_SPEED_SEC || (mac ? '60' : '20');
  for (const enc of (process.env.VS_SPEED_ENCODERS || (mac ? 'webcodecs,videotoolbox' : 'x264')).split(',')) {
    const out = path.join(DIR, `speed-${enc}.mp4`);
    const r = render(['--preset', path.join(DIR, 'preset.json'), '--audio', '', '--duration', '3600', '--limit', sec, '--encoder', enc, '--out', out]);
    console.log(`[${enc}]\n` + r.stdout.split('\n').filter(l => /Готово|файл:|GPU|кодировщик/.test(l)).join('\n'));
    const fps = Number(/([\d.]+) кадр\/с, ×/.exec(r.stdout)?.[1]);
    if (fps) console.log(`  → час видео 1080p30 займёт ≈ ${(108000 / fps / 60).toFixed(0)} мин`);
  }
}

// ---------- WebCodecs (в контейнере только VP9: у Chromium из Playwright нет H.264) ----------
function testWebcodecs() {
  const codec = process.env.VS_WC_CODEC || (browserName === 'chrome' ? 'h264' : 'vp9');
  const out = path.join(DIR, `webcodecs-${codec}.${codec === 'vp9' ? 'mkv' : 'mov'}`);
  const r = render(['--preset', path.join(DIR, 'preset.json'), '--encoder', 'webcodecs', '--codec', codec, '--res', '720', '--out', out]);
  console.log(r.stdout.split('\n').filter(l => /Готово|файл:|кодировщик|бит-в-бит/.test(l)).join('\n'));
  ok(/бит-в-бит.*✓/.test(r.stdout) && /кадров \d+ ✓/.test(r.stdout), `WebCodecs ${codec}: поток собран без перекодирования, звук и число кадров верны`);
  const ref = path.join(DIR, 'wc-ref.mov');
  try { render(['--preset', path.join(DIR, 'preset.json'), '--encoder', 'x264', '--crf', '0', '--x264-preset', 'ultrafast', '--res', '720', '--out', ref]); }
  catch (e) { console.log('  (сравнение с эталоном пропущено: в этом ffmpeg нет libx264)'); return; }
  // зерно не сжимается, поэтому сравниваем размытые уменьшенные кадры: остаются цвета, геометрия и фаза вращения.
  // Каждый кадр ролика должен быть ближе всего к кадру эталона с тем же номером.
  const grab = (f) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-vf', 'select=lt(n\\,24),gblur=sigma=3,scale=160:90', '-vsync', '0', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 26 }); return Array.from({ length: 24 }, (_, i) => r.stdout.subarray(i * 14400, (i + 1) * 14400)); };
  const A = grab(out), B = grab(ref);
  const mad = (x, y) => { let s = 0; for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]); return s / x.length; };
  let aligned = 0, worst = 0;
  A.forEach((a, i) => { const d = B.map(b => mad(a, b)); const best = d.indexOf(Math.min(...d)); if (best === i) aligned++; worst = Math.max(worst, d[i]); });
  ok(aligned === A.length && worst < 2, `WebCodecs против lossless-эталона: ${aligned}/${A.length} кадров совпали по номеру, макс. ошибка после размытия ${worst.toFixed(2)}/255`);
}

if (what === 'all' || what === 'assets' || !fs.existsSync(path.join(DIR, 'preset.json'))) await makeAssets();
if (what === 'all' || what === 'hash') testHash();
if (what === 'all' || what === 'audio') testAudio();
if (what === 'all' || what === 'webcodecs') testWebcodecs();
if (what === 'all' || what === 'speed') testSpeed();
console.log(failed ? `\nНе прошло проверок: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);

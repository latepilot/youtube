#!/usr/bin/env node
// vinyl-spin studio: локальный сервер для рендера кнопкой из редактора, без командной строки.
// Запускается двойным кликом по «vinyl-spin.command». Открывает index.html в Chrome; кадры рисует и кодирует
// сам открытый Chrome (WebCodecs H.264), а сервер принимает поток и собирает ролик в ffmpeg со звуком без потерь.
// Нужны только Node и ffmpeg, npm install не нужен.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { audioPlan, ffmpegArgs, startFfmpeg, verifyOutput, ffmpegVersion } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
// версия кода сервера: если на порту висит старая копия (запущена до git pull), новая её сменит
const VERSION = crypto.createHash('sha1').update(fs.readFileSync(fileURLToPath(import.meta.url))).update(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib.mjs'))).digest('hex').slice(0, 12);
const PORT = Number(process.env.VS_PORT) || 8420;
// куда сохранять ролики: выбор пользователя запоминается в ~/.vinyl-spin.json, по умолчанию — рабочий стол
const CONFIG = path.join(os.homedir(), '.vinyl-spin.json');
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
let OUT_DIR = process.env.VS_OUT || readConfig().outDir || path.join(os.homedir(), 'Desktop');
if (!process.env.VS_OUT && !fs.existsSync(OUT_DIR)) OUT_DIR = path.join(os.homedir(), 'Desktop');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vinyl-spin-'));
const log = (...m) => console.log(new Date().toTimeString().slice(0, 8), ...m);

const ffver = ffmpegVersion();
if (!ffver) {
  console.error('Не найден ffmpeg. Поставь его (например, «brew install ffmpeg») и запусти снова.');
  process.exit(1);
}

const audios = new Map(); // id → { path, name, plan }
const jobs = new Map();   // id → { job, out, count, fps, ... }
const id = () => crypto.randomBytes(6).toString('hex');

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }
function readJSON(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); }); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { rej(e); } }); });
}
function uniquePath(dir, base, ext) {
  base = base.replace(/[\/\\:*?"<>|]+/g, '_').trim() || 'vinyl-spin';
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}
function openInBrowser(url) {
  if (process.platform === 'darwin') {
    const p = spawn('open', ['-a', 'Google Chrome', url], { stdio: 'ignore' });
    p.on('close', code => { if (code !== 0) spawn('open', [url], { stdio: 'ignore' }); });
  } else if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else spawn('xdg-open', [url], { stdio: 'ignore' }).on('error', () => { });
}
function reveal(file) {
  if (process.platform === 'darwin') spawn('open', ['-R', file], { stdio: 'ignore' });
  else if (process.platform === 'win32') spawn('explorer', ['/select,', file], { stdio: 'ignore' });
  else spawn('xdg-open', [path.dirname(file)], { stdio: 'ignore' }).on('error', () => { });
}

async function handle(req, res) {
  // принимаем запросы только к самому себе (защита от DNS rebinding)
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html' || p === '/viz.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(path.join(HERE, p === '/viz.html' ? 'viz.html' : 'index.html')).pipe(res); return;
  }
  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, version: VERSION, ffmpeg: ffver, platform: process.platform, outDir: OUT_DIR });
  // выбор папки: родное окно Finder «Выбрать папку» (только на Маке); выбор запоминается
  if (req.method === 'POST' && p === '/api/outdir/choose') {
    if (process.platform !== 'darwin') return json(res, 400, { error: 'выбор папки окном есть только на Маке' });
    const script = `POSIX path of (choose folder with prompt "Куда сохранять ролики vinyl-spin" default location (POSIX file "${OUT_DIR.replace(/"/g, '')}"))`;
    const r = await new Promise(ok => { const pr = spawn('osascript', ['-e', script]); let out = '', err = ''; pr.stdout.on('data', d => out += d); pr.stderr.on('data', d => err += d); pr.on('close', code => ok({ code, out: out.trim(), err })); });
    if (r.code !== 0 || !r.out) return json(res, 200, { cancelled: true, outDir: OUT_DIR });
    const dir = r.out.replace(/\/$/, '') || '/';
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { return json(res, 400, { error: 'в эту папку нельзя записывать', outDir: OUT_DIR }); }
    OUT_DIR = dir; fs.writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), outDir: dir }, null, 1));
    log(`ролики теперь сохраняются в ${dir}`);
    return json(res, 200, { outDir: dir });
  }
  if (req.method === 'POST' && p === '/api/quit') {
    if (jobs.size) return json(res, 409, { error: 'идёт рендер' });
    json(res, 200, { ok: true }); log('остановлен: запущена новая версия'); setTimeout(cleanup, 100); return;
  }

  // звук: браузер присылает файл целиком, сервер кладёт его во временную папку и решает, как его вшить
  if (req.method === 'POST' && p === '/api/audio') {
    const name = path.basename(url.searchParams.get('name') || 'audio');
    const aid = id(), file = path.join(TMP, `${aid}-${name}`);
    await new Promise((ok, fail) => { const w = fs.createWriteStream(file); req.pipe(w); w.on('finish', ok); w.on('error', fail); req.on('error', fail); });
    try {
      const plan = audioPlan(file);
      audios.set(aid, { path: file, name, plan });
      log(`звук: ${name}, ${plan.T.toFixed(3)} с, ${plan.desc}`);
      return json(res, 200, { id: aid, T: plan.T, desc: plan.desc, ext: plan.ext });
    } catch (e) { fs.rmSync(file, { force: true }); return json(res, 400, { error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/job') {
    const o = await readJSON(req);
    const a = o.audioId ? audios.get(o.audioId) : null;
    if (o.audioId && !a) return json(res, 400, { error: 'звук не найден, загрузи его ещё раз' });
    const encoder = o.encoder === 'webcodecs' ? 'webcodecs' : (process.platform === 'darwin' ? 'videotoolbox' : 'x264');
    const partial = o.startFrame > 0 || o.count < o.totalFrames;
    const ext = o.vp9 ? '.mkv' : a ? a.plan.ext : '.mp4';
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const mmss = (f) => { const s = Math.round(f / o.fps); return `${Math.floor(s / 60)}м${String(s % 60).padStart(2, '0')}с`; };
    const out = uniquePath(OUT_DIR, (o.name || 'vinyl-spin') + (partial ? ` (${mmss(o.startFrame)}–${mmss(o.startFrame + o.count)})` : ''), ext);
    const argsFF = ffmpegArgs({ encoder, vp9: o.vp9, W: o.W, H: o.H, fps: o.fps, bitrate: o.bitrate, gop: o.gop, audio: a?.path, plan: a?.plan, startFrame: o.startFrame, count: o.count, partial, out });
    const jid = id();
    jobs.set(jid, { job: startFfmpeg(argsFF), out, count: o.count, fps: o.fps, audio: a, partial, t0: Date.now() });
    const desc = encoder === 'webcodecs' ? `WebCodecs ${o.codec} → ffmpeg без перекодирования` : `кадры → ffmpeg ${encoder === 'videotoolbox' ? 'h264_videotoolbox' : 'libx264'}`;
    log(`рендер: ${path.basename(out)}, ${o.W}×${o.H} ${o.fps} fps, ${o.count} кадров, ${desc}`);
    return json(res, 200, { id: jid, out, desc, audio: a ? a.plan.desc : 'без звука' });
  }

  const m = /^\/api\/job\/([0-9a-f]+)\/(data|finish|cancel|reveal)$/.exec(p);
  if (req.method === 'POST' && m) {
    const j = jobs.get(m[1]);
    if (!j) return json(res, 404, { error: 'задание не найдено' });
    if (m[2] === 'data') {
      if (j.job.failed) { req.resume(); const e = await j.job.done.catch(e => e); return json(res, 500, { error: e?.message || 'ffmpeg упал' }); }
      await j.job.pipeRequest(req);
      res.writeHead(204); res.end(); return;
    }
    if (m[2] === 'cancel') {
      j.job.kill(); await j.job.done.catch(() => { });
      fs.rmSync(j.out, { force: true }); jobs.delete(m[1]);
      log(`отменено: ${path.basename(j.out)}`);
      return json(res, 200, { ok: true });
    }
    if (m[2] === 'reveal') { reveal(j.out); return json(res, 200, { ok: true }); }
    // finish
    j.job.end();
    try { await j.job.done; } catch (e) { return json(res, 500, { error: e.message }); }
    const wall = (Date.now() - j.t0) / 1000;
    const r = await verifyOutput({ out: j.out, count: j.count, fps: j.fps, audio: j.audio?.path, plan: j.audio?.plan, partial: j.partial, T: j.audio?.plan.T, wall });
    r.lines.forEach(l => log(l));
    return json(res, 200, { ok: r.ok, lines: r.lines, out: j.out });
  }
  res.writeHead(404); res.end();
}

const server = http.createServer((req, res) => handle(req, res).catch(e => { log('ошибка:', e.message); if (!res.headersSent) json(res, 500, { error: e.message }); else res.end(); }));
server.requestTimeout = 0; // длинные загрузки звука и потоки видео

// старая копия: сначала просим выйти, если не умеет — завершаем процесс node studio.mjs, который держит порт
async function stopOld(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST' }); if (r.ok) { await new Promise(r => setTimeout(r, 400)); return true; } if (r.status === 409) return false; } catch { }
  if (process.platform === 'win32') return false;
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).toString().trim().split(/\s+/).filter(Boolean);
    let killed = false;
    for (const pid of pids) {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid]).toString();
      if (/studio\.mjs/.test(cmd) && Number(pid) !== process.pid) { process.kill(Number(pid), 'SIGTERM'); killed = true; }
    }
    if (killed) await new Promise(r => setTimeout(r, 600));
    return killed;
  } catch { return false; }
}
function listen(port) {
  server.once('error', async (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    // уже запущен? та же версия — просто открываем редактор; старая — останавливаем её и занимаем порт
    let info = null;
    try { info = await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json(); } catch { }
    if (info?.ok && info.version === VERSION) { console.log(`vinyl-spin уже запущен: http://127.0.0.1:${port}/`); if (!NO_OPEN) openInBrowser(`http://127.0.0.1:${port}/`); process.exit(0); }
    if (info?.ok && port < PORT + 5 && await stopOld(port)) { console.log('Остановил старую копию vinyl-spin, запускаю новую.'); return setTimeout(() => listen(port), 300); }
    listen(port + 1);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`\nvinyl-spin работает: ${url}\n  ${ffver}\n  готовые ролики: ${OUT_DIR}\n  Это окно не закрывай, пока работаешь; закрыл — редактор перестанет рендерить.\n`);
    if (!NO_OPEN) openInBrowser(url);
  });
}
listen(PORT);

const cleanup = () => { for (const j of jobs.values()) j.job.kill(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', cleanup); process.on('SIGTERM', cleanup); process.on('SIGHUP', cleanup);

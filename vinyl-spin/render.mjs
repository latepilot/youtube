#!/usr/bin/env node
// vinyl-spin: рендер ролика во всю длину аудио.
// Кадры рисует тот же index.html (WebGL2, seek(t)), что и превью. Видео кодирует браузер
// через WebCodecs (H.264, на маке аппаратно) или ffmpeg из сырых yuv420p-кадров (запасной путь).
// Звук не перекодируется с потерями: PCM остаётся PCM, MP3/AAC копируются как есть.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
vinyl-spin render: ролик «вращающаяся пластинка» во всю длину аудио

  node render.mjs --preset preset.json [--bg фон.jpg --disk диск.png --logo лого.png --audio микс.wav] [--out ролик.mov]

Файлы из пресета («files») ищутся рядом с пресетом; флаги их перекрывают.

  --out ПУТЬ          итоговый файл (по умолчанию рядом с аудио; .mov для PCM, .mp4 для MP3/AAC)
  --fps 25|30|50|60   частота кадров (иначе из пресета)
  --res 1080|1440|2160|ШxВ
  --bitrate МБИТ      битрейт видео (иначе из пресета, по умолчанию 25)
  --duration СЕК      длительность, если аудио нет
  --from СЕК          начать с этой секунды (отрицательное значение = от конца)
  --limit СЕК         рендерить только столько секунд (для быстрой проверки)
  --encoder auto|webcodecs|videotoolbox|x264
                      auto: H.264 в браузере, если есть; иначе videotoolbox на маке, x264 в остальных случаях
  --codec h264|vp9    кодек для WebCodecs (vp9 только для проверки, файл .mkv)
  --crf N             для x264: качество вместо битрейта
  --x264-preset ИМЯ   для x264 (по умолчанию medium)
  --browser chrome|chromium   (по умолчанию chrome на маке, chromium в остальных случаях)
  --headed            показать окно браузера (если без окна нет GPU)
  --frame N --hash    вывести SHA-256 пикселей кадра N (проверка детерминизма)
  --frame N --png ПУТЬ  сохранить кадр N в PNG
  --no-verify         не проверять звук бит-в-бит после рендера
`;

// ---------- аргументы ----------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`непонятный аргумент: ${k}`);
    const key = k.slice(2), next = argv[i + 1];
    if (next === undefined || (next.startsWith('--') && !/^--?\d/.test(next))) a[key] = true;
    else { a[key] = next; i++; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) { console.log(HELP); process.exit(0); }

const log = (...m) => console.log(...m);
const die = (m) => { console.error('\nОшибка: ' + m); process.exit(1); };

// ---------- ffmpeg / ffprobe ----------
function ffprobeJSON(file, extra = []) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file], { maxBuffer: 64 << 20 });
  return JSON.parse(out.toString());
}
function run(cmd, argv, { input } = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? res({ out, err }) : rej(new Error(`${cmd} завершился с кодом ${code}\n${err.slice(-3000)}`)));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
const LOSSLESS = new Set(['flac', 'alac', 'wavpack', 'tta', 'ape', 'mlp', 'truehd', 'shorten']);
// PCM-кодек, в котором декодированный звук хэшируется без потерь (зависит от sample_fmt декодера)
function md5Codec(sampleFmt) {
  const f = sampleFmt.replace(/p$/, '');
  return { u8: 'pcm_u8', s16: 'pcm_s16le', s32: 'pcm_s32le', s64: 'pcm_s64le', flt: 'pcm_f32le', dbl: 'pcm_f64le' }[f] || 'pcm_f64le';
}
function pcmFor(stream) {
  const bits = Number(stream.bits_per_raw_sample) || Number(stream.bits_per_sample) || 0;
  const f = (stream.sample_fmt || '').replace(/p$/, '');
  if (f === 'flt') return 'pcm_f32le';
  if (f === 'dbl') return 'pcm_f64le';
  if (f === 's16' || bits === 16) return 'pcm_s16le';
  if (bits && bits <= 24) return 'pcm_s24le';
  return 'pcm_s32le';
}
// Решение по звуку: что делать, в какой контейнер
function audioPlan(info) {
  const s = info.streams.find(x => x.codec_type === 'audio');
  if (!s) die('в аудиофайле нет звуковой дорожки');
  const c = s.codec_name;
  if (c.startsWith('pcm_')) return { stream: s, args: ['-c:a', 'copy'], ext: '.mov', desc: `PCM ${c} копируется как есть` };
  if (LOSSLESS.has(c)) { const pcm = pcmFor(s); return { stream: s, args: ['-c:a', pcm], ext: '.mov', desc: `${c} → ${pcm} (без потерь, та же разрядность и частота)` }; }
  return { stream: s, args: ['-c:a', 'copy'], ext: ['mp3', 'aac'].includes(c) ? '.mp4' : '.mov', desc: `${c} копируется как есть, без перекодирования` };
}
// Декодирует дорожку в PCM и считает md5 потоково. limit: сколько байт хэшировать (остальное только считается)
function pcmHash(file, codec, limit = Infinity) {
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', codec, '-f', codec.slice(4), '-']);
    const h = crypto.createHash('md5'); let n = 0;
    p.stdout.on('data', (d) => { const take = Math.max(0, Math.min(d.length, limit - n)); if (take) h.update(take === d.length ? d : d.subarray(0, take)); n += d.length; });
    let err = ''; p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? res({ md5: h.digest('hex'), bytes: n }) : rej(new Error(err)));
  });
}
// Сравнение звука бит-в-бит: весь исходник должен совпасть с началом дорожки ролика.
// У MP3/AAC в конце может остаться паддинг последнего кадра (его обрезку MOV/MP4 не хранят) — сообщаем отдельно.
async function comparePcm(src, out, codec, stream) {
  const a = await pcmHash(src, codec);
  const b = await pcmHash(out, codec, a.bytes);
  const bps = { pcm_u8: 1, pcm_s16le: 2, pcm_s32le: 4, pcm_s64le: 8, pcm_f32le: 4, pcm_f64le: 8 }[codec] * (stream.channels || 2);
  return { same: a.md5 === b.md5 && b.bytes >= a.bytes, a: a.md5, b: b.md5, extra: (b.bytes - a.bytes) / bps, samples: a.bytes / bps };
}
async function packetMd5(file) {
  const { out } = await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-c:a', 'copy', '-f', 'streamhash', '-hash', 'md5', '-']);
  return out.trim().split(',').pop();
}
async function loudness(file) {
  const { err } = await run('ffmpeg', ['-nostats', '-hide_banner', '-i', file, '-map', '0:a:0', '-filter_complex', 'ebur128=peak=true', '-f', 'null', '-']);
  const sum = err.slice(err.lastIndexOf('Summary:'));
  const I = /I:\s+(-?[\d.]+|-inf) LUFS/.exec(sum)?.[1], TP = /Peak:\s+(-?[\d.]+|-inf) dBFS/.exec(sum)?.[1];
  return { I, TP };
}

// ---------- параметры ----------
let preset = { params: {}, files: {} }, presetDir = process.cwd();
if (args.preset) {
  const pp = path.resolve(args.preset);
  preset = JSON.parse(fs.readFileSync(pp, 'utf8'));
  preset.params ||= {}; preset.files ||= {};
  presetDir = path.dirname(pp);
}
function fileArg(kind) {
  if (typeof args[kind] === 'string') return path.resolve(args[kind]);
  const f = preset.files[kind];
  return f ? path.resolve(presetDir, f) : null;
}
const files = { bg: fileArg('bg'), disk: fileArg('disk'), logo: fileArg('logo'), audio: fileArg('audio') };
for (const [k, f] of Object.entries(files)) if (f && !fs.existsSync(f)) die(`не найден файл ${k}: ${f}`);
if (!files.bg || !files.disk) die('нужны фон (--bg) и картинка диска (--disk), или пресет с полем files');

const params = { ...preset.params };
if (args.fps) params.fps = Number(args.fps);
if (args.res) params.res = { 1080: '1920x1080', 1440: '2560x1440', 2160: '3840x2160', 720: '1280x720' }[args.res] || args.res;
if (args.bitrate) params.bitrate = Number(args.bitrate);

const onlyFrame = args.frame !== undefined && (args.hash || args.png);
let T, audioInfo = null, plan = null;
if (files.audio) {
  audioInfo = ffprobeJSON(files.audio);
  plan = audioPlan(audioInfo);
  T = Number(plan.stream.duration) || Number(audioInfo.format.duration);
  if (!(T > 0)) die('не удалось узнать длительность аудио');
} else {
  T = Number(args.duration) || (params.durMin ? params.durMin * 60 : 0);
  if (!(T > 0)) die('нет аудио: укажи --duration СЕК');
}

// ---------- локальный сервер: index.html, ассеты и приёмник потока ----------
let sink = null; // { write(buf) → Promise }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/__sink') {
    if (!sink || sink.failed) { req.resume(); res.writeHead(sink ? 500 : 409); res.end(); return; }
    req.on('data', (d) => { if (!sink.stream.write(d)) { req.pause(); sink.stream.once('drain', () => req.resume()); } });
    req.on('end', () => { res.writeHead(204); res.end(); });
    return;
  }
  let file;
  if (url.pathname.startsWith('/__asset/')) file = files[url.pathname.slice(9)];
  else if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(HERE, 'index.html');
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- браузер ----------
const browserName = args.browser || (process.platform === 'darwin' ? 'chrome' : 'chromium');
let browser;
try {
  browser = await chromium.launch({
    channel: browserName, headless: !args.headed,
    args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  });
} catch (e) {
  die(`не запустился браузер «${browserName}»: ${e.message.split('\n')[0]}\nНа маке нужен установленный Google Chrome (или --browser chromium после «npx playwright install chromium»).`);
}
const cleanup = async () => { try { await browser.close(); } catch { } server.close(); };
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const page = await browser.newPage();
let pageError = null;
page.on('pageerror', e => { pageError = e; console.error('[страница]', e.message); });
page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) console.error('[страница]', m.text()); });
await page.goto(`${base}/index.html?render=1`);
if (pageError || !(await page.evaluate(() => !!window.VS))) { await cleanup(); die('index.html не запустился: ' + (pageError?.message || 'нет window.VS')); }
const gpu = await page.evaluate(() => VS.gpu());
await page.evaluate(async ({ params, T, has }) => {
  VS.setParams(params);
  VS.setDuration(T);
  for (const k of ['bg', 'disk', 'logo']) await VS.loadImage(k, has[k] ? `/__asset/${k}` : null, k);
}, { params, T, has: { bg: !!files.bg, disk: !!files.disk, logo: !!files.logo } });
const P = await page.evaluate(() => VS.getParams());
const [W, H] = P.res.split('x').map(Number);
const fps = P.fps;
const totalFrames = Math.ceil(T * fps - 1e-9);

log(`vinyl-spin render`);
log(`  GPU браузера: ${gpu}${/SwiftShader|llvmpipe|Software/i.test(gpu) ? '  ← программный рендер, будет медленно' : ''}`);
log(`  ${W}×${H}, ${fps} fps, длительность ${T.toFixed(3)} с = ${totalFrames} кадров`);

// ---------- один кадр: хэш или PNG ----------
if (onlyFrame) {
  const n = Number(args.frame);
  if (args.hash) log(`  кадр ${n}: sha256 ${await page.evaluate(n => VS.hashFrame(n), n)}`);
  if (args.png) {
    const bytes = await page.evaluate(async n => Array.from(await VS.pngFrame(n)), n);
    const out = typeof args.png === 'string' ? path.resolve(args.png) : path.resolve(`frame-${n}.png`);
    fs.writeFileSync(out, Buffer.from(bytes)); log(`  PNG: ${out}`);
  }
  await cleanup(); process.exit(0);
}

// ---------- диапазон кадров ----------
let fromSec = args.from !== undefined ? Number(args.from) : 0;
if (fromSec < 0) fromSec = Math.max(0, T + fromSec);
const startFrame = Math.min(totalFrames - 1, Math.round(fromSec * fps));
const count = args.limit ? Math.min(Math.ceil(Number(args.limit) * fps), totalFrames - startFrame) : totalFrames - startFrame;
const partial = startFrame > 0 || count < totalFrames;

// ---------- выбор кодировщика ----------
const bitrate = Math.round((P.bitrate || 25) * 1e6);
const gop = Math.max(1, Math.round((P.gopSec || 0.5) * fps));
let encoder = args.encoder || 'auto', wcCodec = null, wcHw = null;
const vp9 = args.codec === 'vp9';
if (encoder === 'auto' || encoder === 'webcodecs') {
  const sup = vp9
    ? await page.evaluate(async c => { try { return { supported: (await VideoEncoder.isConfigSupported(c)).supported, codec: c.codec }; } catch (e) { return { supported: false, reason: e.message }; } }, { codec: 'vp09.00.41.08', width: W, height: H, bitrate, framerate: fps })
    : await page.evaluate(a => VS.h264Support(...a), [W, H, fps, bitrate]);
  if (sup.supported) { encoder = 'webcodecs'; wcCodec = sup.codec; wcHw = sup.hardwareAcceleration; }
  else if (encoder === 'webcodecs') die(`WebCodecs не умеет ${vp9 ? 'VP9' : 'H.264'} в этом браузере (${sup.reason}). Попробуй --encoder videotoolbox или x264.`);
  else encoder = process.platform === 'darwin' ? 'videotoolbox' : 'x264';
}
if (!['webcodecs', 'videotoolbox', 'x264'].includes(encoder)) die(`неизвестный --encoder ${encoder}`);

// ---------- выходной файл ----------
const ext = vp9 ? '.mkv' : (plan ? plan.ext : '.mp4');
let out = args.out ? path.resolve(args.out) : path.join(files.audio ? path.dirname(files.audio) : process.cwd(), `${path.parse(files.audio || files.disk).name}.vinyl${partial ? `.${startFrame}-${startFrame + count}` : ''}${ext}`);
if (plan && ext === '.mov' && !/\.mov$/i.test(out)) { out = out.replace(/\.[^./\\]+$/, '') + '.mov'; log(`  звук PCM: контейнер .mov (в .mp4 PCM не везде читается) → ${out}`); }
if (vp9 && !/\.mkv$/i.test(out)) out = out.replace(/\.[^./\\]+$/, '') + '.mkv';
fs.mkdirSync(path.dirname(out), { recursive: true });

// ---------- ffmpeg ----------
const color = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const ff = ['-hide_banner', '-v', 'warning', '-stats_period', '5', '-y'];
if (encoder === 'webcodecs') {
  if (vp9) ff.push('-f', 'ivf', '-i', 'pipe:0');
  else ff.push('-fflags', '+genpts', '-f', 'h264', '-framerate', String(fps), '-i', 'pipe:0');
} else {
  ff.push('-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-framerate', String(fps), ...color, '-i', 'pipe:0');
}
if (files.audio) {
  if (partial) ff.push('-ss', (startFrame / fps).toFixed(6), '-t', (count / fps).toFixed(6));
  ff.push('-i', files.audio);
}
ff.push('-map', '0:v:0');
if (files.audio) ff.push('-map', '1:a:0');
if (encoder === 'webcodecs') {
  ff.push('-c:v', 'copy');
  if (!vp9) ff.push('-bsf:v', 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0');
} else if (encoder === 'videotoolbox') {
  ff.push('-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', String(bitrate), '-g', String(gop), ...color);
} else {
  const lossless = args.crf !== undefined && Number(args.crf) === 0; // lossless бывает только в High 4:4:4
  ff.push('-c:v', 'libx264', '-preset', args['x264-preset'] || 'medium', ...(lossless ? [] : ['-profile:v', 'high']), '-pix_fmt', 'yuv420p', '-g', String(gop), '-bf', '2', ...color);
  if (args.crf) ff.push('-crf', String(args.crf));
  else ff.push('-b:v', String(bitrate), '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2));
}
if (files.audio) ff.push(...plan.args);
ff.push('-r', String(fps), out);

log(`  кодировщик: ${encoder === 'webcodecs' ? `WebCodecs ${wcCodec}${wcHw === 'prefer-hardware' ? ' (аппаратно)' : ''} → ffmpeg без перекодирования` : encoder === 'videotoolbox' ? 'сырые кадры → ffmpeg h264_videotoolbox' : 'сырые кадры → ffmpeg libx264'}`);
log(`  видео: ${args.crf && encoder === 'x264' ? `CRF ${args.crf}` : `${(bitrate / 1e6).toFixed(0)} Мбит/с`}, ключевой кадр каждые ${gop} кадров`);
log(`  звук: ${files.audio ? `${path.basename(files.audio)}: ${plan.desc}` : 'нет'}`);
log(`  кадры ${startFrame}…${startFrame + count - 1}${partial ? ' (часть ролика)' : ''}`);
log(`  → ${out}`);

const ffp = spawn('ffmpeg', ff, { stdio: ['pipe', 'inherit', 'pipe'] });
let ffErr = '';
ffp.stderr.on('data', d => { ffErr += d; if (ffErr.length > 1e5) ffErr = ffErr.slice(-5e4); });
const ffDone = new Promise((res, rej) => ffp.on('close', code => { if (sink) sink.failed = code !== 0; code === 0 ? res() : rej(new Error(`ffmpeg завершился с кодом ${code}\n${ffErr.slice(-3000)}`)); }));
ffDone.catch(() => { }); // ошибку покажем ниже, когда дождёмся ffmpeg
ffp.stdin.on('error', () => { }); // если ffmpeg упал, ошибку покажет ffDone
sink = { stream: ffp.stdin };

const t0 = Date.now();
await page.exposeFunction('__vsProgress', ({ done, total, sec, bytes }) => {
  const rate = done / sec, eta = (total - done) / rate;
  const m = Math.floor(eta / 60), s = Math.round(eta % 60);
  process.stdout.write(`\r  ${(100 * done / total).toFixed(1).padStart(5)} %  ${done}/${total} кадров  ${rate.toFixed(1)} кадр/с (×${(rate / fps).toFixed(2)} реального времени)  осталось ≈ ${m} мин ${s} с   `);
});
let stats;
try {
  stats = await page.evaluate(o => VS.exportRun(o), {
    mode: encoder === 'webcodecs' ? 'webcodecs' : 'raw', codec: wcCodec, hardwareAcceleration: wcHw,
    bitrate, gop, start: startFrame, count, sinkUrl: `${base}/__sink`,
  });
} catch (e) {
  ffp.stdin.destroy(); let ffMsg = '';
  await ffDone.catch(err => { ffMsg = '\n' + err.message; });
  await cleanup(); die(e.message + ffMsg);
}
ffp.stdin.end();
try { await ffDone; } catch (e) { await cleanup(); die(e.message); }
await cleanup();
const wall = (Date.now() - t0) / 1000;
process.stdout.write('\n');

// ---------- проверки ----------
const size = fs.statSync(out).size;
const probe = ffprobeJSON(out, ['-count_packets']);
const vs = probe.streams.find(s => s.codec_type === 'video');
const as = probe.streams.find(s => s.codec_type === 'audio');
const outDur = Number(probe.format.duration);
log(`Готово за ${(wall / 60).toFixed(1)} мин: ${count} кадров, ${(count / wall).toFixed(1)} кадр/с, ×${(count / wall / fps).toFixed(2)} реального времени`);
log(`  файл: ${(size / 1e6).toFixed(1)} МБ, ≈ ${(size / 1e6 / (count / fps / 60)).toFixed(0)} МБ на минуту, ${vs.codec_name} ${vs.profile || ''} ${vs.width}×${vs.height} ${vs.pix_fmt}, кадров ${vs.nb_read_packets}${Number(vs.nb_read_packets) === count ? ' ✓' : ` ✗ (ждали ${count})`}`);
if (as) log(`  звук в файле: ${as.codec_name}, ${as.sample_rate} Гц, ${as.channels} кан., ${as.bits_per_raw_sample || as.bits_per_sample || '?'} бит`);
log(`  длительность файла ${outDur.toFixed(3)} с, аудио-исходник ${files.audio ? T.toFixed(3) + ' с' : '—'}`);

if (files.audio && !partial && !args['no-verify']) {
  const codec = md5Codec(plan.stream.sample_fmt);
  const r = await comparePcm(files.audio, out, codec, plan.stream);
  const same = r.same && (r.extra === 0 || !plan.stream.codec_name.startsWith('pcm_'));
  const sr = Number(plan.stream.sample_rate);
  log(`  звук бит-в-бит (md5 декодированного ${codec}, ${r.samples} сэмплов): ${same ? '✓ совпадает' : '✗ НЕ совпадает'}\n    исходник ${r.a}\n    ролик    ${r.b}`);
  if (r.extra > 0) log(`    в конце дорожки ещё ${r.extra} сэмплов (${(1000 * r.extra / sr).toFixed(1)} мс): паддинг последнего кадра ${plan.stream.codec_name}, контейнер не хранит его обрезку. Сам звук не изменён.`);
  if (plan.args[1] === 'copy' && !plan.stream.codec_name.startsWith('pcm_')) {
    const [pa, pb] = await Promise.all([packetMd5(files.audio), packetMd5(out)]);
    log(`  пакеты ${plan.stream.codec_name} (md5 сжатых данных): ${pa === pb ? '✓ совпадают' : '✗ различаются'}`);
  }
  try { const l = await loudness(files.audio); log(`  громкость исходника: ${l.I} LUFS, true peak ${l.TP} dBTP (для справки, звук не трогаем)`); } catch { }
  if (!same) process.exitCode = 2;
}

#!/usr/bin/env node
// vinyl-spin: рендер ролика во всю длину аудио.
// Кадры рисует тот же index.html (WebGL2, seek(t)), что и превью. Видео кодирует браузер
// через WebCodecs (H.264, на маке аппаратно) или ffmpeg из сырых yuv420p-кадров (запасной путь).
// Звук не перекодируется с потерями: PCM остаётся PCM, MP3/AAC копируются как есть.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audioPlan, ffmpegArgs, startFfmpeg, verifyOutput } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `
vinyl-spin render: ролик «вращающаяся пластинка» во всю длину аудио
Логотип по умолчанию стандартный (вшит в index.html); --logo файл.png — свой, --logo "" — без логотипа.

  node render.mjs --preset preset.json [--bg фон.jpg --disk диск.png --logo лого.png --audio микс.wav] [--out ролик.mov]

Файлы из пресета («files») ищутся рядом с пресетом; флаги их перекрывают.

  --out ПУТЬ          итоговый файл (по умолчанию рядом с аудио; .mov для PCM, .mp4 для MP3/AAC)
  --fps 24|25|30|50|60  частота кадров (иначе из пресета, по умолчанию 25)
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

// ---------- параметры ----------
let preset = { params: {}, files: {} }, presetDir = process.cwd();
if (args.preset) {
  const pp = path.resolve(args.preset);
  preset = JSON.parse(fs.readFileSync(pp, 'utf8'));
  preset.params ||= {}; preset.files ||= {};
  presetDir = path.dirname(pp);
}
function fileArg(kind) {
  if (kind === 'logo' && typeof args.logo !== 'string' && (preset.params.logoMode || 'default') !== 'file') return null; // стандартный или без логотипа
  if (args[kind] === '') return null; // --audio "" — без звука, даже если он есть в пресете
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
// логотип: --logo файл (свой), --logo "" (без логотипа); иначе как в пресете, по умолчанию стандартный вшитый
if (typeof args.logo === 'string') params.logoMode = args.logo === '' ? 'none' : 'file';
else if (params.logoMode === 'file' && !files.logo) params.logoMode = 'default';

const onlyFrame = args.frame !== undefined && (args.hash || args.png);
let T, plan = null;
if (files.audio) {
  try { plan = audioPlan(files.audio); } catch (e) { die(e.message); }
  T = plan.T;
} else {
  T = Number(args.duration) || (params.durMin ? params.durMin * 60 : 0);
  if (!(T > 0)) die('нет аудио: укажи --duration СЕК');
}

// ---------- локальный сервер: index.html, ассеты и приёмник потока ----------
let sink = null; // задание ffmpeg из lib.mjs
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/__sink') {
    if (!sink || sink.failed) { req.resume(); res.writeHead(sink ? 500 : 409); res.end(); return; }
    sink.pipeRequest(req).then(() => { res.writeHead(204); res.end(); });
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
await page.evaluate(() => VS.ready);
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
    const b64 = await page.evaluate(n => VS.pngFrame(n), n);
    const out = typeof args.png === 'string' ? path.resolve(args.png) : path.resolve(`frame-${n}.png`);
    fs.writeFileSync(out, Buffer.from(b64, 'base64')); log(`  PNG: ${out}`);
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
const ff = ffmpegArgs({ encoder, vp9, W, H, fps, bitrate, gop, crf: args.crf, x264Preset: args['x264-preset'], audio: files.audio, plan, startFrame, count, partial, out });
log(`  кодировщик: ${encoder === 'webcodecs' ? `WebCodecs ${wcCodec}${wcHw === 'prefer-hardware' ? ' (аппаратно)' : ''} → ffmpeg без перекодирования` : encoder === 'videotoolbox' ? 'сырые кадры → ffmpeg h264_videotoolbox' : 'сырые кадры → ffmpeg libx264'}`);
log(`  видео: ${args.crf && encoder === 'x264' ? `CRF ${args.crf}` : `${(bitrate / 1e6).toFixed(0)} Мбит/с`}, ключевой кадр каждые ${gop} кадров`);
log(`  звук: ${files.audio ? `${path.basename(files.audio)}: ${plan.desc}` : 'нет'}`);
log(`  кадры ${startFrame}…${startFrame + count - 1}${partial ? ' (часть ролика)' : ''}`);
log(`  → ${out}`);

const job = startFfmpeg(ff);
sink = job;

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
  job.kill(); let ffMsg = '';
  await job.done.catch(err => { if (!/SIGKILL|null/.test(err.message)) ffMsg = '\n' + err.message; });
  await cleanup(); die(e.message + ffMsg);
}
job.end();
try { await job.done; } catch (e) { await cleanup(); die(e.message); }
await cleanup();
const wall = (Date.now() - t0) / 1000;
process.stdout.write('\n');

// ---------- проверки ----------
const report = await verifyOutput({ out, count, fps, audio: args['no-verify'] ? null : files.audio, plan, partial, T, wall });
for (const l of report.lines) log(l);
if (!report.ok) process.exitCode = 2;

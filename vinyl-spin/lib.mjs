// Общая часть render.mjs и studio.mjs: ffmpeg/ffprobe, решение по звуку, сборка ролика и проверки.
// Только встроенные модули Node, без зависимостей.
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

export function ffprobeJSON(file, extra = []) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', ...extra, file], { maxBuffer: 64 << 20 });
  return JSON.parse(out.toString());
}
export function run(cmd, argv) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
    p.on('error', rej);
    p.on('close', code => code === 0 ? res({ out, err }) : rej(new Error(`${cmd} завершился с кодом ${code}\n${err.slice(-3000)}`)));
  });
}
export function ffmpegVersion() {
  try { return execFileSync('ffmpeg', ['-version']).toString().split('\n')[0]; } catch { return null; }
}

const LOSSLESS = new Set(['flac', 'alac', 'wavpack', 'tta', 'ape', 'mlp', 'truehd', 'shorten']);
// PCM-кодек, в котором декодированный звук хэшируется без потерь (зависит от sample_fmt декодера)
export function md5Codec(sampleFmt) {
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
// Решение по звуку: что делать и в какой контейнер. Потерь нет ни в одной ветке.
export function audioPlan(file) {
  const info = ffprobeJSON(file);
  const s = info.streams.find(x => x.codec_type === 'audio');
  if (!s) throw new Error('в аудиофайле нет звуковой дорожки');
  const T = Number(s.duration) || Number(info.format.duration);
  if (!(T > 0)) throw new Error('не удалось узнать длительность аудио');
  const c = s.codec_name, base = { stream: s, T };
  if (c.startsWith('pcm_')) return { ...base, args: ['-c:a', 'copy'], ext: '.mov', desc: `PCM ${c} копируется как есть` };
  if (LOSSLESS.has(c)) { const pcm = pcmFor(s); return { ...base, args: ['-c:a', pcm], ext: '.mov', desc: `${c} → ${pcm} (без потерь, та же разрядность и частота)` }; }
  return { ...base, args: ['-c:a', 'copy'], ext: ['mp3', 'aac'].includes(c) ? '.mp4' : '.mov', desc: `${c} копируется как есть, без перекодирования` };
}

// Аргументы ffmpeg: видео приходит на stdin (H.264 annexb / IVF от WebCodecs или сырой yuv420p), звук из файла.
// o: { encoder: 'webcodecs'|'videotoolbox'|'x264', vp9, W, H, fps, bitrate, gop, crf, x264Preset, audio, plan, startFrame, count, partial, out }
export function ffmpegArgs(o) {
  const color = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
  const ff = ['-hide_banner', '-nostats', '-v', 'warning', '-y'];
  if (o.encoder === 'webcodecs') {
    if (o.vp9) ff.push('-f', 'ivf', '-i', 'pipe:0');
    else ff.push('-thread_queue_size', '256', '-f', 'h264', '-framerate', String(o.fps), '-i', 'pipe:0');
  } else {
    ff.push('-thread_queue_size', '256', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${o.W}x${o.H}`, '-framerate', String(o.fps), ...color, '-i', 'pipe:0');
  }
  if (o.audio) {
    if (o.partial) ff.push('-ss', (o.startFrame / o.fps).toFixed(6), '-t', (o.count / o.fps).toFixed(6));
    ff.push('-i', o.audio);
  }
  ff.push('-map', '0:v:0');
  if (o.audio) ff.push('-map', '1:a:0');
  if (o.encoder === 'webcodecs') {
    ff.push('-c:v', 'copy');
    // в сыром H.264 нет меток времени: ставим pts = dts = номер кадра (B-кадров нет, это проверяет браузер),
    // и помечаем поток как BT.709 с ограниченным диапазоном — именно так кадры упакованы в I420
    if (!o.vp9) ff.push('-bsf:v', `setts=ts=N:duration=1:time_base=1/${o.fps},h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`, '-video_track_timescale', String(o.fps * 1000));
  } else if (o.encoder === 'videotoolbox') {
    ff.push('-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', String(o.bitrate), '-g', String(o.gop), ...color);
  } else {
    const lossless = o.crf !== undefined && Number(o.crf) === 0; // lossless бывает только в High 4:4:4
    ff.push('-c:v', 'libx264', '-preset', o.x264Preset || 'medium', ...(lossless ? [] : ['-profile:v', 'high']), '-pix_fmt', 'yuv420p', '-g', String(o.gop), '-bf', '2', ...color);
    if (o.crf !== undefined) ff.push('-crf', String(o.crf));
    else ff.push('-b:v', String(o.bitrate), '-maxrate', String(Math.round(o.bitrate * 1.5)), '-bufsize', String(o.bitrate * 2));
  }
  if (o.audio) ff.push(...o.plan.args);
  ff.push(o.out);
  return ff;
}

// Запуск ffmpeg с приёмом видео на stdin. write() соблюдает backpressure.
export function startFfmpeg(argv) {
  const p = spawn('ffmpeg', argv, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err += d; if (err.length > 1e5) err = err.slice(-5e4); });
  const job = { failed: false, proc: p };
  job.done = new Promise((res, rej) => {
    p.on('error', e => { job.failed = true; rej(e); });
    p.on('close', code => { job.failed = code !== 0; code === 0 ? res() : rej(new Error(`ffmpeg завершился с кодом ${code}\n${err.slice(-3000)}`)); });
  });
  job.done.catch(() => { });
  p.stdin.on('error', () => { }); // если ffmpeg упал, ошибку покажет done
  // принимает поток HTTP-запроса целиком, с учётом backpressure
  job.pipeRequest = (req) => new Promise((res) => {
    req.on('data', (d) => { if (!p.stdin.write(d)) { req.pause(); p.stdin.once('drain', () => req.resume()); } });
    req.on('end', res);
  });
  job.end = () => p.stdin.end();
  job.kill = () => { p.stdin.destroy(); p.kill('SIGKILL'); };
  return job;
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

// Проверка готового файла: число кадров, звук бит-в-бит (весь исходник совпадает с началом дорожки ролика;
// у MP3/AAC в конце может остаться паддинг последнего кадра — его обрезку MOV/MP4 не хранят).
// Возвращает { ok, lines } — строки отчёта по-русски.
export async function verifyOutput({ out, count, fps, audio, plan, partial, T, wall }) {
  const lines = [];
  let ok = true;
  const size = fs.statSync(out).size;
  const probe = ffprobeJSON(out, ['-count_packets']);
  const vs = probe.streams.find(s => s.codec_type === 'video');
  const as = probe.streams.find(s => s.codec_type === 'audio');
  if (wall) lines.push(`Готово за ${(wall / 60).toFixed(1)} мин: ${count} кадров, ${(count / wall).toFixed(1)} кадр/с, ×${(count / wall / fps).toFixed(2)} реального времени`);
  const framesOk = Number(vs.nb_read_packets) === count; ok &&= framesOk;
  lines.push(`  файл: ${(size / 1e6).toFixed(1)} МБ, ≈ ${(size / 1e6 / (count / fps / 60)).toFixed(0)} МБ на минуту, ${vs.codec_name} ${vs.profile || ''} ${vs.width}×${vs.height} ${vs.pix_fmt}, кадров ${vs.nb_read_packets}${framesOk ? ' ✓' : ` ✗ (ждали ${count})`}`);
  if (as) lines.push(`  звук в файле: ${as.codec_name}, ${as.sample_rate} Гц, ${as.channels} кан., ${as.bits_per_raw_sample || as.bits_per_sample || '?'} бит`);
  lines.push(`  длительность файла ${Number(probe.format.duration).toFixed(3)} с, аудио-исходник ${audio ? T.toFixed(3) + ' с' : '—'}`);
  if (audio && !partial) {
    const codec = md5Codec(plan.stream.sample_fmt);
    const a = await pcmHash(audio, codec);
    const b = await pcmHash(out, codec, a.bytes);
    const bps = { pcm_u8: 1, pcm_s16le: 2, pcm_s32le: 4, pcm_s64le: 8, pcm_f32le: 4, pcm_f64le: 8 }[codec] * (plan.stream.channels || 2);
    const extra = (b.bytes - a.bytes) / bps, isPcm = plan.stream.codec_name.startsWith('pcm_');
    const same = a.md5 === b.md5 && b.bytes >= a.bytes && (extra === 0 || !isPcm);
    ok &&= same;
    lines.push(`  звук бит-в-бит (md5 декодированного ${codec}, ${a.bytes / bps} сэмплов): ${same ? '✓ совпадает' : '✗ НЕ совпадает'}`, `    исходник ${a.md5}`, `    ролик    ${b.md5}`);
    if (extra > 0) lines.push(`    в конце дорожки ещё ${extra} сэмплов (${(1000 * extra / Number(plan.stream.sample_rate)).toFixed(1)} мс): паддинг последнего кадра ${plan.stream.codec_name}, контейнер не хранит его обрезку. Сам звук не изменён.`);
    if (plan.args[1] === 'copy' && !isPcm) {
      const [pa, pb] = await Promise.all([packetMd5(audio), packetMd5(out)]);
      ok &&= pa === pb;
      lines.push(`  пакеты ${plan.stream.codec_name} (md5 сжатых данных): ${pa === pb ? '✓ совпадают' : '✗ различаются'}`);
    }
    try { const l = await loudness(audio); lines.push(`  громкость исходника: ${l.I} LUFS, true peak ${l.TP} dBTP (для справки, звук не трогаем)`); } catch { }
  } else if (audio) lines.push('  звук: часть ролика, проверка бит-в-бит только для полного рендера');
  return { ok, lines, size };
}

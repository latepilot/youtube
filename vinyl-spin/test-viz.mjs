#!/usr/bin/env node
// Проверки визуализатора (viz.html):
//   node test-viz.mjs            всё
//   node test-viz.mjs analysis   точность анализа на эталонном даб-техно треке
//   node test-viz.mjs hash       детерминизм кадра (два запуска браузера)
//   node test-viz.mjs frames     кадры по секциям в out/test/viz-*.png (для глаз)
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'out', 'test');
const what = process.argv[2] || 'all';
const browserName = process.env.VS_BROWSER || (process.platform === 'darwin' ? 'chrome' : 'chromium');
fs.mkdirSync(DIR, { recursive: true });
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) failed++; };

// VIZ_VARIANT="--bpm 118.5 --swing 18 --soft --bass --clap" — тот же тест на трудном варианте трека
const VARIANT = (process.env.VIZ_VARIANT || '').trim();
const trackName = VARIANT ? 'dub-' + VARIANT.replace(/[^a-z0-9.]+/gi, '_').replace(/^_|_$/g, '') : 'dub';
const track = path.join(DIR, trackName + '.wav'), truthFile = path.join(DIR, trackName + '.truth.json');
if (!fs.existsSync(track)) execFileSync('node', [path.join(HERE, 'tools', 'dubtechno-track.mjs'), track, ...(VARIANT ? VARIANT.split(/\s+/) : [])], { stdio: 'inherit' });
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));

// маленький сервер: страницы проекта и файлы из out/test
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = u.startsWith('/out/') ? path.join(HERE, u) : path.join(HERE, path.basename(u));
  if (!f.startsWith(HERE) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function openPage(browser, query = '?render=1') {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${base}/viz.html${query}`);
  if (errors.length) throw new Error('viz.html: ' + errors.join('\n'));
  await page.evaluate(() => VZ.ready);
  return { page, errors };
}
async function analyze(page) {
  return page.evaluate(async (url) => { const buf = await (await fetch(url)).arrayBuffer(); const t0 = performance.now(); const map = await VZ.analyzeBuffer(buf); return { map, ms: performance.now() - t0 }; }, `/out/test/${trackName}.wav`);
}

// сопоставление событий с эталоном в окне ±tol
function match(found, ref, tol) {
  const used = new Set(); let hit = 0; const offs = [];
  for (const t of ref) {
    let best = -1, bd = tol;
    found.forEach((f, i) => { const d = Math.abs(f - t); if (d <= bd && !used.has(i)) { bd = d; best = i; } });
    if (best >= 0) { used.add(best); hit++; offs.push(found[best] - t); }
  }
  const mean = offs.length ? offs.reduce((a, b) => a + b, 0) / offs.length : 0;
  return { recall: hit / ref.length, precision: found.length ? hit / found.length : 0, hit, n: ref.length, found: found.length, meanMs: mean * 1000, maxMs: offs.length ? Math.max(...offs.map(Math.abs)) * 1000 : 0 };
}

async function testAnalysis() {
  const browser = await chromium.launch({ channel: browserName });
  const { page } = await openPage(browser);
  const { map, ms } = await analyze(page);
  fs.writeFileSync(path.join(DIR, trackName + '.map.json'), JSON.stringify(map));
  console.log(`анализ ${(ms / 1000).toFixed(2)} с на ${truth.duration.toFixed(0)} с трека`);
  ok(Math.abs(map.bpm - truth.bpm) < 0.05, `темп ${map.bpm} BPM (эталон ${truth.bpm}), уверенность ${map.gridConf}`);
  const beatErr = (() => { const k = Math.round((truth.beat0 - map.beat0) / map.beatLen); return (map.beat0 + k * map.beatLen - truth.beat0) * 1000; })();
  ok(Math.abs(beatErr) < 15, `фаза сетки: ошибка ${beatErr.toFixed(1)} мс`);
  const k = match(map.kicks.map(e => e[0]), truth.kicks, 0.03);
  ok(k.recall > 0.97 && k.precision > 0.95 && Math.abs(k.meanMs) < 10, `кики: найдено ${k.hit}/${k.n}, лишних ${k.found - k.hit}, смещение ${k.meanMs.toFixed(1)} мс (макс ${k.maxMs.toFixed(0)})`);
  const h = match(map.hats.map(e => e[0]), truth.hats, 0.03);
  ok(h.recall > 0.9 && Math.abs(h.meanMs) < 10, `хэты (основные): найдено ${h.hit}/${h.n}, всего событий ${h.found} (с тихими 16-ми), смещение ${h.meanMs.toFixed(1)} мс`);
  const onKick = map.hats.filter(e => e[1] >= 0.3 && truth.kicks.some(t => Math.abs(t - e[0]) < 0.015)).length;
  if (!/clap/.test(VARIANT)) ok(onKick < truth.kicks.length * 0.05, `щелчки кика не считаются хэтами: заметных «хэтов» на месте киков ${onKick} из ${truth.kicks.length}`);
  const s = match(map.stabs.map(e => e[0]), truth.stabs, 0.03);
  ok(s.recall > 0.9 && Math.abs(s.meanMs) < 12, `аккорды: найдено ${s.hit}/${s.n}, всего событий ${s.found} (вместе с эхо), смещение ${s.meanMs.toFixed(1)} мс`);
  // у эха сила должна убывать: оригинал сильнее следующего удара в цепочке
  const strengths = truth.stabs.map(t => { const i = map.stabs.findIndex(e => Math.abs(e[0] - t) < 0.03); const j = map.stabs.findIndex(e => Math.abs(e[0] - (t + 0.75 * 60 / truth.bpm)) < 0.03); return i >= 0 && j >= 0 ? [map.stabs[i][1], map.stabs[j][1]] : null; }).filter(Boolean);
  const weaker = strengths.filter(([a, b]) => b < a).length;
  ok(strengths.length && weaker / strengths.length > 0.8, `эхо слабее аккорда в ${weaker} из ${strengths.length} цепочек`);
  ok(map.barPhase === 0 || Math.abs(((map.barPhase - 0) % 4)) === 0, `первая доля такта: фаза ${map.barPhase} (эталон 0)`);
  // секции
  const bar = 4 * 60 / truth.bpm;
  const secStr = (arr) => arr.map(x => `${x.type}@${x.t.toFixed(1)}`).join(' ');
  console.log('  секции найдены: ' + secStr(map.sections) + '\n  секции эталон:  ' + secStr(truth.sections));
  const bm = truth.sections.slice(1).map(ts => map.sections.some(x => Math.abs(x.t - ts.t) < bar * 0.6));
  ok(bm.every(Boolean) && map.sections.length === truth.sections.length, `границы секций: ${bm.filter(Boolean).length}/${bm.length} в пределах такта, всего секций ${map.sections.length} (эталон ${truth.sections.length})`);
  const types = map.sections.map(x => x.type).join(','), ttypes = truth.sections.map(x => x.type).join(',');
  ok(types === ttypes, `типы секций: ${types}`);
  const drops = map.sections.filter(x => x.trans === 'drop').map(x => x.t.toFixed(1)).join(', ');
  ok(map.sections.filter(x => x.trans === 'drop').length === 2, `дропы (кик возвращается): ${drops}`);
  await browser.close();
}

async function loadMapped(browser, params = {}) {
  const { page } = await openPage(browser);
  const map = JSON.parse(fs.readFileSync(path.join(DIR, trackName + '.map.json'), 'utf8'));
  await page.evaluate(({ map, params }) => { VZ.setMap(map); VZ.setTitle('dub.wav'); VZ.setParams(params); }, { map, params });
  return page;
}
async function testHash() {
  const n = 2000; // грув после первого дропа
  const h = [];
  for (let k = 0; k < 2; k++) {
    const browser = await chromium.launch({ channel: browserName });
    const page = await loadMapped(browser, { res: '1280x720' });
    h.push(await page.evaluate(n => VZ.hashFrame(n), n));
    if (k === 0) h.push(await page.evaluate(n => VZ.hashFrame(n + 1), n));
    await browser.close();
  }
  ok(h[0] === h[2], `детерминизм: кадр ${n} в двух запусках, sha256 ${h[0].slice(0, 16)}… ${h[0] === h[2] ? '=' : '≠'} ${h[2].slice(0, 16)}…`);
  ok(h[0] !== h[1], 'соседний кадр отличается');
}
async function testFrames() {
  const browser = await chromium.launch({ channel: browserName });
  const page = await loadMapped(browser, { res: process.env.VIZ_RES || '1280x720' });
  const map = JSON.parse(fs.readFileSync(path.join(DIR, trackName + '.map.json'), 'utf8'));
  const beat = map.beatLen, picks = [];
  for (const s of map.sections) picks.push([`${s.type}-${s.t.toFixed(0)}`, s.t + 4 * 4 * beat + 0.02]);
  const drop = map.sections.find(s => s.trans === 'drop');
  if (drop) { picks.push(['drop-flash', drop.t + 0.08]); picks.push(['pre-drop', drop.t - 2 * beat]); }
  const stab = map.stabs.find(e => e[0] > (drop ? drop.t + 8 : 20)); if (stab) picks.push(['stab', stab[0] + 0.12]);
  for (const [name, t] of picks) {
    const info = await page.evaluate(t => VZ.seek(t), t);
    const b64 = await page.evaluate(() => document.getElementById('cv').toDataURL('image/png').split(',')[1]);
    const f = path.join(DIR, `viz-${name}.png`); fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    console.log(`  ${f}  t=${t.toFixed(2)}  ${JSON.stringify(info)}`);
  }
  await browser.close();
}

// полный путь как у пользователя: studio.mjs → viz.html → трек → анализ → «Рендер ролика» (20 с) → файл
async function testStudio() {
  const { spawn } = await import('node:child_process');
  const outDir = path.join(DIR, 'studio-out'); fs.rmSync(outDir, { recursive: true, force: true });
  const port = 8600 + Math.floor(Math.random() * 200);
  const st = spawn('node', [path.join(HERE, 'studio.mjs'), '--no-open'], { env: { ...process.env, VS_OUT: outDir, VS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; st.stdout.on('data', d => log += d); st.stderr.on('data', d => log += d);
  await new Promise(r => { const iv = setInterval(() => { if (/работает: (http\S+)/.test(log)) { clearInterval(iv); r(); } }, 100); });
  const url = /работает: (http\S+)/.exec(log)[1];
  const browser = await chromium.launch({ channel: browserName });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
    const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(url + 'viz.html');
    await page.evaluate(() => VZ.setParams({ res: '1280x720' }));
    await page.setInputFiles('.drop[data-kind=audio] input', track);
    await page.waitForFunction(() => /Готово/.test(document.getElementById('anStatus').textContent), null, { timeout: 120000 });
    console.log('  ' + (await page.textContent('#anStatus')).replace(/\n/g, ' '));
    await page.screenshot({ path: path.join(DIR, 'viz-ui.png') });
    await page.selectOption('#rRange', 'head');
    await page.click('#bRender');
    await page.waitForFunction(() => !document.getElementById('rReport').hidden || /Ошибка/.test(document.getElementById('rStatus').textContent), null, { timeout: 900000 });
    const status = await page.textContent('#rStatus'), report = await page.textContent('#rReport');
    console.log(report.split('\n').map(l => '  ' + l).join('\n'));
    ok(/Готово/.test(status) && /кадров 500 ✓/.test(report), `рендер через студию: ${status}`);
    ok(!errs.length, 'без ошибок на странице' + (errs.length ? ': ' + errs.join('; ') : ''));
  } finally { await browser.close(); st.kill(); }
}

try {
  if (what === 'studio') await testStudio();
  if (what === 'all' || what === 'analysis') await testAnalysis();
  if (what === 'all' || what === 'hash') await testHash();
  if (what === 'all') await testStudio();
  if (what === 'frames') await testFrames();
} finally { server.close(); }
console.log(failed ? `\nНе прошло проверок: ${failed}` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);

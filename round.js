'use strict';
/* =========================================================
   ラウンド：GPS・地図・ショット位置記録・スコア・AIキャディ
             コース総評・前回比較・ハンディキャップ・Google衛星写真
   ========================================================= */
let map = null, mapLayers = null, baseLayers = {}, curBase = null, watchId = null;
const curRound = () => db.activeRound;
const courseById = id => db.courses.find(c => c.id === id);
const curCourse = () => curRound() && courseById(curRound().courseId);
const curHole = () => { const c = curCourse(); return c && c.holes[curRound().hole]; };
const avgOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

/* ---------------- スコア計算 ---------------- */
function holeScore(s) {
  if (!s) return null;
  if (s.shots == null && s.strokes != null) return s.strokes;
  const t = (s.shots || 0) + (s.putts || 0) + (s.pen || 0);
  return t || null;
}
function ensureScore(r, n) { r.scores = r.scores || {}; return r.scores[n] || (r.scores[n] = { shots: 0, putts: 0, pen: 0, fw: null }); }
function parOf(r, n) {
  if (r.pars && r.pars[n] != null) return r.pars[n];
  const c = courseById(r.courseId), h = c && c.holes.find(x => String(x.n) === String(n));
  return h ? h.par : 4;
}
function roundStats(r) {
  const o = { holes: 0, strokes: 0, par: 0, putts: 0, puttHoles: 0, pen: 0, fwH: 0, fwN: 0, gir: 0, three: 0, byPar: { 3: [], 4: [], 5: [] }, kinds: { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, worse: 0 } };
  if (r.totalOnly) {
    const ns = Object.keys(r.pars || {});
    o.holes = ns.length; o.strokes = r.totalOnly; o.par = ns.reduce((a, n) => a + r.pars[n], 0);
    if (isNum(r.puttsTotal)) { o.putts = r.puttsTotal; o.puttHoles = ns.length; }
    o.diff = o.strokes - o.par; o.fwPct = null; o.girPct = null; o.totalOnly = true; o.par3 = o.par4 = o.par5 = null;
    return o;
  }
  const holes = Object.keys(r.scores || {}).filter(n => holeScore(r.scores[n])).sort((a, b) => a - b);
  o.holes = holes.length;
  holes.forEach(n => {
    const s = r.scores[n], st = holeScore(s), p = parOf(r, n);
    o.strokes += st; o.par += p; o.pen += s.pen || 0;
    if (p >= 4 && s.fw != null) { o.fwN++; if (s.fw) o.fwH++; }
    if (s.putts != null) {
      o.putts += s.putts; o.puttHoles++;
      if (st - s.putts <= p - 2) o.gir++;
      if (s.putts >= 3) o.three++;
    }
    (o.byPar[p] = o.byPar[p] || []).push(st);
    const d = st - p; o.kinds[d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? 'par' : d === 1 ? 'bogey' : d === 2 ? 'double' : 'worse']++;
  });
  o.diff = o.holes ? o.strokes - o.par : null;
  o.fwPct = o.fwN ? Math.round(o.fwH / o.fwN * 100) : null;
  o.girPct = o.puttHoles ? Math.round(o.gir / o.puttHoles * 100) : null;
  o.par3 = avgOf(o.byPar[3]); o.par4 = avgOf(o.byPar[4]); o.par5 = avgOf(o.byPar[5]);
  return o;
}
const sgn = d => d == null ? '' : (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);

/* ---------------- ハンディキャップ（WHS方式の目安） ---------------- */
const HI_TABLE = { 3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0], 11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0] };
function calcHI(arr) {
  const n = arr.length; if (n < 3) return null;
  const [k, adj] = HI_TABLE[Math.min(n, 20)];
  const best = [...arr].sort((a, b) => a - b).slice(0, k);
  return Math.min(54, Math.round((avgOf(best) + adj) * 10) / 10);
}
const courseHandicap = (hi, slope, rating, par) => Math.round(hi * (slope / 113) + (rating - par));
function strokesReceived(ch, si) { if (!(ch > 0) || !si) return 0; return Math.floor(ch / 18) + ((si <= ch % 18) ? 1 : 0); }
function differential(r, hiBefore) {
  const holes = Object.keys(r.pars || {});
  if (r.totalOnly) {
    if (holes.length < 18) return null;
    const par = holes.reduce((a, n) => a + r.pars[n], 0), rating = r.rating || par, slope = r.slope || 113;
    return { diff: Math.round((113 / slope) * (r.totalOnly - rating) * 10) / 10, ags: r.totalOnly, rating, slope, estimated: true };
  }
  if (holes.length < 18 || holes.filter(n => holeScore((r.scores || {})[n])).length < 18) return null;
  const par = holes.reduce((a, n) => a + r.pars[n], 0), rating = r.rating || par, slope = r.slope || 113;
  const ch = hiBefore != null ? courseHandicap(hiBefore, slope, rating, par) : null;
  let ags = 0;
  holes.forEach((n, i) => {
    const st = holeScore(r.scores[n]), p = r.pars[n], si = (r.sis && r.sis[n]) || (i + 1);
    ags += Math.min(st, ch == null ? p + 5 : p + 2 + strokesReceived(ch, si));
  });
  return { diff: Math.round((113 / slope) * (ags - rating) * 10) / 10, ags, rating, slope, estimated: !r.rating || !r.slope };
}
function handicapHistory() {
  const rs = [...db.rounds].sort((a, b) => new Date(a.date) - new Date(b.date));
  const diffs = [], out = []; let hi = null;
  rs.forEach(r => {
    const before = hi, d = differential(r, hi);
    if (d) { diffs.push({ r, d }); hi = calcHI(diffs.slice(-20).map(x => x.d.diff)); }
    out.push({ r, d, hiBefore: before, hiAfter: hi });
  });
  return { hi, diffs, out };
}
function currentHI() { return handicapHistory().hi; }

/* ---------------- 画面：ラウンド開始 ---------------- */
function renderRound() {
  if (curRound() && curCourse()) { $('#round-start').hidden = true; $('#round-play').hidden = false; startPlay(); }
  else { $('#round-play').hidden = true; $('#round-start').hidden = false; renderRoundStart(); }
}
function renderRoundStart() {
  const el = $('#round-start'), hh = handicapHistory();
  $('#topinfo').textContent = '';
  const courses = db.courses.map(c => `<div class="list-item"><div class="grow"><b>${esc(c.name)}</b><div class="small muted">${c.holes.length}ホール・Par${c.holes.reduce((a, h) => a + h.par, 0)}${c.rating ? `・CR ${c.rating}/SR ${c.slope}` : ''}${c.holes.filter(h => h.green).length < c.holes.length ? `・グリーン設定 ${c.holes.filter(h => h.green).length}/${c.holes.length}` : ''}</div></div>
      <button class="btn small" data-start="${c.id}">開始</button><button class="x-btn" data-editc="${c.id}">✏️</button></div>`).join('');
  const rounds = [...db.rounds].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 15).map(r => {
    const st = roundStats(r), e = hh.out.find(x => x.r.id === r.id);
    return `<div class="list-item" data-rd="${r.id}"><div class="grow"><b>${esc(r.courseName)}</b><div class="small muted">${new Date(r.date).toLocaleDateString('ja-JP')}・${st.holes}H${st.puttHoles ? '・パット' + st.putts : ''}${r.past ? '・入力' : ''}${e && e.d ? `・DF ${e.d.diff}` : ''}</div></div><b style="font-size:22px">${st.strokes || '—'}</b><span class="small muted" style="min-width:30px">${sgn(st.diff)}</span>${r.ai ? '<span class="badge">総評</span>' : ''}</div>`;
  }).join('');
  const n18 = hh.diffs.length;
  el.innerHTML = `
    <h2>ラウンド</h2>
    <div class="card" id="hi-card"><div class="spread"><div><div class="small muted">ハンディキャップ指数（目安）</div><div class="big-num">${hh.hi != null ? hh.hi.toFixed(1) : '—'}</div></div><button class="btn small light">詳細</button></div>
      <div class="small muted">${hh.hi == null ? `18ホールのラウンドをあと${Math.max(0, 3 - n18)}回記録すると算出されます` : `18ホール ${n18}ラウンドから算出（直近20ラウンドのベスト${HI_TABLE[Math.min(n18, 20)][0]}）`}</div></div>
    <div class="card">
      <button class="btn block" id="find-course">📡 近くのゴルフ場を探す（GPS）</button>
      <button class="btn block ghost" id="search-course">🔍 コース名で検索</button>
      <button class="btn block ghost" id="manual-course">✏️ 手動でコースを作成</button>
      <button class="btn block light" id="past-score">📝 過去のスコアを入力（スコアカード撮影も可）</button>
      <p class="small muted" style="margin:4px 0 0;line-height:1.6">ゴルフ場の中で「近くのゴルフ場を探す」を押すと、OpenStreetMapからホール・グリーン・フェアウェイ・バンカー・池を読み込みます。</p>
    </div>
    ${courses ? `<h3>保存済みコース</h3><div class="card">${courses}</div>` : ''}
    ${rounds ? `<h3>ラウンド履歴（タップで総評・前回比較）</h3><div class="card">${rounds}</div>` : ''}
    ${db.settings.competition ? '<div class="notice">競技モード：AIの番手・攻め方アドバイスは無効です（距離表示のみ）。</div>' : ''}`;
  $('#hi-card').onclick = showHandicapDetail;
  $('#find-course').onclick = findCourseFlow;
  $('#manual-course').onclick = manualCourseFlow;
  $('#search-course').onclick = () => searchCourseFlow(async c => { if (await confirmBox(`「${c.name}」でラウンドを開始しますか？`, '開始')) startRound(c.id); else renderRoundStart(); });
  $('#past-score').onclick = () => pastScoreFlow();
  $$('[data-start]', el).forEach(b => b.onclick = () => startRound(b.dataset.start));
  $$('[data-editc]', el).forEach(b => b.onclick = () => editCourse(courseById(b.dataset.editc), renderRoundStart));
  $$('[data-rd]', el).forEach(b => b.onclick = () => showRoundDetail(db.rounds.find(r => r.id === b.dataset.rd)));
}

function showHandicapDetail() {
  const hh = handicapHistory(), last = hh.diffs.slice(-20), k = last.length >= 3 ? HI_TABLE[Math.min(last.length, 20)][0] : 0;
  const used = new Set([...last].sort((a, b) => a.d.diff - b.d.diff).slice(0, k).map(x => x.r.id));
  openModal(`<h2>ハンディキャップ指数</h2>
    <div class="big-num" style="text-align:center">${hh.hi != null ? hh.hi.toFixed(1) : '—'}</div>
    <p class="small muted" style="line-height:1.7">世界統一ハンディキャップ方式（WHS）の計算方法に沿った<b>非公式の目安</b>です。1ラウンドごとに「スコア差（DF）＝(113 ÷ スロープ) ×（調整後スコア − コースレート）」を出し、直近20ラウンドのうち良いものを平均します。調整後スコアは各ホール「ネットダブルボギー」を上限にしています。コースレート・スロープは各コースの✏️で入力してください（未入力だとパー・113で計算し「推定」になります）。</p>
    ${hh.diffs.length ? `<table class="t"><tr><th>日付・コース</th><th>スコア</th><th>調整後</th><th>DF</th></tr>${[...hh.diffs].reverse().map(x => `<tr class="${used.has(x.r.id) ? 'hl' : ''}"><td>${new Date(x.r.date).toLocaleDateString('ja-JP')}<br><span class="small muted">${esc(x.r.courseName)}</span></td><td>${roundStats(x.r).strokes}</td><td>${x.d.ags}</td><td><b>${x.d.diff}</b>${x.d.estimated ? '<br><span class="small muted">推定</span>' : ''}</td></tr>`).join('')}</table><p class="small muted">色付きの行が計算に使われたラウンドです。</p>` : '<p class="muted">18ホールを全ホール記録したラウンドが対象です。</p>'}
    <button class="btn block ghost" onclick="closeModal()">閉じる</button>`);
}

/* ---------------- コース取得・作成・編集 ---------------- */
function getPositionOnce() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('位置情報が使えません'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      e => rej(new Error(e.code === 1 ? '位置情報の許可が必要です（端末の設定で許可してください）' : '現在地を取得できませんでした')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 });
  });
}
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
async function overpass(q) {
  for (const u of OVERPASS) {
    try {
      const r = await fetch(u, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (r.ok) return await r.json();
    } catch (e) { }
  }
  throw new Error('OpenStreetMapに接続できませんでした');
}
async function findCourseFlow() {
  try {
    showLoading('現在地を取得中…');
    const pos = await getPositionOnce();
    showLoading('近くのゴルフ場を検索中…');
    const j = await overpass(`[out:json][timeout:25];(way["leisure"="golf_course"](around:8000,${pos.lat},${pos.lng});relation["leisure"="golf_course"](around:8000,${pos.lat},${pos.lng}););out tags center bb;`);
    hideLoading();
    const list = (j.elements || []).filter(e => e.center && e.bounds).map(e => ({ name: e.tags?.name || e.tags?.['name:ja'] || '名称不明のゴルフ場', bounds: e.bounds, d: distM(pos, { lat: e.center.lat, lng: e.center.lon }) })).sort((a, b) => a.d - b.d);
    if (!list.length) { if (await confirmBox('近くにOpenStreetMap登録のゴルフ場が見つかりませんでした。手動でコースを作成しますか？', '手動作成')) manualCourseFlow(); return; }
    const el = openModal(`<h2>ゴルフ場を選択</h2>${list.slice(0, 12).map((c, i) => `<div class="list-item"><div class="grow"><b>${esc(c.name)}</b><div class="small muted">約${(c.d / 1000).toFixed(1)}km</div></div><button class="btn small" data-i="${i}">読み込む</button></div>`).join('')}`);
    $$('[data-i]', el).forEach(b => b.onclick = () => { closeModal(); importOsmCourse(list[+b.dataset.i]); });
  } catch (e) { hideLoading(); toast(e.message, 4000); }
}
async function importOsmCourse(c, opts = {}) {
  try {
    showLoading(`${c.name} のホール情報を読み込み中…`);
    const b = c.bounds, p = 0.002, bb = `${b.minlat - p},${b.minlon - p},${b.maxlat + p},${b.maxlon + p}`;
    const j = await overpass(`[out:json][timeout:60];(way["golf"~"^(hole|green|bunker|water_hazard|lateral_water_hazard|tee|fairway)$"](${bb});way["natural"="water"](${bb}););out geom;`);
    hideLoading();
    const els = (j.elements || []).filter(e => e.geometry && e.geometry.length);
    const geo = e => e.geometry.map(g => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]);
    const polys = t => els.filter(e => e.tags.golf === t).map(geo).filter(g => g.length >= 3);
    const greens = polys('green'), fairways = polys('fairway'), tees = polys('tee');
    const hazards = els.filter(e => ['bunker', 'water_hazard', 'lateral_water_hazard'].includes(e.tags.golf) || e.tags.natural === 'water').map(e => ({ t: e.tags.golf === 'bunker' ? 'bunker' : 'water', p: geo(e) })).filter(h => h.p.length >= 3);
    let holes = els.filter(e => e.tags.golf === 'hole' && e.geometry.length >= 2).map(e => {
      const line = geo(e), end = line[line.length - 1];
      let gp = null, best = 90;
      greens.forEach(g => { const d = distM(end, centroid(g)); if (d < best) { best = d; gp = g; } });
      return { ref: parseInt(e.tags.ref) || 0, par: parseInt(e.tags.par) || 4, si: parseInt(e.tags.handicap) || null, tee: line[0], green: gp ? centroid(gp) : end, greenPoly: gp, line };
    }).sort((a, b) => a.ref - b.ref);
    let msg = '';
    if (!holes.length) { holes = Array.from({ length: 18 }, (_, i) => ({ ref: i + 1, par: 4, tee: null, green: null, greenPoly: null, line: null })); msg = 'ホール情報が未登録のため、プレー中にグリーン位置を設定してください（グリーン等の形は読み込み済み）'; }
    holes.forEach((h, i) => h.n = h.ref || i + 1);
    const course = { id: uid(), name: c.name, source: 'osm', holes, greens, fairways, tees, hazards, rating: null, slope: null, bounds: c.bounds, created: Date.now() };
    db.courses.push(course); save();
    toast(msg || `${holes.length}ホールを読み込みました。✏️でコースレート・スロープを入れるとハンディキャップが正確になります`, 5000);
    if (opts.ask === false) return course;
    if (await confirmBox(`「${c.name}」でラウンドを開始しますか？`, '開始')) startRound(course.id); else renderRoundStart();
    return course;
  } catch (e) { hideLoading(); toast(e.message, 4000); return null; }
}
function manualCourseFlow() { createCourseForm({ btn: '作成してラウンド開始', onCreated: c => startRound(c.id) }); }
function createCourseForm({ name = '', btn = '作成', onCreated }) {
  const el = openModal(`<h2>コースを作成</h2>
    <label class="f">コース名<input id="mc-name" placeholder="例: ○○カントリークラブ" value="${esc(name)}"></label>
    <div class="grid3"><label class="f">ホール数<select id="mc-n"><option>18</option><option>9</option></select></label><label class="f">コースレート<input id="mc-cr" inputmode="decimal" placeholder="例 71.2"></label><label class="f">スロープ<input id="mc-sr" inputmode="numeric" placeholder="例 128"></label></div>
    <label class="f">各ホールのパー（カンマ区切り・省略可）<input id="mc-par" placeholder="4,4,3,5,4,4,3,4,5,..."></label>
    <p class="small muted">コースレート・スロープはスコアカードやゴルフ場のサイトに載っています（ハンディキャップ計算に使用）。グリーン位置はプレー中に「⋯」から登録できます。</p>
    <button class="btn block" id="mc-ok">${esc(btn)}</button>`);
  $('#mc-ok', el).onclick = () => {
    const n = +$('#mc-n', el).value, pars = $('#mc-par', el).value.split(/[,、\s]+/).map(x => parseInt(x)).filter(x => x >= 3 && x <= 6);
    const course = { id: uid(), name: $('#mc-name', el).value.trim() || 'マイコース', source: 'manual', holes: Array.from({ length: n }, (_, i) => ({ n: i + 1, par: pars[i] || 4, si: null, tee: null, green: null, greenPoly: null, line: null })), greens: [], fairways: [], tees: [], hazards: [], rating: num($('#mc-cr', el).value), slope: num($('#mc-sr', el).value), created: Date.now() };
    db.courses.push(course); save(); closeModal(); if (onCreated) onCreated(course);
  };
}
function editCourse(c, after) {
  if (!c) return;
  const el = openModal(`<h2>コース情報</h2>
    <label class="f">コース名<input id="ec-name" value="${esc(c.name)}"></label>
    <div class="grid2"><label class="f">コースレート（CR）<input id="ec-cr" inputmode="decimal" value="${c.rating ?? ''}" placeholder="例 71.2"></label><label class="f">スロープレート（SR）<input id="ec-sr" inputmode="numeric" value="${c.slope ?? ''}" placeholder="例 128"></label></div>
    <p class="small muted">HC＝ホールのハンディキャップ（難易度順位 1〜18）。スコアカードの「HDCP」欄の数字です。</p>
    <div class="scroll-x"><table class="t"><tr><th>ホール</th><th>パー</th><th>HC</th><th>グリーン</th></tr>
    ${c.holes.map((h, i) => `<tr data-i="${i}"><td>${h.n}</td><td><select class="par">${[3, 4, 5, 6].map(p => `<option ${h.par === p ? 'selected' : ''}>${p}</option>`).join('')}</select></td><td><input class="si" inputmode="numeric" value="${h.si ?? ''}"></td><td>${h.green ? '✓' : '<span class="muted">未</span>'}</td></tr>`).join('')}</table></div>
    <button class="btn block" id="ec-save" style="margin-top:10px">保存</button>
    <button class="btn block light" id="ec-prep">🗺 地図でティー・グリーン位置を設定</button>
    <button class="btn block danger" id="ec-del">このコースを削除</button>`);
  $('#ec-save', el).onclick = () => {
    c.name = $('#ec-name', el).value.trim() || c.name; c.rating = num($('#ec-cr', el).value); c.slope = num($('#ec-sr', el).value);
    $$('tr[data-i]', el).forEach(tr => { const h = c.holes[+tr.dataset.i]; h.par = +$('.par', tr).value; h.si = num($('.si', tr).value); });
    save(); closeModal(); toast('保存しました'); if (after) after();
  };
  $('#ec-prep', el).onclick = () => {
    c.name = $('#ec-name', el).value.trim() || c.name; c.rating = num($('#ec-cr', el).value); c.slope = num($('#ec-sr', el).value);
    $$('tr[data-i]', el).forEach(tr => { const h = c.holes[+tr.dataset.i]; h.par = +$('.par', tr).value; h.si = num($('.si', tr).value); });
    save(); closeModal(); coursePrep(c, 0, after);
  };
  $('#ec-del', el).onclick = async () => {
    closeModal();
    if (curRound() && curRound().courseId === c.id) return toast('プレー中のコースは削除できません');
    if (await confirmBox(`「${c.name}」を削除しますか？（ラウンド履歴は残ります）`, '削除')) { db.courses = db.courses.filter(x => x.id !== c.id); save(); if (after) after(); }
  };
}

/* ---------------- ラウンド開始・地図 ---------------- */
function startRound(courseId) {
  const c = courseById(courseId); if (!c) return;
  condForm(c.lastCond || { tee: 'レギュラー', stimp: 9, firm: '普通', memo: '' }, cond => {
    c.lastCond = cond;
    db.activeRound = { id: uid(), courseId, date: new Date().toISOString(), hole: 0, scores: {}, track: {}, cond, pins: pinsFromDay(cond.day) };
    save(); ui.target = null; renderRound();
  }, { course: c, btn: '⛳ スタート' });
}
/* ---------------- グリーン・コンディション ---------------- */
const TEES = ['バック', 'レギュラー', 'フロント', 'レディース'];
const SPEEDS = [['遅め', 7.5], ['普通', 9], ['速め', 10.5], ['とても速い', 12]];
const FIRMS = ['柔らかい', '普通', '硬い'];
const speedLabel = ft => !isNum(ft) ? '不明' : ft < 8.3 ? '遅め' : ft < 9.8 ? '普通' : ft < 11.3 ? '速め' : 'とても速い';
function condForm(cur, onOK, { course, btn = '保存' } = {}) {
  const c0 = Object.assign({ tee: 'レギュラー', stimp: 9, firm: '普通', memo: '' }, cur || {});
  const unset = course ? course.holes.filter(h => !h.green).length : 0;
  const el = openModal(`<h2>${course ? esc(course.name) : 'コンディション'}</h2>
    ${unset ? `<div class="notice" style="margin-bottom:10px">グリーン位置が未設定のホールが ${unset} あります。<button class="btn small light" id="cf-prep" style="margin-top:6px">🗺 地図でティー・グリーンを設定する</button></div>` : ''}
    <button class="btn block accent" id="cf-cam">📷 本日のティー・ピン位置表を撮影して読み込む（複数枚OK）</button>
    <div id="cf-day" class="small" style="margin:-2px 0 12px;line-height:1.6">${c0.day && c0.day.holes ? dayInfoSummary(c0.day) : '<span class="muted">スタート前に掲示される「本日のピン位置・ティー位置」の表やカードを撮ると、ホールごとの距離とピン位置を読み取ってキャディに反映します。</span>'}</div>
    <div class="small muted">使用ティー</div><div class="chips" style="margin:4px 0 12px">${TEES.map(t => `<button class="chip ${c0.tee === t ? 'on' : ''}" data-tee="${t}">${t}</button>`).join('')}</div>
    <div class="small muted">グリーンスピード（スティンプメーター）</div>
    <div class="chips" style="margin:4px 0 6px">${SPEEDS.map(([l, v]) => `<button class="chip ${speedLabel(c0.stimp) === l ? 'on' : ''}" data-sp="${v}">${l}</button>`).join('')}</div>
    <div class="row" style="margin-bottom:12px"><input id="cf-stimp" inputmode="decimal" value="${c0.stimp ?? ''}" style="width:90px;padding:9px;border:1px solid #cfd6d2;border-radius:10px;font-size:16px;text-align:center"><span>フィート</span><span class="small muted">（クラブハウスの掲示板に「本日のグリーン 9.5ft」等）</span></div>
    <div class="small muted">グリーンの硬さ</div><div class="seg" style="margin:4px 0 12px">${FIRMS.map(f => `<button data-firm="${f}" class="${c0.firm === f ? 'on' : ''}">${f}</button>`).join('')}</div>
    <label class="f">メモ（任意）<input id="cf-memo" value="${esc(c0.memo || '')}" placeholder="例: 芝目が強い、受けグリーンが多い、ピンは奥が多い"></label>
    <button class="btn block" id="cf-ok">${esc(btn)}</button>`);
  $$('[data-tee]', el).forEach(b => b.onclick = () => { c0.tee = b.dataset.tee; $$('[data-tee]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $$('[data-sp]', el).forEach(b => b.onclick = () => { $('#cf-stimp', el).value = b.dataset.sp; $$('[data-sp]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#cf-stimp', el).oninput = e => { const l = speedLabel(num(e.target.value)); $$('[data-sp]', el).forEach(x => x.classList.toggle('on', x.textContent === l)); };
  $$('[data-firm]', el).forEach(b => b.onclick = () => { c0.firm = b.dataset.firm; $$('[data-firm]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#cf-cam', el).onclick = async () => {
    const d = await readDaySheet(course, c0.tee); if (!d) return;
    c0.day = d;
    if (isNum(d.stimp)) { c0.stimp = d.stimp; $('#cf-stimp', el).value = d.stimp; $('#cf-stimp', el).oninput({ target: $('#cf-stimp', el) }); }
    if (d.tee && TEES.includes(d.tee)) { c0.tee = d.tee; $$('[data-tee]', el).forEach(x => x.classList.toggle('on', x.dataset.tee === d.tee)); }
    $('#cf-day', el).innerHTML = dayInfoSummary(d);
  };
  if ($('#cf-prep', el)) $('#cf-prep', el).onclick = () => { closeModal(); coursePrep(course, 0, () => condForm(c0, onOK, { course, btn })); };
  $('#cf-ok', el).onclick = () => { c0.stimp = num($('#cf-stimp', el).value); c0.memo = $('#cf-memo', el).value.trim(); closeModal(); onOK(c0); };
}
const SLOPES = ['受け（奥が高い）', '奥へ下る', '左が高い', '右が高い', '砲台', '2段', 'すり鉢', 'フラット'];
const slopeText = h => [(h.slope || []).join('・'), h.slopeMemo].filter(Boolean).join('／');
const PIN_D = { front: '手前', center: '中', back: '奥' }, PIN_S = { left: '左', center: '中', right: '右' };
const pinLabel = p => !p ? '' : isNum(p.fromFront) ? `手前から${p.fromFront}y${p.s && p.s !== 'center' ? '・' + PIN_S[p.s] + (isNum(p.fromSide) ? p.fromSide + 'y' : '') : ''}` : (p.d === 'center' && p.s === 'center' ? 'センター' : `${PIN_D[p.d]}${p.s !== 'center' ? '・' + PIN_S[p.s] : ''}`);
function pinForm() {
  const r = curRound(), h = curHole(); r.pins = r.pins || {}; const cur = r.pins[h.n];
  const el = openModal(`<h2>📍 ${h.n}番のピン位置</h2><p class="small muted">グリーンを上から見て、手前が下です。</p>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;max-width:300px;margin:0 auto 12px">
    ${['back', 'center', 'front'].map(d => ['left', 'center', 'right'].map(s => `<button class="btn ${cur && cur.d === d && cur.s === s ? '' : 'light'}" data-d="${d}" data-s="${s}" style="padding:16px 0">${d === 'center' && s === 'center' ? '中央' : PIN_D[d] + (s !== 'center' ? PIN_S[s] : '')}</button>`).join('')).join('')}</div>
    <button class="btn block ghost" id="pin-clear">未設定にする（センターで計算）</button>
    <h3>グリーンの傾斜（このコースに保存）</h3>
    <div class="chips" id="slope-chips">${SLOPES.map(s => `<button class="chip ${(h.slope || []).includes(s) ? 'on' : ''}" data-sl="${s}">${s}</button>`).join('')}</div>
    <label class="f" style="margin-top:8px">傾斜メモ<input id="slope-memo" value="${esc(h.slopeMemo || '')}" placeholder="例: 奥からは高速の下り、右奥が一番高い"></label>
    <button class="btn block light" id="slope-save">傾斜を保存</button>`);
  $$('[data-sl]', el).forEach(b => b.onclick = () => b.classList.toggle('on'));
  $('#slope-save', el).onclick = () => { h.slope = $$('[data-sl].on', el).map(b => b.dataset.sl); h.slopeMemo = $('#slope-memo', el).value.trim(); save(); closeModal(); toast('グリーンの傾斜を保存しました（次回以降のラウンドでも使われます）'); };
  $$('[data-d]', el).forEach(b => b.onclick = () => { r.pins[h.n] = { d: b.dataset.d, s: b.dataset.s }; save(); closeModal(); updateDistances(); });
  $('#pin-clear', el).onclick = () => { delete r.pins[h.n]; save(); closeModal(); updateDistances(); };
}
/* ---------------- コースの準備（地図でティー・グリーンを登録） ---------------- */
let prepMap = null;
async function makeBaseLayer() {
  if ((db.settings.mapProvider || 'esri') === 'google') {
    try { const g = await googleLayer(); return L.tileLayer(g._url, g.options); } catch (e) { toast('Google衛星写真を使えないため、Esriの航空写真で表示します'); }
  }
  if (db.settings.mapProvider === 'osm') return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
  return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' });
}
async function coursePrep(course, idx = 0, after) {
  if (!course) return;
  let hi = Math.max(0, Math.min(idx, course.holes.length - 1)), mode = 'tee';
  const MODES = { tee: 'ティー', green: 'グリーン中央', front: 'グリーン手前', back: 'グリーン奥' }, NEXT = { tee: 'green', green: 'front', front: 'back', back: 'tee' };
  const el = openModal(`<h2>🗺 ${esc(course.name)}</h2>
    <div class="row" style="margin-bottom:8px"><input id="pp-q" class="grow" placeholder="場所を検索（ゴルフ場名など）" style="padding:9px;border:1px solid #cfd6d2;border-radius:10px"><button class="btn small" id="pp-go">移動</button></div>
    <div class="spread" style="margin-bottom:6px"><button class="icon-btn" id="pp-prev">◀</button><b id="pp-hole" style="font-size:17px"></b><button class="icon-btn" id="pp-next">▶</button></div>
    <div id="prep-map" style="height:46vh;border-radius:12px;overflow:hidden;background:#2d3b2f"></div>
    <div class="seg" style="margin:8px 0">${Object.entries(MODES).map(([k, v]) => `<button data-pm="${k}">${v.replace('グリーン', '')}</button>`).join('')}</div>
    <div id="pp-info" class="small" style="min-height:40px;line-height:1.6"></div>
    <div class="grid2"><button class="btn ghost" id="pp-me">📍 現在地へ</button><button class="btn" id="pp-done">完了</button></div>`, () => { if (prepMap) { prepMap.remove(); prepMap = null; } if (after) after(); });
  prepMap = L.map($('#prep-map', el), { zoomControl: true, maxZoom: 21 });
  (await makeBaseLayer()).addTo(prepMap);
  const bg = L.layerGroup().addTo(prepMap), lg = L.layerGroup().addTo(prepMap);
  (course.hazards || []).forEach(h => L.polygon(h.p, { color: h.t === 'water' ? '#1d4ed8' : '#b59545', weight: 1, fillOpacity: .3, interactive: false }).addTo(bg));
  (course.greens || []).forEach(g => L.polygon(g, { color: '#15803d', weight: 1, fillColor: '#4ade80', fillOpacity: .25, interactive: false }).addTo(bg));
  const icon = (txt, color) => L.divIcon({ className: '', html: `<div class="trk-num" style="background:${color};color:#fff">${txt}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
  const render = () => {
    const h = course.holes[hi]; lg.clearLayers();
    $('#pp-hole').textContent = `${h.n}番 Par${h.par}${h.si ? ' HC' + h.si : ''}`;
    $$('[data-pm]', el).forEach(b => b.classList.toggle('on', b.dataset.pm === mode));
    if (h.tee && h.green) L.polyline([h.tee, h.green], { color: '#fff', weight: 2, dashArray: '6 6', interactive: false }).addTo(lg);
    if (h.greenPoly) L.polygon(h.greenPoly, { color: '#facc15', weight: 2, fillOpacity: 0, interactive: false }).addTo(lg);
    if (h.tee) L.marker(h.tee, { icon: icon('T', '#2563eb'), interactive: false }).addTo(lg);
    if (h.green) L.marker(h.green, { icon: flagIcon(), interactive: false }).addTo(lg);
    if (h.gFront) L.marker(h.gFront, { icon: icon('前', '#16a34a'), interactive: false }).addTo(lg);
    if (h.gBack) L.marker(h.gBack, { icon: icon('奥', '#b45309'), interactive: false }).addTo(lg);
    const info = [];
    if (h.tee && h.green) info.push(`ティー〜グリーン中央 <b>${fmt(distY(h.tee, h.green))}</b>`);
    if (h.gFront && h.gBack) info.push(`グリーンの奥行き <b>${fmt(distY(h.gFront, h.gBack))}</b>`);
    else if (h.greenPoly) info.push('グリーンの形あり（手前・奥は自動計算）');
    $('#pp-info').innerHTML = `${info.join('　')}<br><span style="color:var(--green);font-weight:700">地図をタップして「${MODES[mode]}」の位置を設定</span>`;
  };
  const fit = async () => {
    const h = course.holes[hi], pts = [h.tee, h.green, h.gFront, h.gBack, ...(h.greenPoly || [])].filter(Boolean);
    const prev = course.holes[hi - 1];
    if (pts.length >= 2) prepMap.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 18 });
    else if (pts.length === 1) prepMap.setView(pts[0], 17);
    else if (prev && prev.green) prepMap.setView(prev.green, 17);
    else if (course.bounds) prepMap.fitBounds([[course.bounds.minlat, course.bounds.minlon], [course.bounds.maxlat, course.bounds.maxlon]]);
    else if (course.center) prepMap.setView(course.center, 16);
    else {
      prepMap.setView([36.2, 138.2], 5);
      try { const p = await getPositionOnce(); if (prepMap) prepMap.setView([p.lat, p.lng], 16); } catch (e) { toast('上の検索欄にゴルフ場名を入れて「移動」を押してください', 4000); }
    }
  };
  const goHole = d => { const n = hi + d; if (n < 0 || n >= course.holes.length) return; hi = n; const h = course.holes[hi]; mode = !h.tee ? 'tee' : !h.green ? 'green' : !h.greenPoly && !h.gFront ? 'front' : !h.greenPoly && !h.gBack ? 'back' : 'tee'; render(); fit(); };
  prepMap.on('click', e => {
    const h = course.holes[hi], p = A({ lat: e.latlng.lat, lng: e.latlng.lng });
    if (mode === 'tee') h.tee = p;
    else if (mode === 'green') { const poly = (course.greens || []).find(g => inPoly(p, g)); h.green = poly ? centroid(poly) : p; h.greenPoly = poly || null; if (poly) { mode = 'back'; } }
    else if (mode === 'front') h.gFront = p;
    else { h.gBack = p; }
    save();
    if (mode === 'back' && (h.gBack || h.greenPoly)) { mode = 'tee'; render(); if (hi < course.holes.length - 1) toast(`${h.n}番の設定ができました。▶で次のホールへ`, 2200); return; }
    mode = NEXT[mode]; render();
  });
  $$('[data-pm]', el).forEach(b => b.onclick = () => { mode = b.dataset.pm; render(); });
  $('#pp-prev', el).onclick = () => goHole(-1);
  $('#pp-next', el).onclick = () => goHole(1);
  $('#pp-done', el).onclick = closeModal;
  $('#pp-me', el).onclick = async () => { try { const p = await getPositionOnce(); prepMap.setView([p.lat, p.lng], 18); } catch (e) { toast(e.message); } };
  const search = async () => {
    const q = $('#pp-q', el).value.trim(); if (!q) return;
    try { const res = await nominatimSearch(q), x = res.find(y => y.type === 'golf_course') || res[0]; if (!x) return toast('見つかりませんでした');
      const bb = x.boundingbox.map(Number); prepMap.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]]); course.center = [+x.lat, +x.lon]; save(); }
    catch (e) { toast(e.message); }
  };
  $('#pp-go', el).onclick = search; $('#pp-q', el).onkeydown = e => { if (e.key === 'Enter') search(); };
  mode = !course.holes[hi].tee ? 'tee' : 'green';
  render(); setTimeout(() => { if (prepMap) { prepMap.invalidateSize(); fit(); } }, 120);
}
function startPlay() {
  if (!map) initMap();
  setTimeout(() => map.invalidateSize(), 50);
  keepAwake(true);
  if (watchId == null && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(onPos, e => { $('#d-gps').textContent = e.code === 1 ? '⚠️ 位置情報が許可されていません' : '⚠️ GPS信号を待っています'; }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }
  drawCourse(); drawHole(true); updateDistances(); maybeFetchEnv();
}
function stopPlay() {
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  keepAwake(false);
}
let wakeLock = null, wantAwake = false;
async function keepAwake(on) {
  wantAwake = on;
  if (Bridge && Bridge.keepScreenOn) { Bridge.keepScreenOn(on); return; }
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { }
}
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 21 });
  baseLayers.esri = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri' });
  baseLayers.osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' });
  map.setView([35.68, 139.76], 16);
  mapLayers = { course: L.layerGroup().addTo(map), hole: L.layerGroup().addTo(map), track: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map), target: L.layerGroup().addTo(map) };
  map.on('click', onMapTap);
  map.on('moveend', () => { if (curBase === 'google') updateGoogleAttr(); });
  setBase(db.settings.mapProvider || 'esri');
}
// --- Google衛星写真（Google Maps Platform / Map Tiles API） ---
async function googleLayer() {
  const key = (db.settings.googleKey || '').trim();
  if (!key) throw new Error('設定でGoogle Maps APIキーを入力してください');
  let s = db.settings.gSession;
  if (!s || s.key !== key || Date.now() / 1000 > s.expiry - 3600) {
    let r; try { r = await fetch('https://tile.googleapis.com/v1/createSession?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapType: 'satellite', language: 'ja-JP', region: 'JP' }) }); } catch (e) { throw new Error('Googleに接続できませんでした（通信状況を確認してください）'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.session) {
      const m = j?.error?.message || '', st = j?.error?.status || '';
      if (/not been used|disabled|SERVICE_DISABLED/i.test(m + st)) throw new Error('Google Cloudで「Map Tiles API」が有効になっていません');
      if (/billing/i.test(m)) throw new Error('Google Cloudで請求先アカウントの設定が必要です');
      if (/referer|referrer/i.test(m)) throw new Error(`APIキーのリファラー制限に ${location.origin}/* を追加してください`);
      if (/API key not valid|API_KEY_INVALID/i.test(m + st)) throw new Error('Google Maps APIキーが正しくありません');
      throw new Error(m || ('HTTP ' + r.status));
    }
    s = { token: j.session, expiry: +j.expiry || (Date.now() / 1000 + 86400), key };
    db.settings.gSession = s; save();
  }
  if (baseLayers.google && baseLayers.google._tok === s.token) return baseLayers.google;
  if (baseLayers.google && map && map.hasLayer(baseLayers.google)) map.removeLayer(baseLayers.google);
  baseLayers.google = L.tileLayer(`https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}?session=${encodeURIComponent(s.token)}&key=${encodeURIComponent(key)}`, { maxZoom: 21, maxNativeZoom: 19, attribution: 'Google' });
  baseLayers.google._tok = s.token;
  baseLayers.google.on('tileerror', () => { if (!baseLayers.google._warned) { baseLayers.google._warned = true; toast('Googleの画像を一部取得できませんでした'); } });
  return baseLayers.google;
}
let gAttrT = null, gAttr = '';
function updateGoogleAttr() {
  clearTimeout(gAttrT);
  gAttrT = setTimeout(async () => {
    const s = db.settings.gSession, key = db.settings.googleKey; if (!s || !map) return;
    const b = map.getBounds();
    try {
      const r = await fetch(`https://tile.googleapis.com/tile/v1/viewport?session=${encodeURIComponent(s.token)}&key=${encodeURIComponent(key)}&zoom=${Math.min(19, Math.round(map.getZoom()))}&north=${b.getNorth()}&south=${b.getSouth()}&east=${b.getEast()}&west=${b.getWest()}`);
      const j = await r.json();
      if (j.copyright) { if (gAttr) map.attributionControl.removeAttribution(gAttr); gAttr = esc(j.copyright); map.attributionControl.addAttribution(gAttr); }
    } catch (e) { }
  }, 800);
}
async function setBase(name) {
  let layer = baseLayers[name];
  if (name === 'google') {
    try { layer = await googleLayer(); }
    catch (e) { toast('Google衛星写真を使えません：' + e.message, 4500); name = 'esri'; layer = baseLayers.esri; }
  }
  Object.values(baseLayers).forEach(l => { if (l !== layer && map.hasLayer(l)) map.removeLayer(l); });
  if (gAttr && name !== 'google') { map.attributionControl.removeAttribution(gAttr); gAttr = ''; }
  if (!map.hasLayer(layer)) { layer.addTo(map); if (layer.bringToBack) layer.bringToBack(); }
  curBase = name;
  if (name === 'google') updateGoogleAttr();
}
const BASE_LABEL = { esri: '航空写真（Esri・無料）', google: 'Google衛星写真', osm: '地図（OpenStreetMap）' };

function drawCourse() {
  const c = curCourse(); mapLayers.course.clearLayers(); if (!c) return;
  (c.hazards || []).forEach(h => L.polygon(h.p, { color: h.t === 'water' ? '#1d4ed8' : '#b59545', weight: 1, fillColor: h.t === 'water' ? '#3b82f6' : '#e9d8a6', fillOpacity: .4, interactive: false }).addTo(mapLayers.course));
  (c.greens || []).forEach(g => L.polygon(g, { color: '#15803d', weight: 1, fillColor: '#4ade80', fillOpacity: .3, interactive: false }).addTo(mapLayers.course));
}
const flagIcon = () => L.divIcon({ className: '', html: '<div style="font-size:26px;transform:translate(2px,-22px)">⛳</div>', iconSize: [0, 0] });
function drawHole(fit) {
  const h = curHole(); if (!h) return;
  mapLayers.hole.clearLayers();
  $('#hole-label').textContent = `${h.n}番ホール`;
  $('#hole-par').textContent = `Par ${h.par}${h.si ? ' · HC' + h.si : ''}`;
  if (h.line) L.polyline(h.line, { color: '#fff', weight: 2, dashArray: '6 6', opacity: .7, interactive: false }).addTo(mapLayers.hole);
  if (h.greenPoly) L.polygon(h.greenPoly, { color: '#facc15', weight: 2, fillOpacity: 0, interactive: false }).addTo(mapLayers.hole);
  if (h.green) L.marker(h.green, { icon: flagIcon(), interactive: false }).addTo(mapLayers.hole);
  if (h.tee) L.circleMarker(h.tee, { radius: 5, color: '#fff', fillColor: '#2563eb', fillOpacity: 1, weight: 2, interactive: false }).addTo(mapLayers.hole);
  if (fit) {
    const pts = [h.tee, h.green, ...(h.line || []), ...(h.greenPoly || [])].filter(Boolean);
    if (ui.pos && h.green && distM(ui.pos, h.green) < 700) pts.push([ui.pos.lat, ui.pos.lng]);
    if (pts.length >= 2) map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 18 });
    else if (pts.length === 1) map.setView(pts[0], 17);
    else if (ui.pos) map.setView([ui.pos.lat, ui.pos.lng], 17);
  }
  drawTrack(); updateScoreMini();
  $('#set-green-banner').hidden = !ui.setGreen;
}

/* ---------------- ショット位置の記録 ---------------- */
function holeTrack(r = curRound(), n = curHole() && curHole().n) { r.track = r.track || {}; return r.track[n] || (r.track[n] = []); }
const strokesOf = tr => tr.filter(x => !x.pen);
const lastStroke = tr => { const s = strokesOf(tr); return s[s.length - 1] || null; };
function lieAt(p, c = curCourse()) {
  if (!c || !p) return null;
  for (const h of c.hazards || []) if (inPoly(p, h.p)) return h.t === 'water' ? '池' : 'バンカー';
  for (const g of c.greens || []) if (inPoly(p, g)) return 'グリーン';
  for (const f of c.fairways || []) if (inPoly(p, f)) return 'フェアウェイ';
  for (const t of c.tees || []) if (inPoly(p, t)) return 'ティー';
  return (c.fairways && c.fairways.length) ? 'ラフ' : null;
}
function closeShot(shot, endPos) {
  const r = curRound(), h = curHole();
  shot.end = A(P(endPos)); shot.endLie = lieAt(endPos);
  const d = distY(shot.pos, endPos); shot.dist = r1(d);
  const id = 'tr-' + shot.id; db.shots = db.shots.filter(x => x.id !== id);
  if (shot.clubId && !shot.penalized && d >= 5 && d <= 380) db.shots.push({ id, clubId: shot.clubId, date: new Date(shot.t).toISOString(), src: 'course', roundId: r.id, total: r1(d), acc: shot.acc });
  const s = ensureScore(r, h.n);
  if (shot.k === 1 && h.par >= 4 && s.fw == null && shot.endLie) s.fw = shot.endLie === 'フェアウェイ';
}
function recordShot(clubId) {
  const r = curRound(), h = curHole(), tr = holeTrack();
  const prev = lastStroke(tr);
  if (prev && !prev.end && !prev.penalized) closeShot(prev, ui.pos);
  const k = strokesOf(tr).length + 1, lie = k === 1 ? 'ティー' : lieAt(ui.pos);
  tr.push({ id: uid(), k, clubId, pos: A(ui.pos), acc: Math.round(ui.pos.acc), t: Date.now(), lie });
  const s = ensureScore(r, h.n); s.shots = (s.shots || 0) + 1;
  save(); drawTrack(); updateDistances(); updateScoreMini();
  toast(`${k}打目（${clubById(clubId)?.name || ''}${lie ? '・' + lie : ''}）の位置を記録${prev && prev.dist ? `／前の${prev.k}打目は ${fmt(prev.dist)}` : ''}`, 2600);
}
function addPenalty(type) {
  const r = curRound(), h = curHole(), tr = holeTrack(), last = lastStroke(tr);
  if (last) { last.penalized = true; db.shots = db.shots.filter(x => x.id !== 'tr-' + last.id); if (last.k === 1 && h.par >= 4) ensureScore(r, h.n).fw = false; }
  tr.push({ id: uid(), pen: type, pos: ui.pos ? A(ui.pos) : null, t: Date.now() });
  const s = ensureScore(r, h.n); s.pen = (s.pen || 0) + 1;
  save(); drawTrack(); updateDistances(); updateScoreMini();
  toast(`${type}：ペナルティ +1（このホール計${s.pen}）`);
}
function undoTrack() {
  const r = curRound(), h = curHole(), tr = holeTrack(), x = tr.pop(); if (!x) return;
  const s = ensureScore(r, h.n);
  if (x.pen) { s.pen = Math.max(0, (s.pen || 0) - 1); const l = lastStroke(tr); if (l) l.penalized = tr.some(y => y.pen && y.t > l.t); }
  else { s.shots = Math.max(0, (s.shots || 0) - 1); db.shots = db.shots.filter(y => y.id !== 'tr-' + x.id); const l = lastStroke(tr); if (l && l.end) { delete l.end; delete l.dist; delete l.endLie; db.shots = db.shots.filter(y => y.id !== 'tr-' + l.id); } }
  save(); drawTrack(); updateDistances(); updateScoreMini();
}
const numIcon = (k, pen) => L.divIcon({ className: '', html: `<div class="trk-num${pen ? ' pen' : ''}">${k}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
function drawTrack() {
  if (!mapLayers) return; mapLayers.track.clearLayers();
  const r = curRound(), h = curHole(); if (!r || !h) return;
  const tr = (r.track || {})[h.n] || [], st = strokesOf(tr);
  st.forEach((s, i) => {
    const end = s.end || (st[i + 1] && st[i + 1].pos);
    if (end) {
      L.polyline([s.pos, end], { color: s.penalized ? '#ef4444' : '#fff', weight: 3, opacity: .95, dashArray: s.penalized ? '5 5' : null, interactive: false }).addTo(mapLayers.track);
      const mid = [(s.pos[0] + end[0]) / 2, (s.pos[1] + end[1]) / 2];
      L.marker(mid, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="trk-lbl">${esc(clubById(s.clubId)?.name || '')} ${fmt(distY(s.pos, end))}</div>`, iconSize: [0, 0] }) }).addTo(mapLayers.track);
    }
    L.marker(s.pos, { icon: numIcon(s.k, s.penalized), interactive: false }).addTo(mapLayers.track);
  });
  const l = st[st.length - 1];
  if (l && l.end) L.circleMarker(l.end, { radius: 6, color: '#111', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(mapLayers.track);
  tr.filter(x => x.pen && x.pos).forEach(x => L.marker(x.pos, { interactive: false, icon: L.divIcon({ className: '', html: `<div class="trk-pen">${esc(x.pen)}</div>`, iconSize: [0, 0] }) }).addTo(mapLayers.track));
}
const PEN_TYPES = ['OB', '池・ハザード', 'アンプレヤブル', 'ロストボール', 'その他'];
$('#btn-shot').onclick = () => {
  if (!db.clubs.length) { toast('先に「クラブ」タブでクラブを登録してください'); return; }
  const tr = holeTrack(), k = strokesOf(tr).length + 1;
  const el = openModal(`<h2>${k}打目を記録</h2><p class="small muted" style="margin-top:-4px">今いる場所（打つ場所）で、使うクラブを選んでください。前のショットの飛距離も自動で記録されます。${ui.pos ? `現在地：${lieAt(ui.pos) || '—'}` : ''}</p>
    <div class="chips">${sortedClubs().filter(c => c.type !== 'putter').map(c => `<button class="chip big" data-c="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <h3>ペナルティ（+1打）</h3><div class="chips">${PEN_TYPES.map(t => `<button class="chip" data-pen="${t}" style="border-color:#fca5a5;color:#b91c1c">${t}</button>`).join('')}</div>
    ${tr.length ? `<h3>このホールの記録</h3>${trackListHTML(tr)}<button class="btn small ghost" id="undo-trk" style="margin-top:8px">↩ 最後の記録を取り消す</button>` : ''}`);
  $$('[data-c]', el).forEach(b => b.onclick = () => {
    if (!ui.pos) { toast('GPS取得中です。少し待ってから操作してください'); return; }
    closeModal(); recordShot(b.dataset.c);
  });
  $$('[data-pen]', el).forEach(b => b.onclick = () => { closeModal(); addPenalty(b.dataset.pen); });
  if ($('#undo-trk', el)) $('#undo-trk', el).onclick = () => { closeModal(); undoTrack(); toast('取り消しました'); };
};
$('#btn-measure').onclick = () => {
  const l = lastStroke(holeTrack());
  if (!l) { toast('先に「ショット」で打った場所を記録してください'); return; }
  if (!ui.pos) return toast('GPS取得中です');
  if (ui.pos.acc > 25) toast('GPS精度が低めです（±' + Math.round(ui.pos.acc) + 'm）');
  closeShot(l, ui.pos); save(); drawTrack(); updateDistances();
  toast(`${l.k}打目 ${clubById(l.clubId)?.name || ''}：${fmt(l.dist)}${l.endLie ? '（' + l.endLie + '）' : ''}`, 3000);
};
function trackListHTML(tr) {
  return tr.map(x => x.pen ? `<div class="shot-line"><span style="color:#b91c1c">⚠ ${esc(x.pen)}（+1）</span></div>`
    : `<div class="shot-line"><span><b>${x.k}.</b> ${esc(clubById(x.clubId)?.name || '?')}${x.lie ? ` <span class="small muted">${esc(x.lie)}から</span>` : ''}</span><span>${x.dist != null ? fmt(x.dist) : '<span class="muted small">計測前</span>'}${x.endLie ? ` <span class="small muted">→${esc(x.endLie)}</span>` : ''}${x.penalized ? ' <span class="badge gray">ペナ</span>' : ''}</span></div>`).join('');
}

/* ---------------- 気象（Open-Meteo）と実質距離 ---------------- */
const env = { wx: null, wxAt: 0, elev: {}, myElev: null, myElevAt: null };
const WX = c => c == null ? ['', '—'] : c === 0 ? ['☀️', '快晴'] : c === 1 ? ['🌤', '晴れ'] : c === 2 ? ['⛅', '晴れ時々曇り'] : c === 3 ? ['☁️', '曇り'] : c <= 48 ? ['🌫', '霧'] : c <= 57 ? ['🌦', '霧雨'] : c <= 67 ? ['🌧', '雨'] : c <= 77 ? ['🌨', '雪'] : c <= 82 ? ['🌦', 'にわか雨'] : c <= 86 ? ['🌨', 'にわか雪'] : ['⛈', '雷雨'];
async function maybeFetchEnv() {
  const at = ui.pos || (curHole() && curHole().green && P(curHole().green)); if (!at) return;
  const now = Date.now();
  if (now - env.wxAt > 10 * 60 * 1000) {
    env.wxAt = now;
    try {
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${at.lat.toFixed(4)}&longitude=${at.lng.toFixed(4)}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m&hourly=precipitation_probability&forecast_hours=3&wind_speed_unit=ms&timezone=auto`);
      const j = await r.json(), c = j.current;
      if (c) {
        env.wx = { temp: c.temperature_2m, hum: c.relative_humidity_2m, feels: c.apparent_temperature, precip: c.precipitation, code: c.weather_code, pres: c.surface_pressure, speed: c.wind_speed_10m, dir: c.wind_direction_10m, gust: c.wind_gusts_10m, pop: j.hourly && j.hourly.precipitation_probability ? Math.max(...j.hourly.precipitation_probability.filter(isNum)) : null, at: now };
        const rd = curRound(); if (rd && !rd.weather) { rd.weather = { ...env.wx }; save(); }
      }
    } catch (e) { env.wxAt = now - 9 * 60 * 1000; }
  }
  const h = curHole();
  if (ui.pos && h && h.green) {
    const gKey = h.green.join(','), needMe = !env.myElevAt || distM(env.myElevAt, ui.pos) > 25;
    if (needMe || env.elev[gKey] == null) {
      const p = { lat: ui.pos.lat, lng: ui.pos.lng }; env.myElevAt = p;
      try {
        const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${p.lat.toFixed(5)},${h.green[0]}&longitude=${p.lng.toFixed(5)},${h.green[1]}`);
        const j = await r.json(); if (j.elevation) { env.myElev = j.elevation[0]; env.elev[gKey] = j.elevation[1]; }
      } catch (e) { env.myElevAt = null; }
    }
  }
  updateDistances();
}
function windComp(bear) {
  const w = env.wx; if (!w || !isNum(w.speed)) return null;
  const d = (w.dir - bear) * D2R;
  return { head: w.speed * Math.cos(d), cross: w.speed * Math.sin(d), speed: w.speed, dir: w.dir, gust: w.gust };
}
function elevDiff() { const h = curHole(); if (!h || !h.green || env.myElev == null) return null; const g = env.elev[h.green.join(',')]; return g == null ? null : g - env.myElev; }
// 空気密度（気温・気圧）による飛距離の増減。基準：20℃・1013hPa
function airEffect() {
  const w = env.wx; if (!w || !isNum(w.temp) || !isNum(w.pres)) return null;
  const rho = w.pres * 100 / (287.05 * (w.temp + 273.15));
  return 0.55 * (1 - rho / 1.204); // +0.03 = 3%飛ぶ
}
function playsLike(dist, bear) {
  const w = windComp(bear), e = elevDiff(), a = airEffect();
  if (!w && e == null && a == null) return null;
  const windF = w ? (w.head >= 0 ? 0.022 * w.head : 0.011 * w.head) : 0;
  const parts = { wind: dist * windF, air: a != null ? -dist * a : 0, elev: e != null ? e * M2YD : 0 };
  return { d: dist + parts.wind + parts.air + parts.elev, parts };
}

/* ---------------- 距離表示 ---------------- */
let lastAutoFit = 0;
function onPos(p) {
  const first = !ui.pos;
  ui.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
  mapLayers.me.clearLayers();
  L.circle([ui.pos.lat, ui.pos.lng], { radius: ui.pos.acc, color: '#60a5fa', weight: 1, fillOpacity: .12, interactive: false }).addTo(mapLayers.me);
  L.circleMarker([ui.pos.lat, ui.pos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(mapLayers.me);
  if (first) drawHole(true);
  updateDistances(); maybeFetchEnv();
}
function greenInfo(from) {
  const h = curHole(); if (!h || !h.green || !from) return null;
  const center = distY(from, h.green); let front = null, back = null;
  if (h.greenPoly) { const f = frame(from, h.green), al = h.greenPoly.map(p => f(p).along * M2YD); front = Math.max(0, Math.min(...al)); back = Math.max(0, Math.max(...al)); }
  else { if (h.gFront) front = distY(from, h.gFront); if (h.gBack) back = distY(from, h.gBack); }
  const r = curRound(), pin = r && r.pins && r.pins[h.n];
  let pinD = center;
  if (pin && isNum(pin.fromFront) && front != null) pinD = front + pin.fromFront;
  else if (pin && isNum(pin.fromFront)) pinD = center - 12 + pin.fromFront;
  else if (pin && front != null && back != null) pinD = front + (back - front) * ({ front: 0.25, center: 0.5, back: 0.75 }[pin.d]);
  else if (pin) pinD = center + ({ front: -6, center: 0, back: 6 }[pin.d]);
  return { center, front, back, pin: pinD, pinSet: !!pin, bearing: bearing(from, h.green) };
}
function hazardsAhead(from, gi) {
  const c = curCourse(), h = curHole(); if (!c || !h || !h.green || !from) return [];
  const f = frame(from, h.green), out = [];
  (c.hazards || []).forEach(hz => {
    const pts = hz.p.map(f), al = pts.map(p => p.along * M2YD), cr = pts.map(p => p.cross * M2YD);
    const near = Math.min(...al), far = Math.max(...al);
    if (far < 10 || near > gi.center + 25) return;
    const minAbs = Math.min(...cr.map(Math.abs)), straddle = Math.min(...cr) < 0 && Math.max(...cr) > 0;
    if (!straddle && minAbs > 45) return;
    const meanC = avgOf(cr), side = straddle ? '正面(ライン上)' : meanC > 0 ? `右${Math.round(minAbs)}y` : `左${Math.round(minAbs)}y`;
    out.push({ t: hz.t, near: Math.max(0, near), far, label: `${hz.t === 'water' ? '池/水' : 'バンカー'}：${side}、手前まで${Math.round(Math.max(0, near))}y・越えるのに${Math.round(far)}y` });
  });
  return out.sort((a, b) => a.near - b.near).slice(0, 8);
}
function updateDistances() {
  if (!curRound() || $('#round-play').hidden) return;
  const h = curHole(), pos = ui.pos;
  $('#d-gps').textContent = pos ? `GPS ±${Math.round(pos.acc)}m` : 'GPS取得中…';
  $('#d-gps').style.color = pos && pos.acc > 20 ? 'var(--red)' : '';
  const w0 = env.wx;
  $('#d-wx').innerHTML = w0 ? `${WX(w0.code)[0]} ${Math.round(w0.temp)}℃ 湿度${Math.round(w0.hum)}%${w0.pop != null && w0.pop >= 20 ? ` ☔${w0.pop}%` : ''}` : '';
  const gi = greenInfo(pos), rc = curRound(), cond = rc.cond, pin = h && rc.pins && rc.pins[h.n];
  $('#d-pin').innerHTML = h && h.green ? (pin && gi ? `📍<b>ピン${pinLabel(pin)} ${fmt(gi.pin)}</b>` : '📍ピン位置') : '';
  $('#d-cond').textContent = cond && isNum(cond.stimp) ? `🟢${cond.stimp}ft` : '🟢グリーン';
  if (!h || !h.green) {
    $('#d-front').textContent = '—'; $('#d-back').textContent = '—';
    $('#d-center').textContent = '未設定'; $('#d-center').style.fontSize = '26px';
    $('#d-plays').innerHTML = '<span style="color:var(--red)">⋯ からグリーン位置を設定してください</span>'; $('#d-wind').textContent = '';
  } else if (gi) {
    $('#d-center').style.fontSize = '';
    $('#d-center').textContent = fmtN(gi.center);
    $('#d-front').textContent = gi.front != null ? fmtN(gi.front) : '—';
    $('#d-back').textContent = gi.back != null ? fmtN(gi.back) : '—';
    const pl = playsLike(gi.center, gi.bearing), ed = elevDiff();
    $('#d-plays').innerHTML = pl ? `実質 <b>${fmt(pl.d)}</b>${ed != null && Math.abs(ed) >= 2 ? `（${ed > 0 ? '上り' : '下り'}${Math.abs(Math.round(ed))}m）` : ''}` : '';
    const w = windComp(gi.bearing);
    $('#d-wind').textContent = w ? `風${w.speed.toFixed(1)}m/s ${w.head >= 1 ? 'アゲ' : w.head <= -1 ? 'フォロー' : ''}${Math.abs(w.cross) >= 1 ? (w.cross > 0 ? '・右から' : '・左から') : ''}` : '';
  } else { $('#d-center').style.fontSize = ''; ['#d-front', '#d-center', '#d-back'].forEach(s => $(s).textContent = '—'); }
  const ti = $('#target-info');
  if (ui.target && pos) {
    const a = distY(pos, ui.target), b = h && h.green ? distY(ui.target, h.green) : null;
    ti.hidden = false;
    ti.innerHTML = `<span>🎯 ターゲットまで <b>${fmt(a)}</b>${b != null ? `　残り <b>${fmt(b)}</b>` : ''}</span><button class="x-btn" id="clear-target">✕</button>`;
    $('#clear-target').onclick = () => { ui.target = null; mapLayers.target.clearLayers(); updateDistances(); };
    drawTarget();
  } else ti.hidden = true;
  const pi = $('#pending-info'), l = h && lastStroke(((curRound().track || {})[h.n]) || []);
  if (l && !l.end && !l.penalized && pos) { pi.hidden = false; pi.innerHTML = `<span>${l.k}打目 ${esc(clubById(l.clubId)?.name || '')} から <b>${fmt(distY(l.pos, pos))}</b></span><span class="small muted">ボール地点で📏</span>`; }
  else pi.hidden = true;
  $('#topinfo').textContent = curCourse() ? curCourse().name : '';
}
function drawTarget() {
  mapLayers.target.clearLayers(); const h = curHole(); if (!ui.target) return;
  const pts = [ui.pos && [ui.pos.lat, ui.pos.lng], ui.target, h && h.green].filter(Boolean);
  L.polyline(pts, { color: '#facc15', weight: 3, interactive: false }).addTo(mapLayers.target);
  const m = L.circleMarker(ui.target, { radius: 9, color: '#111', weight: 2, fillColor: '#facc15', fillOpacity: 1, interactive: false }).addTo(mapLayers.target);
  if (ui.pos) m.bindTooltip(fmt(distY(ui.pos, ui.target)), { permanent: true, direction: 'top', className: 'map-label', offset: [0, -8] });
}
function onMapTap(e) {
  const p = [e.latlng.lat, e.latlng.lng];
  if (ui.setGreen) {
    const h = curHole(), c = curCourse(), poly = (c.greens || []).find(g => inPoly(p, g));
    h.green = poly ? centroid(poly) : A({ lat: p[0], lng: p[1] }); h.greenPoly = poly || null;
    save(); setGreenMode(false); drawHole(false); updateDistances(); maybeFetchEnv();
    toast(poly ? 'グリーン（形状あり）を設定しました' : 'グリーン中心を設定しました'); return;
  }
  ui.target = p; updateDistances();
}
function setGreenMode(on) { ui.setGreen = on; $('#set-green-banner').hidden = !on; }
$('#cancel-set-green').onclick = () => setGreenMode(false);
$('#d-wx').onclick = $('#d-plays').onclick = $('#d-wind').onclick = () => showWeatherDetail();
$('#d-pin').onclick = () => pinForm();
$('#d-cond').onclick = () => { const r = curRound(); condForm(r.cond, c => { r.cond = c; if (c.day) r.pins = Object.assign({}, r.pins || {}, pinsFromDay(c.day)); const co = curCourse(); if (co) co.lastCond = c; save(); updateDistances(); }, { course: curCourse() }); };
function showWeatherDetail() {
  const w = env.wx, gi = greenInfo(ui.pos);
  if (!w) return toast('気象データを取得中です');
  const pl = gi && playsLike(gi.center, gi.bearing), a = airEffect(), wc = gi && windComp(gi.bearing);
  const row = (l, v) => `<div class="shot-line"><span>${l}</span><b>${v}</b></div>`;
  openModal(`<h2>${WX(w.code)[0]} 現在の気象</h2>
    ${row('天気', WX(w.code)[1])}${row('気温（体感）', `${r1(w.temp)}℃（${r1(w.feels)}℃）`)}${row('湿度', w.hum + '%')}${row('気圧（現地）', Math.round(w.pres) + 'hPa')}
    ${row('風', `${r1(w.speed)}m/s ${dirName(w.dir)}から（最大${r1(w.gust)}m/s）`)}${row('降水', `${w.precip}mm／3時間以内の降水確率 ${w.pop ?? '—'}%`)}
    ${pl ? `<h3>実質距離の内訳（センター ${fmt(gi.center)}）</h3>
      ${row('風' + (wc ? `（${wc.head >= 0 ? 'アゲ' : 'フォロー'}${Math.abs(wc.head).toFixed(1)}m/s）` : ''), (pl.parts.wind >= 0 ? '+' : '') + fmtN(pl.parts.wind) + U())}
      ${row(`気温・気圧（空気の重さ ${a != null ? (a >= 0 ? '飛ぶ ' : '飛ばない ') + Math.abs(r1(a * 100)) + '%' : ''}）`, (pl.parts.air >= 0 ? '+' : '') + fmtN(pl.parts.air) + U())}
      ${row('高低差', (pl.parts.elev >= 0 ? '+' : '') + fmtN(pl.parts.elev) + U())}
      ${row('実質距離', fmt(pl.d))}` : ''}
    <p class="small muted" style="line-height:1.6">気象：Open-Meteo（約10分ごとに更新）。実質距離は一般的な目安による簡易計算です。AIキャディはこれらに加え、雨によるランの減少や体の動きなども考慮して助言します。</p>
    <button class="btn block ghost" onclick="closeModal()">閉じる</button>`);
}

function changeHole(d) {
  const r = curRound(), c = curCourse(); if (!r || !c) return;
  const n = r.hole + d; if (n < 0 || n >= c.holes.length) return;
  r.hole = n; ui.target = null; mapLayers.target.clearLayers(); save(); drawHole(true); updateDistances(); maybeFetchEnv();
}
$('#hole-prev').onclick = () => changeHole(-1);
$('#hole-next').onclick = () => changeHole(1);

$('#round-menu').onclick = () => {
  const h = curHole();
  const el = openModal(`<h2>${h.n}番ホール</h2>
    <button class="btn block light" data-a="prep">🗺 ティー・グリーン位置を編集（手前・奥も）</button>
    <button class="btn block light" data-a="setgreen">👆 地図をタップしてグリーン中央だけ設定</button>
    <div class="grid2"><button class="btn light" data-a="pin">📍 ピン位置</button><button class="btn light" data-a="cond">🟢 グリーン状態</button></div><div style="height:8px"></div>
    <button class="btn block light" data-a="heregreen">📍 現在地をグリーンに設定（グリーン上で）</button>
    <div class="card"><div class="small muted" style="margin-bottom:6px">地図の種類</div><div class="chips">${Object.entries(BASE_LABEL).map(([k, v]) => `<button class="chip ${curBase === k ? 'on' : ''}" data-base="${k}">${v}</button>`).join('')}</div></div>
    <button class="btn block light" data-a="card">📋 スコアカード</button>
    <button class="btn block light" data-a="course">✏️ コース情報（パー・HC・レート）</button>
    <button class="btn block light" data-a="me">🎯 現在地を中心に</button>
    <button class="btn block accent" data-a="end">🏁 ラウンド終了・保存</button>
    <button class="btn block danger" data-a="quit">ラウンドを中断（保存しない）</button>`);
  $$('[data-base]', el).forEach(b => b.onclick = async () => { closeModal(); await setBase(b.dataset.base); if (curBase === b.dataset.base) { db.settings.mapProvider = curBase; save(); } });
  $$('[data-a]', el).forEach(b => b.onclick = async () => {
    const a = b.dataset.a; closeModal();
    if (a === 'setgreen') setGreenMode(true);
    if (a === 'prep') coursePrep(curCourse(), curRound().hole, () => { drawCourse(); drawHole(true); updateDistances(); });
    if (a === 'pin') pinForm();
    if (a === 'cond') $('#d-cond').onclick();
    if (a === 'heregreen') {
      if (!ui.pos) return toast('現在地がまだ取得できていません');
      const c = curCourse(), poly = (c.greens || []).find(g => inPoly(ui.pos, g));
      h.green = poly ? centroid(poly) : A(ui.pos); h.greenPoly = poly || null; save(); drawHole(false); updateDistances(); toast('グリーン位置を登録しました');
    }
    if (a === 'card') openModal(`<h2>スコアカード</h2>${scorecardHTML(curRound())}<button class="btn block ghost" style="margin-top:10px" onclick="closeModal()">閉じる</button>`);
    if (a === 'course') editCourse(curCourse(), () => drawHole(false));
    if (a === 'me' && ui.pos) map.setView([ui.pos.lat, ui.pos.lng], 18);
    if (a === 'end') endRound();
    if (a === 'quit' && await confirmBox('スコアを保存せずにラウンドを中断しますか？', '中断')) { db.activeRound = null; save(); stopPlay(); renderRound(); }
  });
};

/* ---------------- スコア入力・スコアカード ---------------- */
function updateScoreMini() { const r = curRound(); if (!r) return; const st = roundStats(r); $('#score-mini').textContent = st.holes ? `${st.strokes} (${sgn(st.diff)})` : 'スコア'; }
$('#btn-score').onclick = () => renderScoreSheet();
function renderScoreSheet() {
  const r = curRound(), h = curHole(), s = ensureScore(r, h.n), tot = holeScore(s) || 0, st = roundStats(r);
  const step = (label, k) => `<div class="stat-box"><small>${label}</small><div class="stepper sm"><button data-k="${k}" data-d="-1">−</button><b>${s[k] || 0}</b><button data-k="${k}" data-d="1">＋</button></div></div>`;
  const el = openModal(`<div class="spread"><h2>${h.n}番 Par${h.par}${h.si ? ` <span class="small muted">HC${h.si}</span>` : ''}</h2><div style="text-align:right"><span class="big-num">${tot || '—'}</span> <span class="small muted">${tot ? sgn(tot - h.par) : ''}</span></div></div>
    <div class="grid3" style="margin-bottom:10px">${step('ショット', 'shots')}${step('パット', 'putts')}${step('ペナルティ', 'pen')}</div>
    ${h.par >= 4 ? `<div class="spread" style="margin-bottom:10px"><span>ティーショット FWキープ</span><div class="seg" style="width:180px"><button data-fw="1" class="${s.fw === true ? 'on' : ''}">◯</button><button data-fw="0" class="${s.fw === false ? 'on' : ''}">×</button><button data-fw="" class="${s.fw == null ? 'on' : ''}">—</button></div></div>` : ''}
    <p class="small muted" style="margin:0 0 8px">ショット数はGPSでショットを記録すると自動で増えます。パットはここで入力してください。打数＝ショット＋パット＋ペナルティ。</p>
    ${(r.track || {})[h.n] && r.track[h.n].length ? `<div class="card" style="padding:8px 12px">${trackListHTML(r.track[h.n])}</div>` : ''}
    ${scorecardHTML(r)}
    <p style="text-align:center;font-weight:800;font-size:17px;margin:10px 0">合計 ${st.strokes || 0}（${st.holes ? sgn(st.diff) : '±0'}）・パット ${st.putts}・ペナ ${st.pen}</p>
    <div class="grid2"><button class="btn ghost" id="sc-close">閉じる</button><button class="btn" id="sc-next">次のホールへ ▶</button></div>`, () => updateScoreMini());
  $$('[data-k]', el).forEach(b => b.onclick = () => { s[b.dataset.k] = Math.max(0, (s[b.dataset.k] || 0) + +b.dataset.d); save(); renderScoreSheet(); });
  $$('[data-fw]', el).forEach(b => b.onclick = () => { s.fw = b.dataset.fw === '' ? null : b.dataset.fw === '1'; save(); renderScoreSheet(); });
  $('#sc-close', el).onclick = closeModal;
  $('#sc-next', el).onclick = () => { closeModal(); changeHole(1); };
}
function scClass(st, p) { if (!st) return ''; const d = st - p; return d <= -2 ? 'sc-eagle' : d === -1 ? 'sc-birdie' : d === 0 ? 'sc-par' : d === 1 ? 'sc-bogey' : 'sc-double'; }
function scorecardHTML(r, prev) {
  if (r.totalOnly) return `<div class="notice">合計スコアのみの記録です（${r.totalOnly}打${isNum(r.puttsTotal) ? `・パット${r.puttsTotal}` : ''}）。</div>`;
  const ns = Object.keys(r.pars || {}).length ? Object.keys(r.pars).map(Number) : (courseById(r.courseId)?.holes.map(h => h.n) || []);
  ns.sort((a, b) => a - b);
  const cur = curRound() === r && curHole() ? curHole().n : null;
  const part = (arr, label) => {
    if (!arr.length) return '';
    const S = n => (r.scores || {})[n], sum = f => arr.reduce((a, n) => a + (f(n) || 0), 0);
    const tds = (f, tot, cls) => arr.map(n => `<td class="${cls ? cls(n) : ''}${n === cur ? ' cur' : ''}">${f(n) ?? ''}</td>`).join('') + `<td class="tot">${tot ?? ''}</td>`;
    return `<table class="sc"><tr class="h"><td>${label}</td>${arr.map(n => `<td>${n}</td>`).join('')}<td>計</td></tr>
      <tr class="h"><td>Par</td>${tds(n => parOf(r, n), sum(n => parOf(r, n)))}</tr>
      <tr><td>打数</td>${tds(n => holeScore(S(n)), sum(n => holeScore(S(n))) || '', n => scClass(holeScore(S(n)), parOf(r, n)))}</tr>
      <tr class="s"><td>パット</td>${tds(n => S(n) && holeScore(S(n)) && S(n).putts != null ? S(n).putts : '', sum(n => S(n) && S(n).putts) || '')}</tr>
      <tr class="s"><td>ペナ</td>${tds(n => S(n) && S(n).pen ? S(n).pen : '', sum(n => S(n) && S(n).pen) || '')}</tr>
      <tr class="s"><td>FW</td>${tds(n => S(n) && S(n).fw != null ? (S(n).fw ? '◯' : '×') : '', '')}</tr>
      <tr class="s"><td>GIR</td>${tds(n => { const s = S(n), st = holeScore(s); return st && s.putts != null ? (st - s.putts <= parOf(r, n) - 2 ? '◯' : '') : ''; }, '')}</tr>
      ${prev ? `<tr class="s prev"><td>前回</td>${tds(n => holeScore((prev.scores || {})[n]) || '', arr.reduce((a, n) => a + (holeScore((prev.scores || {})[n]) || 0), 0) || '')}</tr>` : ''}
    </table>`;
  };
  return `<div class="scroll-x">${part(ns.filter(n => n <= 9), 'OUT')}${part(ns.filter(n => n > 9), 'IN')}</div>`;
}

/* ---------------- ラウンド終了・総評・前回比較 ---------------- */
function prevRoundOnCourse(rec) {
  return db.rounds.filter(r => r.courseId === rec.courseId && r.id !== rec.id && new Date(r.date) < new Date(rec.date)).sort((a, b) => new Date(b.date) - new Date(a.date))[0] || null;
}
function endRound() {
  const r = curRound(), c = curCourse();
  const rec = { id: r.id, courseId: c.id, courseName: c.name, date: r.date, scores: r.scores, track: r.track || {}, pars: Object.fromEntries(c.holes.map(h => [h.n, h.par])), sis: Object.fromEntries(c.holes.filter(h => h.si).map(h => [h.n, h.si])), rating: c.rating || null, slope: c.slope || null, weather: r.weather || env.wx || null, cond: r.cond || null, pins: r.pins || {} };
  db.rounds.push(rec); db.activeRound = null; save(); stopPlay();
  const st = roundStats(rec), prev = prevRoundOnCourse(rec), ps = prev && roundStats(prev), hh = handicapHistory(), e = hh.out.find(x => x.r.id === rec.id);
  const el = openModal(`<h2>お疲れさまでした！</h2>
    <div style="text-align:center"><span class="big-num">${st.strokes || '—'}</span> <span style="font-size:18px">(${sgn(st.diff)})</span><div class="muted">パット ${st.putts}・ペナルティ ${st.pen}${st.fwPct != null ? `・FW ${st.fwPct}%` : ''}${st.girPct != null ? `・パーオン ${st.girPct}%` : ''}</div></div>
    ${ps ? `<div class="notice" style="margin-top:10px">前回（${new Date(prev.date).toLocaleDateString('ja-JP')}）は ${ps.strokes}。今回は <b>${st.strokes - ps.strokes === 0 ? '同スコア' : (st.strokes < ps.strokes ? (ps.strokes - st.strokes) + '打 良化 🎉' : (st.strokes - ps.strokes) + '打 悪化')}</b></div>` : ''}
    ${e && e.d ? `<p style="text-align:center">スコア差（DF） <b>${e.d.diff}</b>${e.d.estimated ? '（推定）' : ''}　ハンディキャップ指数 <b>${e.hiAfter != null ? e.hiAfter.toFixed(1) : '—'}</b></p>` : ''}
    <button class="btn block" id="rv">🤖 詳細・AIの総評を見る</button><button class="btn block ghost" id="cl">閉じる</button>`, () => renderRound());
  $('#rv', el).onclick = () => { modalOnClose = null; closeModal(); renderRound(); showRoundDetail(rec, true); };
  $('#cl', el).onclick = closeModal;
}
function showRoundDetail(rec, autoAI) {
  if (!rec) return;
  const st = roundStats(rec), prev = prevRoundOnCourse(rec), ps = prev && roundStats(prev);
  const others = db.rounds.filter(r => r.courseId === rec.courseId && r.id !== rec.id), best = others.map(roundStats).filter(x => x.holes === st.holes).sort((a, b) => a.strokes - b.strokes)[0];
  const e = handicapHistory().out.find(x => x.r.id === rec.id), w = rec.weather;
  const box = (l, v) => `<div class="stat-box"><small>${l}</small><b>${v}</b></div>`;
  const cmp = (l, a, b, lowerBetter = true, unit = '') => { const d = a != null && b != null ? a - b : null; const good = d != null && d !== 0 && ((d < 0) === lowerBetter); return `<tr><td>${l}</td><td><b>${a ?? '—'}${a != null ? unit : ''}</b></td><td>${b ?? '—'}${b != null ? unit : ''}</td><td style="color:${d ? (good ? '#15803d' : '#dc2626') : ''}">${d != null ? (d > 0 ? '+' : '') + (Math.round(d * 10) / 10) : ''}</td></tr>`; };
  const shotsHTML = Object.keys(rec.track || {}).filter(n => rec.track[n].length).sort((a, b) => a - b).map(n => `<div style="margin-bottom:6px"><b>${n}番</b>（${holeScore(rec.scores[n]) || '-'}打）${trackListHTML(rec.track[n])}</div>`).join('');
  const el = openModal(`<h2>${esc(rec.courseName)}</h2><div class="small muted" style="margin-top:-6px">${new Date(rec.date).toLocaleDateString('ja-JP')}${w ? `・${WX(w.code)[0]}${WX(w.code)[1]} ${Math.round(w.temp)}℃ 風${r1(w.speed)}m/s` : ''}</div>
    <div class="grid3" style="margin:10px 0">${box('スコア', `${st.strokes} <small>(${sgn(st.diff)})</small>`)}${box('パット', st.putts)}${box('スコア差 DF', e && e.d ? e.d.diff : '—')}</div>
    ${scorecardHTML(rec, prev)}
    <h3>スタッツ</h3><div class="grid3">
      ${box('平均パット', st.puttHoles ? (st.putts / st.puttHoles).toFixed(2) : '—')}${box('3パット', st.three)}${box('ペナルティ', st.pen)}
      ${box('FWキープ', st.fwPct != null ? st.fwPct + '%' : '—')}${box('パーオン', st.girPct != null ? st.girPct + '%' : '—')}${box('バーディ以上', st.kinds.birdie + st.kinds.eagle)}
      ${box('Par3平均', st.par3 ? st.par3.toFixed(2) : '—')}${box('Par4平均', st.par4 ? st.par4.toFixed(2) : '—')}${box('Par5平均', st.par5 ? st.par5.toFixed(2) : '—')}
      ${box('パー', st.kinds.par)}${box('ボギー', st.kinds.bogey)}${box('ダボ以上', st.kinds.double + st.kinds.worse)}</div>
    ${ps ? `<h3>前回（${new Date(prev.date).toLocaleDateString('ja-JP')}）との比較</h3><div class="card"><table class="t"><tr><th></th><th>今回</th><th>前回</th><th>差</th></tr>
      ${cmp('スコア', st.strokes, ps.strokes)}${cmp('パット', st.putts, ps.putts)}${cmp('ペナルティ', st.pen, ps.pen)}${cmp('FWキープ', st.fwPct, ps.fwPct, false, '%')}${cmp('パーオン', st.girPct, ps.girPct, false, '%')}${cmp('3パット', st.three, ps.three)}</table>
      ${best ? `<div class="small muted" style="margin-top:6px">このコースのベスト（他ラウンド）: ${best.strokes}　／　このコース ${others.length + 1}回目</div>` : ''}</div>` : '<p class="small muted">このコースの過去ラウンドがあると、前回との比較が表示されます。</p>'}
    ${shotsHTML ? `<details class="card"><summary><b>ショット記録（GPS）</b></summary><div style="margin-top:8px">${shotsHTML}</div></details>` : ''}
    <h3>🤖 AIの総評</h3><div id="rv-ai">${rec.ai ? `<div class="ai-answer">${esc(rec.ai)}</div>` : '<p class="small muted">前回との比較・ホール別の内容・気象をふまえて総評します。</p>'}</div>
    <button class="btn block accent" id="rv-go">${rec.ai ? 'もう一度総評してもらう' : 'AIに総評してもらう'}</button>
    <div class="grid3"><button class="btn ghost" onclick="closeModal()">閉じる</button><button class="btn light" id="rv-edit">✏️ 編集</button><button class="btn danger" id="rv-del">削除</button></div>`);
  $('#rv-edit', el).onclick = () => { closeModal(); const c = courseById(rec.courseId) || courseFromRec(rec); rec.totalOnly ? totalOnlyForm(c, null, rec) : scoreGridForm({ course: c, rec }); };
  $('#rv-go', el).onclick = () => reviewRound(rec);
  $('#rv-del', el).onclick = async () => { closeModal(); if (await confirmBox('このラウンド記録を削除しますか？', '削除')) { db.rounds = db.rounds.filter(r => r.id !== rec.id); db.shots = db.shots.filter(s => s.roundId !== rec.id); save(); renderRound(); } };
  if (autoAI && !rec.ai) reviewRound(rec);
}
function roundText(r) {
  const st = roundStats(r);
  const holes = Object.keys(r.pars || r.scores || {}).map(Number).sort((a, b) => a - b).map(n => {
    const s = (r.scores || {})[n]; if (!holeScore(s)) return null;
    const tr = (r.track || {})[n] || [];
    const shots = tr.map(x => x.pen ? `[${x.pen} +1]` : `${clubById(x.clubId)?.name || '?'}${x.lie ? '(' + x.lie + 'から)' : ''}${x.dist != null ? ' ' + Math.round(x.dist) + 'y' : ''}${x.endLie ? '→' + x.endLie : ''}`).join(' / ');
    return `${n}番 Par${parOf(r, n)}${r.sis && r.sis[n] ? ' HC' + r.sis[n] : ''}: ${holeScore(s)}打（パット${s.putts ?? '?'}${s.pen ? ' ペナ' + s.pen : ''}${s.fw != null ? ' FW' + (s.fw ? '◯' : '×') : ''}）${shots ? ' ショット: ' + shots : ''}`;
  }).filter(Boolean).join('\n');
  const w = r.weather;
  return `日付: ${new Date(r.date).toLocaleDateString('ja-JP')}\n合計: ${st.strokes}（パー${st.par}に対し${sgn(st.diff)}）パット${st.putts} 3パット${st.three} ペナルティ${st.pen} FWキープ${st.fwPct ?? '-'}% パーオン${st.girPct ?? '-'}% Par3平均${st.par3 ? st.par3.toFixed(2) : '-'} Par4平均${st.par4 ? st.par4.toFixed(2) : '-'} Par5平均${st.par5 ? st.par5.toFixed(2) : '-'}\n${w ? `気象: ${WX(w.code)[1]} ${isNum(w.temp) ? Math.round(w.temp) + '℃' : ''} ${isNum(w.hum) ? '湿度' + w.hum + '%' : ''} 風${r1(w.speed)}m/s(${dirName(w.dir)}から${isNum(w.gust) ? ' 最大' + r1(w.gust) : ''})\n` : ''}${r.cond ? `コンディション: ティー${r.cond.tee || '-'}、グリーン${isNum(r.cond.stimp) ? r.cond.stimp + 'ft(' + speedLabel(r.cond.stimp) + ')' : '不明'}、硬さ${r.cond.firm || '-'}${r.cond.memo ? '、メモ:' + r.cond.memo : ''}\n` : ''}ホール別:\n${holes}`;
}
async function reviewRound(rec) {
  const box = $('#rv-ai'); if (box) box.innerHTML = '<div class="ai-answer muted">AIが分析中…（20〜40秒ほど）</div>';
  const prevs = db.rounds.filter(r => r.courseId === rec.courseId && r.id !== rec.id && new Date(r.date) < new Date(rec.date)).sort((a, b) => new Date(b.date) - new Date(a.date));
  const holeAvg = Object.keys(rec.pars || {}).map(n => { const a = prevs.map(r => holeScore((r.scores || {})[n])).filter(isNum); return a.length ? `${n}番:${avgOf(a).toFixed(1)}` : null; }).filter(Boolean).join(' ');
  const hh = handicapHistory(), e = hh.out.find(x => x.r.id === rec.id);
  try {
    const ans = await callClaude({
      system: 'あなたはツアー経験豊富なキャディ兼ゴルフコーチです。日本語で、データを根拠に具体的かつ前向きに総評します。見出しは【】で短く付け、箇条書き中心で700字程度。',
      maxTokens: 1800,
      text: `${rec.courseName} のラウンドを総評してください。\n\n■今回のラウンド\n${roundText(rec)}\n\n■このコースの過去ラウンド（新しい順）\n${prevs.length ? prevs.slice(0, 5).map(r => { const s = roundStats(r); return `${new Date(r.date).toLocaleDateString('ja-JP')}: ${s.strokes}（パット${s.putts} ペナ${s.pen} FW${s.fwPct ?? '-'}% パーオン${s.girPct ?? '-'}%）`; }).join('\n') : 'なし（初めてのコース）'}\n${prevs.length ? `\n■前回のホール別詳細\n${roundText(prevs[0])}\n\n■過去のホール別平均打数\n${holeAvg}` : ''}\n\n■ハンディキャップ\nこのラウンドのスコア差: ${e && e.d ? e.d.diff : '算出対象外'}／現在のハンディキャップ指数(目安): ${hh.hi ?? '未算出'}\n\n■クラブ別飛距離\n${bagSummaryForAI()}\n\n次の構成で: 【総評】全体の評価をひとこと／【良かった点】／【スコアを落とした原因】データ根拠つき／【前回との比較】（初回なら省略）／【このコースの攻略メモ】次回注意すべきホールと狙い方を3つ／【練習テーマ】3つ`
    });
    rec.ai = ans; save();
    if ($('#rv-ai')) { $('#rv-ai').innerHTML = `<div class="ai-answer">${esc(ans)}</div>`; $('#rv-go').textContent = 'もう一度総評してもらう'; }
    if (ui.tab === 'round' && !curRound()) { /* 履歴にバッジを反映 */ }
  } catch (err) { if ($('#rv-ai')) $('#rv-ai').innerHTML = `<div class="notice">${esc(err.message)}</div>`; }
}

/* ---------------- AIキャディ ---------------- */
function holeHistoryText(courseId, n) {
  const rs = db.rounds.filter(r => r.courseId === courseId && holeScore((r.scores || {})[n]));
  if (!rs.length) return null;
  const a = rs.map(r => holeScore(r.scores[n]));
  const tee = rs.map(r => { const t = ((r.track || {})[n] || []).find(x => x.k === 1); return t ? `${clubById(t.clubId)?.name || '?'}${t.endLie ? '→' + t.endLie : ''}${t.penalized ? '(ペナ)' : ''}` : null; }).filter(Boolean);
  return `過去${rs.length}回 平均${avgOf(a).toFixed(1)}打（ベスト${Math.min(...a)}・ワースト${Math.max(...a)}）${tee.length ? `、過去のティーショット: ${tee.slice(-5).join(', ')}` : ''}`;
}
function caddieContext() {
  const r = curRound(), c = curCourse(), h = curHole(), pos = ui.pos;
  const lines = [`コース: ${c.name} / ${h.n}番ホール Par${h.par}${h.si ? `（ハンディキャップ${h.si}番目に難しい）` : ''}`];
  const s = (r.scores || {})[h.n], tr = (r.track || {})[h.n] || [];
  lines.push(`このホールの状況: ${s ? `ショット${s.shots || 0}・ペナルティ${s.pen || 0}` : 'これからティーショット'}${tr.length ? '｜記録: ' + tr.map(x => x.pen ? `[${x.pen}]` : `${x.k}打目${clubById(x.clubId)?.name || ''}${x.dist != null ? ' ' + Math.round(x.dist) + 'y' : ''}`).join(', ') : ''}`);
  const done = { ...r, scores: Object.fromEntries(Object.entries(r.scores || {}).filter(([n]) => String(n) !== String(h.n))) }, t = roundStats(done);
  if (t.holes) lines.push(`前のホールまで: ${t.strokes}（${sgn(t.diff)}）パット${t.putts}`);
  const hi = currentHI(); if (hi != null) { const par = c.holes.reduce((a, x) => a + x.par, 0), ch = courseHandicap(hi, c.slope || 113, c.rating || par, par); lines.push(`ハンディキャップ指数${hi}（このコースのHC約${ch}${h.si ? `、このホールの受けハンデ${strokesReceived(ch, h.si)}打` : ''}）`); }
  lines.push(pos ? `GPS精度: ±${Math.round(pos.acc)}m／現在地のライ（地図判定）: ${lieAt(pos) || '不明'}` : '現在地: GPS未取得');
  const gi = greenInfo(pos);
  if (gi) {
    lines.push(`グリーンまで: センター${Math.round(gi.center)}y` + (gi.front != null ? `、手前エッジ${Math.round(gi.front)}y、奥エッジ${Math.round(gi.back)}y` : ''));
    const w = windComp(gi.bearing); if (w) lines.push(`風: ${w.speed.toFixed(1)}m/s（${dirName(w.dir)}から、最大瞬間${w.gust ? w.gust.toFixed(1) : '?'}m/s）→ ${w.head >= 0 ? 'アゲンスト' : 'フォロー'}成分${Math.abs(w.head).toFixed(1)}m/s、${w.cross >= 0 ? '右から左へ' : '左から右へ'}の横風${Math.abs(w.cross).toFixed(1)}m/s`);
    const ed = elevDiff(); if (ed != null) lines.push(`高低差(地形データの目安): グリーンが${ed >= 0 ? '高い' : '低い'} 約${Math.abs(Math.round(ed))}m`);
    const pl = playsLike(gi.center, gi.bearing); if (pl) lines.push(`実質距離(簡易計算): 約${Math.round(pl.d)}y（内訳 風${Math.round(pl.parts.wind)} / 気温・気圧${Math.round(pl.parts.air)} / 高低差${Math.round(pl.parts.elev)}）`);
    const hz = hazardsAhead(pos, gi); lines.push('前方のハザード（打つ方向基準）: ' + (hz.length ? '\n- ' + hz.map(x => x.label).join('\n- ') : '地図データ上は特になし（未登録の可能性あり）'));
  } else lines.push('グリーン位置: 未設定のため距離不明');
  const wx = env.wx;
  if (wx) {
    const a = airEffect(), parts = [];
    if (wx.code != null) parts.push(WX(wx.code)[1]);
    if (isNum(wx.temp)) parts.push(`気温${r1(wx.temp)}℃` + (isNum(wx.feels) ? `（体感${r1(wx.feels)}℃）` : ''));
    if (isNum(wx.hum)) parts.push(`湿度${wx.hum}%`);
    if (isNum(wx.pres)) parts.push(`気圧${Math.round(wx.pres)}hPa`);
    if (isNum(wx.precip)) parts.push(`現在の降水${wx.precip}mm`);
    if (isNum(wx.pop)) parts.push(`3時間以内の降水確率${wx.pop}%`);
    if (a != null) parts.push(`空気密度による飛距離の変化 ${a >= 0 ? '+' : ''}${r1(a * 100)}%`);
    lines.push('気象: ' + parts.join('、'));
  }
  if (ui.target && pos) lines.push(`プレーヤーが地図で指定した狙い所: 現在地から${Math.round(distY(pos, ui.target))}y` + (h.green ? `、そこからグリーンまで${Math.round(distY(ui.target, h.green))}y` : ''));
  if (h.tee && pos) lines.push(`ティーからの距離: ${Math.round(distY(h.tee, pos))}y`);
  const cd = r.cond;
  if (cd) lines.push(`使用ティー: ${cd.tee || '不明'}／グリーンスピード: ${isNum(cd.stimp) ? `${cd.stimp}フィート（${speedLabel(cd.stimp)}）` : '不明'}／グリーンの硬さ: ${cd.firm || '不明'}${cd.memo ? `／メモ: ${cd.memo}` : ''}`);
  const pn = r.pins && r.pins[h.n];
  if (gi) lines.push(pn ? `ピン位置: ${pinLabel(pn)}（ピンまで推定${Math.round(gi.pin)}y）` : 'ピン位置: 未入力（センターと仮定）');
  if (h.tee && h.green) lines.push(`ホールの長さ(地図上のティー〜グリーン中央): 約${Math.round(distY(h.tee, h.green))}y`);
  lines.push(`グリーンの傾斜: ${slopeText(h) || '未登録（不明）'}`);
  const dh = cd && cd.day && cd.day.holes && cd.day.holes[h.n];
  if (dh) lines.push(`本日の表示（ティー・ピン位置表より）: ${isNum(dh.yards) ? `本日のホール距離${dh.yards}y` : ''}${dh.teeNote ? `、ティー位置: ${dh.teeNote}` : ''}${dh.pinNote ? `、ピン: ${dh.pinNote}` : ''}`);
  const hist = holeHistoryText(c.id, h.n); if (hist) lines.push(`このホールの過去データ: ${hist}`);
  const today = db.shots.filter(x => x.roundId === r.id).map(x => `${clubById(x.clubId)?.name || '?'}:${Math.round(x.total)}y`);
  if (today.length) lines.push('今日のGPS実測ショット: ' + today.join(', '));
  lines.push('\nプレーヤーのクラブと飛距離（練習・計測データ）:\n' + bagSummaryForAI());
  return lines.join('\n');
}
const CADDIE_SYSTEM = `あなたはツアー経験豊富なプロキャディです。プレー中のゴルファーに日本語で助言します。
- 回答は音声で読み上げられるので、2〜4文・160字程度で簡潔に。記号や箇条書きは使わない。
- 最初に結論（推奨番手と狙い所）、次に短い理由。
- 必ず気象を考慮する：風（突風も）、気温（寒いとボールも体も飛ばない、暑いと飛ぶ）、気圧・標高による空気の重さ、雨（ランが減る・グリップ・ラフからのフライヤー）、降水確率。実質距離の簡易計算は参考にし、最終判断はプロとして行う。
- 必ずグリーンの状態を考慮する：速い・硬いグリーンは止まりにくいので手前から転がす・奥のピンでもオーバー厳禁・下りのパットを残さない位置へ。遅い・柔らかいグリーンはピンまでキャリーで攻められる。ピン位置（手前・奥・左右）とハザード、グリーンの傾斜の関係で、上りのパットが残る安全サイドを示す。パットの質問には、グリーンスピードに合わせたタッチ（強さ）を具体的に助言する。
- 本人の実測飛距離とばらつき・左右の傾向、今日の実測、このホールの過去の結果を重視し、大叩きを避けるマネジメントを基本にする。受けハンデがあるホールでは無理をしない選択肢も示す。
- データにないこと（ライの細かい状態、ピン位置など）は「〜なら」と条件付きで触れる程度にする。`;
$('#btn-caddie').onclick = () => openCaddie();
function openCaddie(prefill = '') {
  if (db.settings.competition) { toast('競技モード中はAIアドバイスを使えません（設定で切替）', 3500); return; }
  const el = openModal(`<h2>🎤 AIキャディ</h2>
    <div class="chips" style="margin-bottom:10px">${['何番で打つ？', 'どこを狙う？', 'このホールの攻め方は？', 'レイアップすべき？', '風と気温の影響は？', 'パットはどう打つ？'].map(q => `<button class="chip" data-q="${q}">${q}</button>`).join('')}</div>
    <div class="row"><textarea id="cq" rows="2" class="grow" style="padding:10px;border:1px solid #cfd6d2;border-radius:10px" placeholder="例: ライが左足下がり。何番がいい？">${esc(prefill)}</textarea>
    <button class="btn" id="cmic" style="height:56px;width:56px;font-size:22px">🎤</button></div>
    <button class="btn block" id="cask" style="margin-top:10px">キャディに聞く</button><div id="cans"></div>`, () => stopSpeak());
  const ask = async q => {
    const box = $('#cans', el); if (!box) return;
    box.innerHTML = '<div class="ai-answer muted">考え中…</div>';
    if (!env.wx) await maybeFetchEnv();
    try {
      const ans = await callClaude({ system: CADDIE_SYSTEM, text: `状況:\n${caddieContext()}\n\nゴルファーの質問: ${q || '次のショットのアドバイスをください'}`, maxTokens: 600 });
      if (!$('#cans')) return;
      $('#cans').innerHTML = `<div class="ai-answer">${esc(ans)}</div><div class="row" style="margin-top:8px"><button class="btn small light" id="crep">🔊 もう一度</button><button class="btn small ghost" id="cstop">⏹ 停止</button></div>`;
      $('#crep').onclick = () => speak(ans); $('#cstop').onclick = stopSpeak; speak(ans);
    } catch (e) { if ($('#cans')) $('#cans').innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $$('[data-q]', el).forEach(b => b.onclick = () => { $('#cq', el).value = b.dataset.q; ask(b.dataset.q); });
  $('#cask', el).onclick = () => ask($('#cq', el).value.trim());
  $('#cmic', el).onclick = async () => { const t = await listen(); if (t && $('#cq')) { $('#cq').value = t; ask(t); } };
}


/* ---------------- コース検索（OpenStreetMap / Nominatim） ---------------- */
async function nominatimSearch(q) {
  let r;
  try { r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=15&accept-language=ja&q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } }); }
  catch (e) { throw new Error('検索サービスに接続できませんでした（通信状況を確認してください）'); }
  if (!r.ok) throw new Error('検索に失敗しました（' + r.status + '）。少し待ってからお試しください');
  return r.json();
}
function searchCourseFlow(onDone, initial = '') {
  const el = openModal(`<h2>🔍 コースを検索</h2>
    <div class="row"><input id="cs-q" class="grow" value="${esc(initial)}" placeholder="例: 〇〇カントリー倶楽部" style="padding:11px;border:1px solid #cfd6d2;border-radius:10px;font-size:15px"><button class="btn" id="cs-go">検索</button></div>
    <div id="cs-res" style="margin-top:10px"><p class="small muted">ゴルフ場の名前の一部でも検索できます（OpenStreetMapのデータ）。</p></div>
    <button class="btn block ghost" id="cs-manual" style="margin-top:6px">見つからない場合：名前を入れて手動で作成</button>`);
  const go = async () => {
    const q = $('#cs-q', el).value.trim(); if (!q) return;
    const box = $('#cs-res', el); box.innerHTML = '<p class="muted small">検索中…</p>';
    try {
      let res = await nominatimSearch(q), golf = res.filter(x => x.type === 'golf_course');
      if (!golf.length && !/ゴルフ|golf|カントリー|CC|GC/i.test(q)) { res = await nominatimSearch(q + ' ゴルフ'); golf = res.filter(x => x.type === 'golf_course'); }
      const list = golf.length ? golf : res.filter(x => x.boundingbox);
      if (!$('#cs-res')) return;
      if (!list.length) { box.innerHTML = '<div class="notice">見つかりませんでした。別の言い方（「カントリー」「CC」を外す等）で試すか、手動で作成してください。</div>'; return; }
      box.innerHTML = list.slice(0, 12).map((x, i) => `<div class="list-item"><div class="grow"><b>${esc(x.name || x.display_name.split(',')[0])}</b><div class="small muted">${esc(x.display_name.split(',').slice(1, 4).join(','))}${x.type === 'golf_course' ? '' : '（ゴルフ場以外の可能性）'}</div></div><button class="btn small" data-i="${i}">読み込む</button></div>`).join('');
      $$('[data-i]', box).forEach(b => b.onclick = async () => {
        const x = list[+b.dataset.i], bb = x.boundingbox.map(Number), name = x.name || x.display_name.split(',')[0];
        const ex = db.courses.find(c => c.name === name);
        if (ex) { closeModal(); toast('保存済みのコースを使います'); onDone && onDone(ex); return; }
        closeModal();
        const c = await importOsmCourse({ name, bounds: { minlat: bb[0], maxlat: bb[1], minlon: bb[2], maxlon: bb[3] } }, { ask: false });
        if (c && onDone) onDone(c);
      });
    } catch (e) { if ($('#cs-res')) box.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $('#cs-go', el).onclick = go;
  $('#cs-q', el).onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#cs-manual', el).onclick = () => { const nm = $('#cs-q', el).value.trim(); closeModal(); createCourseForm({ name: nm, btn: '作成', onCreated: c => onDone && onDone(c) }); };
  if (initial) go();
}


/* ---------------- 本日のティー・ピン位置表の読み取り ---------------- */
function dayInfoSummary(d) {
  const hs = Object.values(d.holes || {});
  const nPin = hs.filter(h => isNum(h.pinFromFront) || h.pinDepth).length, nYd = hs.filter(h => isNum(h.yards)).length;
  return `✅ 読み取り済み：${hs.length}ホール（距離 ${nYd}・ピン位置 ${nPin}）${isNum(d.stimp) ? `・グリーン ${d.stimp}ft` : ''}${d.tee ? `・${esc(d.tee)}ティー` : ''}`;
}
function pinsFromDay(day) {
  const out = {}; if (!day || !day.holes) return out;
  Object.values(day.holes).forEach(h => {
    if (!isNum(h.n)) return;
    const s = ['left', 'right', 'center'].includes(h.pinSide) ? h.pinSide : 'center';
    if (isNum(h.pinFromFront)) out[h.n] = { d: h.pinDepth || 'center', s, fromFront: h.pinFromFront, fromSide: isNum(h.pinFromSide) ? h.pinFromSide : null };
    else if (['front', 'center', 'back'].includes(h.pinDepth)) out[h.n] = { d: h.pinDepth, s };
  });
  return out;
}
async function readDaySheet(course, teeHint) {
  const files = await pickFiles('#file-images'); if (!files.length) return null;
  try {
    showLoading(`画像を準備中…（${files.length}枚）`);
    const imgs = []; for (const f of files.slice(0, 8)) imgs.push(await fileToJpegB64(f, 2000, 0.88));
    showLoading('AIがティー・ピン位置を読み取り中…');
    const txt = await callClaude({
      system: 'あなたはゴルフ場の掲示物（本日のピン位置表・ティー位置表・スコアカードのヤーデージ）を正確に読み取るアシスタントです。JSONのみを出力します。',
      images: imgs, maxTokens: 5000,
      text: `画像（${imgs.length}枚）は、ゴルフ場でラウンド前に掲示・配布される「本日のティー位置・ピン位置」の表、ピンポジションシート、グリーンの図、またはスコアカードのヤーデージ欄です。複数枚の場合は前半・後半などの続きです。
プレーヤーの使用ティーは「${teeHint || '不明'}」です（ティーの色やバック/レギュラー/フロント/レディースの表記がある場合は、それに該当する列を使う）。
次の形式のJSONだけを返してください。
{"course":"コース名|null","tee":"バック|レギュラー|フロント|レディース|null（使用ティーに対応する表記）","stimp":本日のグリーンスピード(フィート)|null,
 "holes":[{"n":ホール番号,"par":数値|null,"yards":使用ティーからの本日の距離(ヤード)|null,"teeNote":"ティー位置の補足（例: 前方、+10y、後方 など）|null",
   "pinFromFront":グリーン手前エッジからピンまでの距離(ヤード)|null,"pinSide":"left|center|right|null","pinFromSide":左右エッジからの距離(ヤード)|null,"pinDepth":"front|center|back|null","pinNote":"ピン位置の説明（例: 奥・右、手前から25y左から5y）|null","greenSlope":"グリーン図に傾斜の矢印・等高線・段の記載があればその説明（例: 奥から手前への下り、2段）|null"}]}
ルール: ピンポジションの図（グリーンの絵に●印）の場合は、印の位置から手前/中/奥(pinDepth)と左/中/右(pinSide)を判断する。「15/5」「F15 L5」のような数字は手前から15y・左から5yの意味として読む（左右の数字はどちらの端からかに合わせて pinSide を left/right にする）。メートル表記はヤードに換算（×1.094）。読めない値はnull。`
    });
    hideLoading();
    const d = parseJSON(txt), holes = {};
    (d.holes || []).forEach(h => { if (isNum(h.n)) holes[h.n] = h; });
    if (!Object.keys(holes).length) { toast('ティー・ピン位置を読み取れませんでした。表全体がはっきり写るように撮影してください', 5000); return null; }
    // パーが読めていればコースにも反映（未設定のものだけ）
    if (course && !course._virtual) { Object.values(holes).forEach(h => { const ch = course.holes.find(x => x.n === h.n); if (!ch) return; if (isNum(h.par) && !ch.green && !ch.tee) ch.par = h.par; if (h.greenSlope && !ch.slopeMemo) ch.slopeMemo = h.greenSlope; }); save(); }
    toast(`${Object.keys(holes).length}ホール分を読み取りました`, 3000);
    return { holes, stimp: isNum(d.stimp) ? d.stimp : null, tee: d.tee || null, at: Date.now() };
  } catch (e) { hideLoading(); toast(e.message, 5000); return null; }
}

/* ---------------- スコア分析（統計タブ） ---------------- */
function scoreTrendSVG(F) {
  if (F.length < 2) return '<p class="small muted">18ホールのラウンドが2回以上になると推移グラフが表示されます。</p>';
  const W = 330, H = 180, pl = 30, pr = 10, pt = 12, pb = 26, ys = F.map(x => x.s.strokes);
  const lo = Math.floor((Math.min(...ys) - 3) / 5) * 5, hi = Math.ceil((Math.max(...ys) + 3) / 5) * 5;
  const sx = i => pl + i * (W - pl - pr) / (F.length - 1), sy = v => pt + (hi - v) / ((hi - lo) || 1) * (H - pt - pb);
  const ma = F.map((x, i) => avgOf(ys.slice(Math.max(0, i - 4), i + 1)));
  const grid = []; for (let v = lo; v <= hi; v += (hi - lo) > 30 ? 10 : 5) grid.push(v);
  const lbl = i => { const d = new Date(F[i].r.date); return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}`; };
  const xl = [...new Set([0, Math.floor((F.length - 1) / 2), F.length - 1])];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    ${grid.map(v => `<line x1="${pl}" x2="${W - pr}" y1="${sy(v)}" y2="${sy(v)}" stroke="#e3e7e4"/><text x="2" y="${sy(v) + 4}" font-size="10" fill="#6b7570">${v}</text>`).join('')}
    <polyline fill="none" stroke="#86efac" stroke-width="2" points="${ys.map((v, i) => `${sx(i)},${sy(v)}`).join(' ')}"/>
    <polyline fill="none" stroke="#14532d" stroke-width="2.5" points="${ma.map((v, i) => `${sx(i)},${sy(v)}`).join(' ')}"/>
    ${F.map((x, i) => `<circle cx="${sx(i)}" cy="${sy(x.s.strokes)}" r="${F.length > 30 ? 3.5 : 5}" fill="${x.s.strokes === Math.min(...ys) ? '#f59e0b' : '#16a34a'}" stroke="#fff" stroke-width="1.5" data-rd="${x.r.id}" style="cursor:pointer"/>`).join('')}
    ${xl.map(i => `<text x="${sx(i)}" y="${H - 6}" font-size="10" fill="#6b7570" text-anchor="${i === 0 ? 'start' : i === F.length - 1 ? 'end' : 'middle'}">${lbl(i)}</text>`).join('')}
  </svg><div class="small muted">点＝各ラウンド（オレンジ＝ベスト・タップで詳細）、濃い線＝直近5ラウンドの平均</div>`;
}
function renderScoreStats(el, seg) {
  const all = [...db.rounds].sort((a, b) => new Date(a.date) - new Date(b.date));
  const courses = [...new Map(all.map(r => [r.courseId, r.courseName])).entries()];
  if (ui.scoreCourse && !courses.some(([id]) => id === ui.scoreCourse)) ui.scoreCourse = '';
  const rs = ui.scoreCourse ? all.filter(r => r.courseId === ui.scoreCourse) : all;
  const S = rs.map(r => ({ r, s: roundStats(r) })), F = S.filter(x => x.s.holes >= 18), H = F.filter(x => !x.s.totalOnly);
  if (!all.length) {
    el.innerHTML = seg + `<div class="card"><p>まだラウンドの記録がありません。</p><button class="btn block" id="sc-past">📝 過去のスコアを入力（スクショ・写真もOK）</button></div>`;
    $('#sc-past', el).onclick = () => pastScoreFlow(); return;
  }
  const av = (arr, f) => { const v = arr.map(f).filter(isNum); return v.length ? avgOf(v) : null; };
  const f1 = v => v == null ? '—' : (Math.round(v * 10) / 10).toString();
  const best = F.length ? F.reduce((a, b) => a.s.strokes <= b.s.strokes ? a : b) : null;
  const last5 = F.slice(-5), prev5 = F.slice(-10, -5), hi = handicapHistory().hi;
  const box = (l, v, sub = '') => `<div class="stat-box"><small>${l}</small><b>${v}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const per = x => x.s.puttHoles >= 18 ? x.s.putts * 18 / x.s.puttHoles : null;
  const row = (l, f, lowerBetter = true, unit = '') => { const a = av(last5, f), b = av(prev5, f), d = a != null && b != null ? a - b : null, good = d != null && Math.abs(d) >= 0.05 && ((d < 0) === lowerBetter); return `<tr><td>${l}</td><td><b>${f1(a)}${a != null ? unit : ''}</b></td><td>${f1(b)}${b != null ? unit : ''}</td><td style="color:${d != null && Math.abs(d) >= 0.05 ? (good ? '#15803d' : '#dc2626') : ''}">${d != null ? (d > 0 ? '+' : '') + f1(d) : ''}</td></tr>`; };
  const kinds = { eagle: 0, birdie: 0, par: 0, bogey: 0, double: 0, worse: 0 }; H.forEach(x => Object.keys(kinds).forEach(k => kinds[k] += x.s.kinds[k]));
  const kt = Object.values(kinds).reduce((a, b) => a + b, 0);
  const KC = { eagle: ['イーグル↑', '#facc15'], birdie: ['バーディ', '#f87171'], par: ['パー', '#4ade80'], bogey: ['ボギー', '#93c5fd'], double: ['ダボ', '#3b82f6'], worse: ['トリ以上', '#1e3a8a'] };
  // コース別：ホールごとの平均
  let holeTable = '';
  if (ui.scoreCourse) {
    const ns = [...new Set(rs.flatMap(r => Object.keys(r.pars || {}).map(Number)))].sort((a, b) => a - b);
    const hrows = ns.map(n => { const v = rs.map(r => holeScore((r.scores || {})[n])).filter(isNum); const p = rs.map(r => r.pars && r.pars[n]).find(isNum) || 4; return { n, p, avg: v.length ? avgOf(v) : null, best: v.length ? Math.min(...v) : null, cnt: v.length }; }).filter(x => x.avg != null);
    const sorted = [...hrows].sort((a, b) => (b.avg - b.p) - (a.avg - a.p)), worst = new Set(sorted.slice(0, 3).map(x => x.n)), good = new Set(sorted.slice(-3).map(x => x.n));
    holeTable = hrows.length ? `<h3>ホール別の平均（このコース）</h3><div class="card scroll-x"><table class="t"><tr><th>ホール</th><th>Par</th><th>平均</th><th>パー比</th><th>ベスト</th></tr>${hrows.map(x => `<tr style="${worst.has(x.n) ? 'background:#fef2f2' : good.has(x.n) ? 'background:#f0fdf4' : ''}"><td><b>${x.n}</b>${worst.has(x.n) ? ' <span class="small" style="color:#dc2626">苦手</span>' : good.has(x.n) ? ' <span class="small" style="color:#15803d">得意</span>' : ''}</td><td>${x.p}</td><td><b>${x.avg.toFixed(1)}</b></td><td>${(x.avg - x.p >= 0 ? '+' : '') + (x.avg - x.p).toFixed(1)}</td><td>${x.best}</td></tr>`).join('')}</table></div>` : '';
  }
  // 月ごとの一覧
  const byMonth = {}; [...S].reverse().forEach(x => { const d = new Date(x.r.date), k = `${d.getFullYear()}年${d.getMonth() + 1}月`; (byMonth[k] = byMonth[k] || []).push(x); });
  const list = Object.entries(byMonth).map(([m, xs]) => `<div class="small muted" style="margin:10px 0 2px;font-weight:700">${m}</div>${xs.map(x => `<div class="list-item" data-rd="${x.r.id}" style="padding:9px 0"><div style="min-width:34px;text-align:center"><b>${new Date(x.r.date).getDate()}</b><div class="small muted">日</div></div><div class="grow"><b>${esc(x.r.courseName)}</b><div class="small muted">${x.s.holes}H${x.s.puttHoles ? '・パット' + x.s.putts : ''}${x.s.girPct != null ? '・パーオン' + x.s.girPct + '%' : ''}${x.s.totalOnly ? '・合計のみ' : ''}</div></div><b style="font-size:21px">${x.s.strokes}</b><span class="small" style="min-width:34px;text-align:right;color:${x.s.diff <= 0 ? '#dc2626' : '#6b7570'}">${sgn(x.s.diff)}</span>${x.r.ai ? '<span class="badge" style="margin-left:4px">総評</span>' : ''}</div>`).join('')}`).join('');
  el.innerHTML = seg + `
    <div class="row" style="margin-bottom:10px"><select id="sc-course" class="grow" style="padding:9px;border:1px solid #cfd6d2;border-radius:10px"><option value="">すべてのコース（${all.length}ラウンド）</option>${courses.map(([id, nm]) => `<option value="${id}" ${id === ui.scoreCourse ? 'selected' : ''}>${esc(nm)}（${all.filter(r => r.courseId === id).length}）</option>`).join('')}</select><button class="btn small light" id="sc-past">＋入力</button></div>
    <div class="grid3" style="margin-bottom:12px">
      ${box('平均スコア', f1(av(last5, x => x.s.strokes)), '直近5R')}${box('ベスト', best ? best.s.strokes : '—', best ? new Date(best.r.date).toLocaleDateString('ja-JP') : '')}${box('ハンデ', hi != null ? hi.toFixed(1) : '—', '目安')}
      ${box('平均パット', f1(av(last5, per)), '18H換算')}${box('FWキープ', av(last5, x => x.s.fwPct) != null ? Math.round(av(last5, x => x.s.fwPct)) + '%' : '—')}${box('パーオン', av(last5, x => x.s.girPct) != null ? Math.round(av(last5, x => x.s.girPct)) + '%' : '—')}
    </div>
    <h3>スコアの推移</h3><div class="card">${scoreTrendSVG(F)}</div>
    ${prev5.length ? `<h3>最近5ラウンド vs その前の5ラウンド</h3><div class="card"><table class="t"><tr><th></th><th>最近</th><th>その前</th><th>差</th></tr>
      ${row('スコア', x => x.s.strokes)}${row('パット(18H)', per)}${row('FWキープ', x => x.s.fwPct, false, '%')}${row('パーオン', x => x.s.girPct, false, '%')}${row('ペナルティ', x => x.s.totalOnly ? null : x.s.pen)}${row('3パット', x => x.s.puttHoles ? x.s.three : null)}${row('ダボ以上', x => x.s.totalOnly ? null : x.s.kinds.double + x.s.kinds.worse)}${row('Par3平均', x => x.s.par3)}${row('Par4平均', x => x.s.par4)}${row('Par5平均', x => x.s.par5)}</table></div>` : ''}
    ${kt ? `<h3>スコアの内訳（ホールごとに入力したラウンド）</h3><div class="card"><div style="display:flex;height:22px;border-radius:6px;overflow:hidden">${Object.entries(kinds).filter(([, v]) => v).map(([k, v]) => `<div style="width:${v / kt * 100}%;background:${KC[k][1]}"></div>`).join('')}</div>
      <div class="chips" style="margin-top:8px">${Object.entries(kinds).filter(([, v]) => v).map(([k, v]) => `<span class="small"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${KC[k][1]}"></span> ${KC[k][0]} ${Math.round(v / kt * 100)}%</span>`).join('')}</div></div>` : ''}
    ${holeTable}
    <button class="btn block accent" id="sc-ai" style="margin-top:12px">🤖 AIに傾向を分析してもらう</button><div id="sc-ai-box"></div>
    <h3>ラウンド一覧（タップで詳細・総評）</h3><div class="card">${list}</div>`;
  $('#sc-course', el).onchange = e => { ui.scoreCourse = e.target.value; renderStats(); };
  $('#sc-past', el).onclick = () => pastScoreFlow({ courseId: ui.scoreCourse });
  $$('[data-rd]', el).forEach(b => b.onclick = () => showRoundDetail(db.rounds.find(r => r.id === b.dataset.rd)));
  $('#sc-ai', el).onclick = async () => {
    const box = $('#sc-ai-box'); box.innerHTML = '<div class="ai-answer muted">AIが分析中…</div>';
    const lines = S.slice(-25).map(x => `${new Date(x.r.date).toLocaleDateString('ja-JP')} ${x.r.courseName} ${x.s.holes}H: ${x.s.strokes}(${sgn(x.s.diff)})` + (x.s.totalOnly ? ' 合計のみ' : ` パット${x.s.puttHoles ? x.s.putts : '?'} FW${x.s.fwPct ?? '-'}% パーオン${x.s.girPct ?? '-'}% ペナ${x.s.pen} バーディ${x.s.kinds.birdie + x.s.kinds.eagle} ダボ以上${x.s.kinds.double + x.s.kinds.worse} Par3/4/5平均${f1(x.s.par3)}/${f1(x.s.par4)}/${f1(x.s.par5)}`)).join('\n');
    try {
      const ans = await callClaude({ system: 'あなたは経験豊富なゴルフコーチです。日本語で、データを根拠に具体的・前向きに。見出しは【】で短く、箇条書き中心で600字程度。', maxTokens: 1600,
        text: `ゴルファーのスコアの傾向を分析してください。${ui.scoreCourse ? `（対象コース: ${courses.find(([id]) => id === ui.scoreCourse)[1]}）` : ''}\nハンディキャップ指数(目安): ${hi ?? '未算出'}\nラウンド履歴（古い順）:\n${lines}\n\nクラブ別飛距離:\n${bagSummaryForAI()}\n\n構成: 【全体の傾向】上達しているか／【強み】／【スコアを落としている一番の原因】データ根拠つき／【次の5ラウンドの目標】具体的な数値／【優先して練習すること】3つ` });
      if ($('#sc-ai-box')) $('#sc-ai-box').innerHTML = `<div class="ai-answer">${esc(ans)}</div>`;
    } catch (e) { if ($('#sc-ai-box')) $('#sc-ai-box').innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
}

/* ---------------- 履歴一覧（複数ラウンド）の一括取り込み ---------------- */
const STD_PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5];
function makeParList(nHoles, par) {
  const ps = []; for (let i = 0; i < nHoles; i++) ps.push(STD_PARS[i % 9]);
  let d = (par || (nHoles === 9 ? 36 : 72)) - ps.reduce((a, b) => a + b, 0);
  for (let i = 0; d < 0 && i < ps.length; i++) if (ps[i] === 5) { ps[i] = 4; d++; }
  for (let i = 0; d > 0 && i < ps.length; i++) if (ps[i] === 3) { ps[i] = 4; d--; }
  return ps;
}
function reviewRoundList(rounds) {
  const items = rounds.filter(x => isNum(x.total));
  if (!items.length) { toast('ラウンドの一覧を読み取れませんでした'); return; }
  const el = openModal(`<h2>読み取ったラウンド（${items.length}件）</h2>
    <p class="small muted">日付・コース名・スコアを確認して保存してください。合計スコアのみの記録として登録します（ホールごとの内容はあとから編集で追加できます）。</p>
    <datalist id="rl-courses">${db.courses.map(c => `<option value="${esc(c.name)}">`).join('')}</datalist>
    ${items.map((x, i) => `<div class="card" data-i="${i}" style="padding:10px"><div class="row"><input type="checkbox" class="ck" checked style="width:20px;height:20px"><input type="date" class="dt grow" value="${esc(x.date && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : '')}" max="${todayStr()}" style="padding:7px;border:1px solid #cfd6d2;border-radius:8px"></div>
      <input class="cn" list="rl-courses" value="${esc(x.course || '')}" placeholder="コース名" style="width:100%;margin:6px 0;padding:8px;border:1px solid #cfd6d2;border-radius:8px">
      <div class="grid3"><label class="f" style="margin:0">スコア<input class="tt" inputmode="numeric" value="${x.total}"></label><label class="f" style="margin:0">パット<input class="pt" inputmode="numeric" value="${isNum(x.putts) ? x.putts : ''}"></label><label class="f" style="margin:0">ホール<select class="hn"><option ${x.holes === 9 ? '' : 'selected'}>18</option><option ${x.holes === 9 ? 'selected' : ''}>9</option></select></label></div></div>`).join('')}
    <button class="btn block" id="rl-save">選んだラウンドを保存</button>`);
  $('#rl-save', el).onclick = () => {
    let n = 0;
    const chosen = $$('[data-i]', el).filter(card => $('.ck', card).checked);
    const miss = chosen.filter(card => !$('.dt', card).value || !num($('.tt', card).value)).length;
    if (miss) { toast(`日付かスコアが空のものが${miss}件あります（保存しない場合はチェックを外してください）`, 4500); return; }
    chosen.forEach(card => {
      const date = $('.dt', card).value, name = $('.cn', card).value.trim() || '名称不明のコース', tot = num($('.tt', card).value), nh = +$('.hn', card).value;
      let c = db.courses.find(x => x.name === name);
      if (!c) { const ps = makeParList(nh); c = { id: uid(), name, source: 'manual', holes: ps.map((p, i) => ({ n: i + 1, par: p, si: null, tee: null, green: null, greenPoly: null, line: null })), greens: [], fairways: [], tees: [], hazards: [], rating: null, slope: null, created: Date.now() }; db.courses.push(c); }
      db.rounds.push({ id: uid(), courseId: c.id, courseName: c.name, date: dateToISO(date), totalOnly: tot, puttsTotal: num($('.pt', card).value), scores: {}, track: {}, past: true, pars: Object.fromEntries(c.holes.map(h => [h.n, h.par])), sis: {}, rating: c.rating || null, slope: c.slope || null });
      n++;
    });
    save(); closeModal(); toast(`${n}ラウンドを登録しました。コースのパーは標準(72)で作成しています（✏️で修正できます）`, 5000);
    ui.statsView = 'score'; switchTab('stats');
  };
}

/* ---------------- 過去のスコア入力 ---------------- */
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dateToISO = s => new Date((s || todayStr()) + 'T09:00:00').toISOString();
const isoToDate = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function courseFromRec(rec) { // コースが削除されていても編集できるように
  const ns = Object.keys(rec.pars || {}).map(Number).sort((a, b) => a - b);
  return { id: rec.courseId, name: rec.courseName, holes: ns.map(n => ({ n, par: rec.pars[n], si: rec.sis && rec.sis[n] || null })), rating: rec.rating, slope: rec.slope, _virtual: true };
}
function pastScoreFlow(state = {}) {
  const st = Object.assign({ courseId: '', date: todayStr(), mode: 'hole' }, state);
  const el = openModal(`<h2>📝 過去のスコアを入力</h2>
    <button class="btn block accent" id="ps-cam">📷 写真・スクリーンショットから読み込む（複数枚OK）</button>
    <p class="small muted" style="margin:-2px 0 12px">紙のスコアカードの写真や、スコア管理アプリ・Webのスクリーンショットを選んでください。前半・後半の2枚や、アプリの履歴一覧（複数ラウンド）にも対応します。</p>
    <label class="f">コース<select id="ps-course"><option value="">選択してください</option>${db.courses.map(c => `<option value="${c.id}" ${c.id === st.courseId ? 'selected' : ''}>${esc(c.name)}（${c.holes.length}H）</option>`).join('')}</select></label>
    <div class="grid2"><button class="btn small ghost" id="ps-search">🔍 コースを検索</button><button class="btn small ghost" id="ps-new">＋ 名前だけで作成</button></div>
    <label class="f" style="margin-top:12px">プレー日<input type="date" id="ps-date" value="${esc(st.date)}" max="${todayStr()}"></label>
    <div class="spread" style="margin-bottom:12px"><span class="small muted">入力方法</span><div class="seg" style="width:230px"><button data-m="hole" class="${st.mode === 'hole' ? 'on' : ''}">ホールごと</button><button data-m="total" class="${st.mode === 'total' ? 'on' : ''}">合計だけ</button></div></div>
    <button class="btn block" id="ps-next">次へ</button>`);
  const cur = () => ({ courseId: $('#ps-course', el).value, date: $('#ps-date', el).value || todayStr(), mode: st.mode });
  $$('[data-m]', el).forEach(b => b.onclick = () => { st.mode = b.dataset.m; $$('[data-m]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $('#ps-search', el).onclick = () => { const s = cur(); closeModal(); searchCourseFlow(c => pastScoreFlow({ ...s, courseId: c.id })); };
  $('#ps-new', el).onclick = () => { const s = cur(); closeModal(); createCourseForm({ btn: '作成', onCreated: c => pastScoreFlow({ ...s, courseId: c.id }) }); };
  $('#ps-cam', el).onclick = () => { const s = cur(); closeModal(); scorecardPhotoFlow(s); };
  $('#ps-next', el).onclick = () => {
    const s = cur(), c = courseById(s.courseId);
    if (!c) { toast('コースを選んでください（無ければ検索か作成）'); return; }
    closeModal();
    if (s.mode === 'total') totalOnlyForm(c, s.date); else scoreGridForm({ course: c, date: s.date });
  };
}
function totalOnlyForm(course, date, rec) {
  const el = openModal(`<h2>${esc(course.name)}</h2>
    <label class="f">プレー日<input type="date" id="to-date" value="${esc(rec ? isoToDate(rec.date) : date)}" max="${todayStr()}"></label>
    <div class="grid2"><label class="f">合計スコア<input id="to-total" inputmode="numeric" value="${rec ? rec.totalOnly : ''}" placeholder="例 92"></label><label class="f">合計パット（任意）<input id="to-putts" inputmode="numeric" value="${rec && isNum(rec.puttsTotal) ? rec.puttsTotal : ''}"></label></div>
    <p class="small muted">合計だけの記録はハンディキャップの計算に「推定」として使われます。ホールごとに入れると、スタッツやAI総評がより詳しくなります。</p>
    <button class="btn block" id="to-save">保存</button>`);
  $('#to-save', el).onclick = () => {
    const tot = num($('#to-total', el).value);
    if (!tot || tot < course.holes.length || tot > course.holes.length * 12) { toast('合計スコアを確認してください'); return; }
    const r = rec || { id: uid(), track: {}, scores: {}, past: true };
    Object.assign(r, { courseId: course.id, courseName: course.name, date: dateToISO($('#to-date', el).value), totalOnly: tot, puttsTotal: num($('#to-putts', el).value), pars: Object.fromEntries(course.holes.map(h => [h.n, h.par])), sis: Object.fromEntries(course.holes.filter(h => h.si).map(h => [h.n, h.si])), rating: course.rating || null, slope: course.slope || null });
    if (!rec) db.rounds.push(r);
    save(); closeModal(); toast('保存しました'); renderRound(); showRoundDetail(r);
  };
}
function scoreGridForm({ course, date, rec, values }) {
  const v = n => {
    if (values && values[n]) return values[n];
    const s = rec && rec.scores && rec.scores[n]; if (!s) return {};
    return { strokes: holeScore(s), putts: s.putts, pen: s.pen, fw: s.fw };
  };
  const parOfHole = h => (rec && rec.pars && rec.pars[h.n]) || (values && values[h.n] && values[h.n].par) || h.par;
  const el = openModal(`<h2>${esc(course.name)}</h2>
    <label class="f">プレー日<input type="date" id="gi-date" value="${esc(rec ? isoToDate(rec.date) : (date || todayStr()))}" max="${todayStr()}"></label>
    <p class="small muted" style="margin:0 0 6px">打数だけでもOK。パット・ペナ・FWは分かる範囲で。FWはティーショットがフェアウェイに残ったら◯。</p>
    <div class="scroll-x"><table class="t gi"><tr><th>H</th><th>Par</th><th>打数</th><th>パット</th><th>ペナ</th><th>FW</th></tr>
    ${course.holes.map(h => { const x = v(h.n), p = parOfHole(h); return `<tr data-n="${h.n}"><td><b>${h.n}</b></td>
      <td><select class="gi-par">${[3, 4, 5, 6].map(q => `<option ${q === p ? 'selected' : ''}>${q}</option>`).join('')}</select></td>
      <td><input class="gi-s" inputmode="numeric" value="${x.strokes ?? ''}"></td>
      <td><input class="gi-p" inputmode="numeric" value="${x.putts ?? ''}"></td>
      <td><input class="gi-pen" inputmode="numeric" value="${x.pen ? x.pen : ''}"></td>
      <td><select class="gi-fw"><option value="">—</option><option value="1" ${x.fw === true ? 'selected' : ''}>◯</option><option value="0" ${x.fw === false ? 'selected' : ''}>×</option></select></td></tr>`; }).join('')}
    </table></div>
    <p id="gi-tot" style="text-align:center;font-weight:800;font-size:17px;margin:10px 0"></p>
    <button class="btn block" id="gi-save">保存</button>`);
  const calc = () => {
    let s = 0, p = 0, par = 0, n = 0, pn = 0;
    $$('tr[data-n]', el).forEach(tr => { const v1 = num($('.gi-s', tr).value); if (v1) { s += v1; n++; par += +$('.gi-par', tr).value; } const v2 = num($('.gi-p', tr).value); if (v2 != null && v1) { p += v2; pn++; } });
    $('#gi-tot', el).textContent = n ? `${n}ホール 合計 ${s}（${sgn(s - par)}）${pn ? '・パット ' + p : ''}` : '打数を入力してください';
  };
  const tbl = $('table.gi', el); tbl.addEventListener('input', calc); tbl.addEventListener('change', calc); calc();
  // 入力したら次のマスへ（打数→パット→次のホールの打数）
  $$('.gi-s, .gi-p', el).forEach(inp => inp.addEventListener('input', () => {
    const val = inp.value; if (!/^\d$/.test(val) || (inp.classList.contains('gi-s') && val === '1')) return;
    const tr = inp.closest('tr'), next = inp.classList.contains('gi-s') ? $('.gi-p', tr) : (tr.nextElementSibling && $('.gi-s', tr.nextElementSibling));
    if (next) next.focus();
  }));
  $('#gi-save', el).onclick = () => {
    const scores = {}, pars = {}; let bad = 0;
    $$('tr[data-n]', el).forEach(tr => {
      const n = +tr.dataset.n, par = +$('.gi-par', tr).value, s = num($('.gi-s', tr).value), p = num($('.gi-p', tr).value), pen = num($('.gi-pen', tr).value) || 0, fw = $('.gi-fw', tr).value;
      pars[n] = par;
      if (!s) return;
      if (s < 1 || s > 15 || (p != null && p >= s) || pen >= s) { bad++; return; }
      scores[n] = { shots: s - (p || 0) - pen, putts: p, pen, fw: par >= 4 && fw !== '' ? fw === '1' : null };
    });
    if (bad) { toast(`入力がおかしいホールが${bad}つあります（パットやペナが打数以上など）`); return; }
    if (!Object.keys(scores).length) { toast('打数を入力してください'); return; }
    const real = !course._virtual && courseById(course.id);
    if (real) course.holes.forEach(h => { if (pars[h.n]) h.par = pars[h.n]; });
    const r = rec || { id: uid(), track: {}, past: true };
    delete r.totalOnly; delete r.puttsTotal;
    Object.assign(r, { courseId: course.id, courseName: course.name, date: dateToISO($('#gi-date', el).value), scores, pars, sis: Object.fromEntries(course.holes.filter(h => h.si).map(h => [h.n, h.si])), rating: course.rating || null, slope: course.slope || null });
    if (!rec) db.rounds.push(r);
    save(); closeModal(); toast('保存しました'); renderRound(); showRoundDetail(r);
  };
}
async function scorecardPhotoFlow(state) {
  const files = await pickFiles('#file-images'); if (!files.length) return;
  try {
    showLoading(`画像を準備中…（${files.length}枚）`);
    const imgs = []; for (const f of files.slice(0, 8)) imgs.push(await fileToJpegB64(f, 2000, 0.88));
    showLoading('AIがスコアを読み取り中…');
    const txt = await callClaude({
      system: 'あなたはゴルフのスコアカードやスコア管理アプリの画面を正確に書き起こすアシスタントです。JSONのみを出力します。',
      images: imgs, maxTokens: 8000,
      text: `画像（${imgs.length}枚）はゴルフのスコアに関するもの（紙のスコアカードの写真、スコア管理アプリやWebサイトのスクリーンショット等）です。まず種類を判定し、JSONだけを返してください。
A) 1ラウンドのスコアカード（複数枚なら前半・後半など同じラウンドの続き）→
{"kind":"card","course":"コース名|null","date":"YYYY-MM-DD|null","rating":数値|null,"slope":数値|null,
 "holes":[{"n":1,"par":4,"hdcp":ハンディキャップ順位|null,"yards":数値|null}],
 "players":[{"name":"名前（無ければ「プレーヤー1」）","scores":[{"n":1,"strokes":打数,"putts":パット数|null}]}]}
B) 複数ラウンドの一覧（アプリの履歴・スコア一覧画面など）→
{"kind":"list","rounds":[{"date":"YYYY-MM-DD|null","course":"コース名|null","total":合計スコア,"putts":合計パット|null,"holes":18または9}]}
ルール: OUT/IN/TOTAL等の合計列はAのscoresに含めない。パット数が「5/2」「5(2)」や小さい数字で併記されていればputtsに入れる。+1/−1のようにパーとの差で書かれていれば打数に直す。年が書かれていない日付は画面内の他の情報から推定し、わからなければnull。読めない値はnull。`
    });
    hideLoading();
    const d = parseJSON(txt);
    if (d.kind === 'list' || (!d.players && d.rounds)) return reviewRoundList(d.rounds || []);
    const players = (d.players || []).filter(p => p.scores && p.scores.some(s => isNum(s.strokes)));
    if (!players.length) { toast('スコアを読み取れませんでした。スコア部分がはっきり写るように撮影してください', 5000); return; }
    const use = p => applyScorecard(d, p, state);
    if (players.length === 1) return use(players[0]);
    const el = openModal(`<h2>どのプレーヤーのスコアですか？</h2>${players.map((p, i) => `<div class="list-item"><div class="grow"><b>${esc(p.name)}</b><div class="small muted">合計 ${p.scores.reduce((a, s) => a + (s.strokes || 0), 0)}</div></div><button class="btn small" data-i="${i}">これ</button></div>`).join('')}`);
    $$('[data-i]', el).forEach(b => b.onclick = () => { closeModal(); use(players[+b.dataset.i]); });
  } catch (e) { hideLoading(); toast(e.message, 5000); }
}
function applyScorecard(d, player, state) {
  let course = courseById(state && state.courseId);
  const cardHoles = (d.holes || []).filter(h => isNum(h.n));
  if (!course && d.course) course = db.courses.find(c => c.name === d.course || c.name.includes(d.course) || d.course.includes(c.name));
  if (!course) {
    const nHoles = Math.max(cardHoles.length, ...player.scores.map(s => s.n || 0)) > 9 ? 18 : 9;
    course = { id: uid(), name: d.course || 'スコアカードのコース', source: 'manual', holes: Array.from({ length: nHoles }, (_, i) => { const h = cardHoles.find(x => x.n === i + 1) || {}; return { n: i + 1, par: isNum(h.par) ? h.par : 4, si: isNum(h.hdcp) ? h.hdcp : null, tee: null, green: null, greenPoly: null, line: null }; }), greens: [], fairways: [], tees: [], hazards: [], rating: isNum(d.rating) ? d.rating : null, slope: isNum(d.slope) ? d.slope : null, created: Date.now() };
    db.courses.push(course); save();
    toast(`コース「${course.name}」を作成しました（名前はあとで✏️から変更できます）`, 4500);
  } else {
    // カードの方がホールが多い場合（OSMのホール情報が一部だけ等）は不足分を追加
    const ns = new Set([...cardHoles.map(h => h.n), ...player.scores.map(s => s.n)].filter(isNum));
    ns.forEach(n => { if (!course.holes.some(x => x.n === n)) { const h = cardHoles.find(x => x.n === n) || {}; course.holes.push({ n, par: isNum(h.par) ? h.par : 4, si: isNum(h.hdcp) ? h.hdcp : null, tee: null, green: null, greenPoly: null, line: null }); } });
    course.holes.sort((a, b) => a.n - b.n);
    cardHoles.forEach(h => { const ch = course.holes.find(x => x.n === h.n); if (ch && isNum(h.hdcp) && !ch.si) ch.si = h.hdcp; if (ch && isNum(h.par) && !ch.green) ch.par = h.par; });
    if (!course.rating && isNum(d.rating)) course.rating = d.rating;
    if (!course.slope && isNum(d.slope)) course.slope = d.slope;
    save();
  }
  const values = {};
  player.scores.forEach(s => { if (isNum(s.n) && isNum(s.strokes)) { const h = cardHoles.find(x => x.n === s.n); values[s.n] = { strokes: s.strokes, putts: isNum(s.putts) ? s.putts : null, par: h && isNum(h.par) ? h.par : undefined }; } });
  const date = d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : (state && state.date) || todayStr();
  toast('読み取り結果を確認して、間違いがあれば直してから保存してください', 4500);
  scoreGridForm({ course, date, values });
}

/* ---------------- 起動 ---------------- */
window.addEventListener('online', () => maybeFetchEnv());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && curRound()) { if (map) map.invalidateSize(); if (wantAwake) keepAwake(true); }
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); window.__installPrompt = e; const c = document.getElementById('install-card'); if (c) c.hidden = false; });
(async function boot() {
  try { const raw = await IDB.get(KEY); if (raw) db = mergeDB(JSON.parse(raw)); else if (db.clubs.length || db.rounds.length) flushSave(); } catch (e) { }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { }
  switchTab('round');
  if (!db.settings.apiKey && !db.clubs.length) setTimeout(() => toast('ようこそ！まず「設定」でAPIキー、「クラブ」でクラブを登録しましょう', 5000), 600);
  if ('serviceWorker' in navigator && !Bridge && location.protocol === 'https:') {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing; if (!w) return;
        w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) w.postMessage('skipWaiting'); });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return; reloaded = true;
        if (!curRound() && $('#modal').hidden) location.reload(); else toast('新しいバージョンを受信しました。次回起動時に反映されます', 4000);
      });
    } catch (e) { }
  }
})();

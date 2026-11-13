'use strict';
/* =========================================================
   AIキャディ  — ラウンド(GPS) / 練習場 / クラブ / 統計 / 設定
   データは端末内(localStorage)に保存。AIは Anthropic Claude API。
   ========================================================= */

// ---------- 小道具 ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const isNum = v => typeof v === 'number' && isFinite(v);
const num = v => { if (v === '' || v == null) return null; const n = parseFloat(String(v).normalize('NFKC').replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
const r1 = v => Math.round(v * 10) / 10;
const M2YD = 1.0936133;
const Bridge = window.AndroidBridge || null;

// ---------- 保存 ----------
const KEY = 'aicaddie.v1';
const defaultDB = () => ({
  settings: { apiKey: '', model: 'claude-sonnet-5-5', unit: 'yd', voice: true, caddieStyle: 'balance', voiceName: '', voicePitch: 1.2, voiceRate: 1.05, competition: false, mapProvider: 'esri', googleKey: '' },
  clubs: [], shots: [], sessions: [], courses: [], rounds: [],
  activeRound: null, activeSession: null
});
let db = loadDB();
function loadDB() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return mergeDB(d);
  } catch (e) { }
  return defaultDB();
}
// 保存先：IndexedDB（大容量・消えにくい）＋ localStorage（予備）
const IDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('aicaddie', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { this._db = r.result; res(r.result); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(k) { const d = await this.open(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  async set(k, v) { const d = await this.open(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
};
function mergeDB(d) { const base = defaultDB(); return Object.assign(base, d, { settings: Object.assign(base.settings, d.settings || {}) }); }
let saveTimer = null, idbOK = true;
function flushSave() {
  clearTimeout(saveTimer); saveTimer = null;
  const json = JSON.stringify(db);
  IDB.set(KEY, json).then(() => { idbOK = true; }).catch(() => { idbOK = false; });
  try { localStorage.setItem(KEY, json); } catch (e) { if (!idbOK) toast('保存に失敗しました（端末の空き容量を確認してください）'); }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 250); }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && saveTimer) flushSave(); });
window.addEventListener('pagehide', () => { if (saveTimer) flushSave(); });

// ---------- 単位 ----------
const U = () => db.settings.unit === 'm' ? 'm' : 'y';
const toDisp = yd => db.settings.unit === 'm' ? yd / M2YD : yd;
const fromDisp = v => db.settings.unit === 'm' ? v * M2YD : v;
const fmt = yd => isNum(yd) ? Math.round(toDisp(yd)) + U() : '—';
const fmtN = yd => isNum(yd) ? String(Math.round(toDisp(yd))) : '—';

// ---------- UI共通 ----------
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
window.toast = toast;
function showLoading(msg) { $('#loading-msg').textContent = msg || '処理中…'; $('#loading').hidden = false; }
function hideLoading() { $('#loading').hidden = true; }
let modalOnClose = null;
function openModal(html, onClose) {
  $('#modal-body').innerHTML = html; $('#modal').hidden = false; modalOnClose = onClose || null;
  $('.sheet').scrollTop = 0; return $('#modal-body');
}
function closeModal() { $('#modal').hidden = true; $('#modal-body').innerHTML = ''; const f = modalOnClose; modalOnClose = null; if (f) f(); }
$('.modal-backdrop').addEventListener('click', closeModal);
function confirmBox(msg, okLabel = 'OK') {
  return new Promise(res => {
    const el = openModal(`<p style="line-height:1.7">${esc(msg)}</p><div class="grid2"><button class="btn ghost" data-r="0">キャンセル</button><button class="btn" data-r="1">${esc(okLabel)}</button></div>`, () => res(false));
    $$('[data-r]', el).forEach(b => b.onclick = () => { modalOnClose = null; closeModal(); res(b.dataset.r === '1'); });
  });
}
window.handleBack = function () {
  if (!$('#modal').hidden) { closeModal(); return true; }
  if (ui.setGreen) { setGreenMode(false); return true; }
  if (ui.tab !== 'round') { switchTab('round'); return true; }
  return false;
};

// ---------- 画像 ----------
function pickFiles(sel) {
  return new Promise(res => {
    const inp = $(sel); inp.value = '';
    inp.onchange = () => res([...inp.files]);
    inp.click();
  });
}
function pickFile(sel) {
  return new Promise(res => {
    const inp = $(sel); inp.value = '';
    inp.onchange = () => res(inp.files[0] || null);
    inp.click();
  });
}
async function fileToJpegB64(file, max = 1568, q = 0.85) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('画像を読み込めませんでした')); i.src = url; });
    let w = img.naturalWidth, h = img.naturalHeight; const s = Math.min(1, max / Math.max(w, h));
    w = Math.round(w * s); h = Math.round(h * s);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/jpeg', q).split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

// ---------- 音声 ----------
// キャディの声：端末の日本語音声から女性の声を優先して選ぶ（設定で変更可）
const FEMALE_RE = /female|女性|nanami|kyoko|haruka|ayumi|mizuki|sayaka|o-ren|htm|jab|aoi|mayu|shiori/i;
const MALE_RE = /male|男性|ichiro|keita|otoya|hattori|daichi|naoki|jac|jad/i;
const isMaleName = n => MALE_RE.test(n.replace(/female/ig, ''));
function jaVoices() { try { return speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang)); } catch (e) { return []; } }
function pickVoice() {
  const vs = jaVoices(); if (!vs.length) return null;
  const pref = db.settings.voiceName;
  if (pref) { const v = vs.find(x => x.name === pref); if (v) return v; }
  return vs.find(v => FEMALE_RE.test(v.name) && !isMaleName(v.name)) || vs.find(v => !isMaleName(v.name)) || vs[0];
}
try { speechSynthesis.getVoices(); speechSynthesis.onvoiceschanged = () => { }; } catch (e) { }
function speak(text) {
  if (!db.settings.voice || !text) return;
  const t = text.replace(/[#*_`>]/g, '');
  const pitch = isNum(db.settings.voicePitch) ? db.settings.voicePitch : 1.2, rate = isNum(db.settings.voiceRate) ? db.settings.voiceRate : 1.05;
  if (Bridge && Bridge.speak) { if (Bridge.setVoice) Bridge.setVoice(pitch, rate); Bridge.speak(t); return; }
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(t); u.lang = 'ja-JP';
    try { const v = pickVoice(); if (v) u.voice = v; } catch (e) { }
    u.pitch = pitch; u.rate = rate;
    speechSynthesis.speak(u);
  } catch (e) { }
}
function stopSpeak() { if (Bridge && Bridge.stopSpeak) Bridge.stopSpeak(); else try { speechSynthesis.cancel(); } catch (e) { } }
let voiceResolver = null;
window.onVoiceResult = (text, err) => { const r = voiceResolver; voiceResolver = null; if (err === 'noapp') toast('音声認識アプリが見つかりません'); if (r) r(text || ''); };
function listen() {
  return new Promise(res => {
    if (Bridge && Bridge.startVoice) { voiceResolver = res; Bridge.startVoice(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('この環境では音声入力が使えません'); res(''); return; }
    const r = new SR(); r.lang = 'ja-JP'; r.interimResults = false;
    let done = false;
    r.onresult = e => { done = true; res(e.results[0][0].transcript); };
    r.onerror = () => { if (!done) { done = true; res(''); } };
    r.onend = () => { if (!done) res(''); };
    toast('🎤 どうぞ話してください'); r.start();
  });
}

// ---------- Claude API ----------
async function callClaude({ system, text, images = [], maxTokens = 1200 }) {
  const key = (db.settings.apiKey || '').trim();
  if (!key) throw new Error('設定タブでAnthropic APIキーを入力してください');
  if (navigator.onLine === false) throw new Error('オフラインです。通信できる場所で再度お試しください');
  const content = [...images.map(d => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } })), { type: 'text', text }];
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, (db.settings.workspaceId || '').trim() ? { 'anthropic-workspace-id': db.settings.workspaceId.trim() } : {}),
      body: JSON.stringify({ model: db.settings.model || 'claude-sonnet-5-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
    });
  } catch (e) { throw new Error('AIに接続できませんでした（通信状況を確認してください）'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const m = j?.error?.message || '';
    if (r.status === 401) throw new Error('APIキーが正しくありません。コピーし直して貼り付けてください（前後の空白に注意）');
    if (/credit balance/i.test(m)) throw new Error('APIのクレジット残高がありません。platform.claude.com の「Billing」でクレジットを購入してください');
    if (/workspace/i.test(m)) throw new Error('このAPIキーはワークスペースの指定が必要な種類です。ワークスペースを選んで作ったキーに替えるか、設定の「ワークスペースID」を入力してください');
    if (/model/i.test(m) && r.status === 404) throw new Error('選んだAIモデルが使えません。設定でほかのモデルを選んでください');
    if (r.status === 429) throw new Error('AIの利用が混み合っています。少し待ってからもう一度お試しください');
    throw new Error(m || ('AIエラー ' + r.status));
  }
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}
function parseJSON(t) {
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('AIの応答を読み取れませんでした');
  return JSON.parse(t.slice(s, e + 1));
}

// ---------- 地理計算 ----------
const RE = 6371000, D2R = Math.PI / 180;
const P = a => Array.isArray(a) ? { lat: a[0], lng: a[1] } : a;
const A = p => [Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6];
function distM(a, b) {
  a = P(a); b = P(b);
  const dLat = (b.lat - a.lat) * D2R, dLng = (b.lng - a.lng) * D2R;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * RE * Math.asin(Math.min(1, Math.sqrt(s)));
}
const distY = (a, b) => distM(a, b) * M2YD;
function bearing(a, b) {
  a = P(a); b = P(b);
  const y = Math.sin((b.lng - a.lng) * D2R) * Math.cos(b.lat * D2R);
  const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lng - a.lng) * D2R);
  return (Math.atan2(y, x) / D2R + 360) % 360;
}
function toXY(o, p) { o = P(o); p = P(p); return { x: (p.lng - o.lng) * D2R * RE * Math.cos(o.lat * D2R), y: (p.lat - o.lat) * D2R * RE }; }
function centroid(poly) { let la = 0, ln = 0; poly.forEach(p => { la += p[0]; ln += p[1]; }); return [la / poly.length, ln / poly.length]; }
function inPoly(pt, poly) {
  pt = P(pt); let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (((yi > pt.lat) !== (yj > pt.lat)) && (pt.lng < (xj - xi) * (pt.lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distToLineM(pt, line) {
  let best = Infinity; const o = P(pt);
  for (let i = 0; i < line.length - 1; i++) {
    const a = toXY(o, line[i]), b = toXY(o, line[i + 1]);
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let t = L2 ? -(a.x * dx + a.y * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(a.x + t * dx, a.y + t * dy));
  }
  return line.length === 1 ? distM(pt, line[0]) : best;
}
// 打つ方向(from→to)に対する各点の前後(along)と左右(cross:+右)を計算
function frame(from, to) {
  const t = toXY(from, to), L = Math.hypot(t.x, t.y) || 1, ux = t.x / L, uy = t.y / L;
  return p => { const v = toXY(from, p); return { along: v.x * ux + v.y * uy, cross: v.x * uy - v.y * ux }; };
}
const DIRS = ['北', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東', '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西'];
const dirName = deg => DIRS[Math.round(deg / 22.5) % 16];

// ---------- クラブ ----------
const TYPE_ORDER = { driver: 0, wood: 1, hybrid: 2, iron: 3, wedge: 4, putter: 5 };
const TYPE_LABEL = { driver: 'ドライバー', wood: 'フェアウェイウッド', hybrid: 'ユーティリティ', iron: 'アイアン', wedge: 'ウェッジ', putter: 'パター' };
function clubKey(s) {
  if (s == null) return '';
  s = String(s).normalize('NFKC').toUpperCase().replace(/[\s\-_.]/g, '').replace(/番手?/, '番');
  let m;
  if (/^(DR|DRIVER|ドライバー|1W|W1)$/.test(s) || /DRIVER|ドライバー/.test(s)) return 'DR';
  if (/^(PT|PUTTER|パター)/.test(s)) return 'PT';
  if ((m = s.match(/^(\d{1,2})(W|FW|WOOD|ウッド|番ウッド)$/))) return m[1] === '1' ? 'DR' : m[1] + 'W';
  if ((m = s.match(/^W(\d{1,2})$/))) return m[1] + 'W';
  if ((m = s.match(/^(\d)(U|UT|H|HY|HYBRID|ユーティリティ|番ユーティリティ)$/))) return m[1] + 'U';
  if ((m = s.match(/^(U|UT|H)(\d)$/))) return m[2] + 'U';
  if ((m = s.match(/^(\d)(I|IRON|番|アイアン|番アイアン)$/))) return m[1] + 'I';
  if ((m = s.match(/^I(\d)$/))) return m[1] + 'I';
  if ((m = s.match(/^(PW|AW|GW|SW|LW|UW|AS|P|A|G|S|L)$/))) return m[1].length === 1 ? m[1] + 'W' : m[1];
  if ((m = s.match(/^(\d{2})(°|度|DEG)?$/)) && +m[1] >= 44 && +m[1] <= 64) return 'L' + m[1];
  if (/^\d$/.test(s)) return s + 'I';
  return s;
}
function matchClub(label) {
  const k = clubKey(label); if (!k) return null;
  return db.clubs.find(c => clubKey(c.name) === k)
    || (k.startsWith('L') && db.clubs.find(c => isNum(c.loft) && Math.round(c.loft) === +k.slice(1)))
    || null;
}
function sortedClubs() {
  const n = c => { const m = String(c.name).match(/\d+/); return m ? +m[0] : 50; };
  return [...db.clubs].sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || n(a) - n(b) || (a.loft || 0) - (b.loft || 0));
}
const clubById = id => db.clubs.find(c => c.id === id);
function guessType(name) {
  const k = clubKey(name);
  if (k === 'DR') return 'driver'; if (k === 'PT') return 'putter';
  if (/W$/.test(k) && /^\d/.test(k)) return 'wood'; if (/U$/.test(k)) return 'hybrid';
  if (/I$/.test(k)) return 'iron'; if (/^(PW|AW|GW|SW|LW|UW|AS|PW|L\d+|[PAGSL]W)$/.test(k)) return 'wedge';
  return 'iron';
}
const PRESET = [['1W', 'driver', 10.5, 230], ['3W', 'wood', 15, 210], ['5W', 'wood', 18, 195], ['4U', 'hybrid', 22, 185], ['5I', 'iron', 24, 170], ['6I', 'iron', 27, 160], ['7I', 'iron', 31, 150], ['8I', 'iron', 35, 140], ['9I', 'iron', 40, 128], ['PW', 'wedge', 45, 115], ['AW', 'wedge', 50, 100], ['SW', 'wedge', 56, 80], ['PT', 'putter', 3, null]];

// ---------- 統計 ----------
function agg(a) {
  a = a.filter(isNum); if (!a.length) return null;
  const n = a.length, mean = a.reduce((p, c) => p + c, 0) / n;
  const sd = Math.sqrt(a.reduce((p, c) => p + (c - mean) ** 2, 0) / n);
  const s = [...a].sort((x, y) => x - y);
  const q = p => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
  const q1 = q(0.25), q3 = q(0.75);
  // 外れ値（ミスショット）に強いばらつき：四分位範囲から推定。球数が少ないときは標準偏差を使う
  const rsd = n >= 5 ? (q3 - q1) / 1.349 : sd;
  return { n, mean, sd, min: s[0], max: s[n - 1], med: q(0.5), q1, q3, rsd };
}
function clubStats(clubId, src = 'all') {
  const s = db.shots.filter(x => x.clubId === clubId && (src === 'all' || x.src === src));
  const dirs = { L: 0, C: 0, R: 0 };
  s.forEach(x => { if (x.dir) dirs[x.dir]++; else if (isNum(x.side)) dirs[x.side < -5 ? 'L' : x.side > 5 ? 'R' : 'C']++; });
  const smash = s.filter(x => isNum(x.ballSpeed) && isNum(x.clubSpeed) && x.clubSpeed > 0).map(x => x.ballSpeed / x.clubSpeed);
  return { n: s.length, shots: s, carry: agg(s.map(x => x.carry)), total: agg(s.map(x => x.total)), side: agg(s.map(x => x.side)), bs: agg(s.map(x => x.ballSpeed)), hs: agg(s.map(x => x.clubSpeed)), launch: agg(s.map(x => x.launch)), spin: agg(s.map(x => x.spin)), smash: agg(smash), dirs };
}
// AIキャディ用の「その番手の基準キャリー」
function clubCarry(c) {
  const st = clubStats(c.id);
  // 基準は中央値（トップやダフリなどのミスに引っ張られない）
  if (st.carry && st.carry.n >= 3) return { v: st.carry.med, mean: st.carry.mean, sd: st.carry.rsd, n: st.carry.n, min: st.carry.min, max: st.carry.max, how: '実測' };
  if (st.total && st.total.n >= 3) return { v: st.total.med * 0.93, mean: st.total.mean * 0.93, sd: st.total.rsd, n: st.total.n, how: 'コース実測から推定' };
  if (isNum(c.manualCarry)) return { v: c.manualCarry, sd: null, n: 0, how: '自己申告' };
  return null;
}
function tendency(st) {
  const t = st.dirs.L + st.dirs.C + st.dirs.R; if (!t) return '';
  if (st.dirs.R / t > 0.45) return '右に出やすい'; if (st.dirs.L / t > 0.45) return '左に出やすい'; return 'ほぼ真っ直ぐ';
}
function bagSummaryForAI() {
  return sortedClubs().filter(c => c.type !== 'putter').map(c => {
    const cc = clubCarry(c), st = clubStats(c.id);
    let s = `${c.name}`;
    if (cc) s += `: キャリー中央値${Math.round(cc.v)}y` + (cc.n ? `（平均${Math.round(cc.mean)}y、普段の幅±${Math.round(cc.sd)}y、${cc.n}球${isNum(cc.min) ? `、最短${Math.round(cc.min)}〜最長${Math.round(cc.max)}y` : ''}）` : '') + `[${cc.how}]`;
    else s += ': 飛距離データなし';
    if (st.side && st.side.n >= 3) s += `, 左右の中央値${st.side.med >= 0 ? '右' : '左'}${Math.abs(Math.round(st.side.med))}y`;
    const td = tendency(st); if (td) s += `, 傾向:${td}`;
    return s;
  }).join('\n') || '（クラブ未登録）';
}

/* =========================================================
   タブ
   ========================================================= */
const ui = { statsView: 'score', scoreCourse: '', tab: 'round', pos: null, setGreen: false, target: null, statsSrc: 'all', statsClub: null, highlight: [], rangeClub: null, rangeDir: 'C', rangeQ: 2, rangeCarry: null };
function switchTab(tab) {
  ui.tab = tab;
  $$('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  ({ round: renderRound, range: renderRange, clubs: renderClubs, stats: renderStats, settings: renderSettings })[tab]();
}
$$('#tabbar button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

/* =========================================================
   計測データ（弾道測定器・練習場モニター）をカメラで読み込む
   ========================================================= */
async function importMonitorFlow({ sessionId = null, after } = {}) {
  if (!db.clubs.length && !(await confirmBox('クラブが未登録です。読み込んだ番手は自動で登録します。続けますか？', '続ける'))) return;
  const file = await pickFile('#file-image'); if (!file) return;
  try {
    showLoading('画像を準備中…');
    const b64 = await fileToJpegB64(file);
    showLoading('AIが計測データを読み取り中…');
    const txt = await callClaude({
      system: 'あなたはゴルフの弾道測定データを正確に書き起こすアシスタントです。JSONのみを出力します。',
      images: [b64], maxTokens: 4000,
      text: `この画像はゴルフの弾道測定器（トラックマン、GCクワッド、スカイトラック、練習場の打席モニター、ゴルフナビ等）の画面、またはショットデータの表です。写っている全ショットを読み取り、次の形式のJSONだけを返してください。
{"device":"機種やアプリ名(不明ならnull)","club":"画面全体の番手表記(あれば)","distanceUnit":"yd または m","speedUnit":"m/s または mph または km/h","shots":[{"club":"その行の番手表記(なければnull)","carry":数値|null,"total":数値|null,"ballSpeed":数値|null,"clubSpeed":数値|null,"launch":数値|null,"spin":数値|null,"side":数値|null}]}
ルール: sideは左右のブレ量で右をプラス・左をマイナス（L/R表記なら符号に変換）。平均・合計・最大などの集計行は含めない。読めない値はnull。単位が画面に無ければ一般的な表示から推定。`
    });
    hideLoading();
    const data = parseJSON(txt);
    const shots = (data.shots || []).filter(s => isNum(s.carry) || isNum(s.total) || isNum(s.ballSpeed));
    if (!shots.length) { toast('ショットデータが見つかりませんでした。画面全体がはっきり写るように撮影してください', 4500); return; }
    const dm = String(data.distanceUnit || 'yd').toLowerCase().startsWith('m') ? M2YD : 1;
    const su = String(data.speedUnit || 'm/s').toLowerCase();
    const sm = su.includes('mph') ? 0.44704 : su.includes('km') ? 1 / 3.6 : 1;
    const rows = shots.map(s => ({
      label: s.club || data.club || '', carry: isNum(s.carry) ? r1(s.carry * dm) : null, total: isNum(s.total) ? r1(s.total * dm) : null,
      side: isNum(s.side) ? r1(s.side * dm) : null, ballSpeed: isNum(s.ballSpeed) ? r1(s.ballSpeed * sm) : null, clubSpeed: isNum(s.clubSpeed) ? r1(s.clubSpeed * sm) : null,
      launch: isNum(s.launch) ? s.launch : null, spin: isNum(s.spin) ? Math.round(s.spin) : null
    }));
    reviewMonitorRows(rows, data.device, sessionId, after);
  } catch (e) { hideLoading(); toast(e.message, 4500); }
}

function reviewMonitorRows(rows, device, sessionId, after) {
  const clubs = sortedClubs();
  rows.forEach(r => { const m = matchClub(r.label); r.clubId = m ? m.id : (r.label ? 'new:' + r.label : ''); });
  const opts = sel => `<option value="">番手を選択</option>${clubs.map(c => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${[...new Set(rows.filter(r => String(r.clubId).startsWith('new:')).map(r => r.clubId))].map(v => `<option value="${esc(v)}" ${sel === v ? 'selected' : ''}>＋${esc(v.slice(4))}(新規)</option>`).join('')}`;
  const el = openModal(`<h2>読み取り結果の確認</h2>
    <p class="small muted">${device ? esc(device) + '・' : ''}${rows.length}球。番手と数値を確認・修正して保存してください（距離:${U() === 'm' ? 'm' : 'yd'}、速度:m/s）。</p>
    <div class="row" style="margin-bottom:8px"><span class="small">まとめて番手:</span><select id="all-club" style="padding:6px;border-radius:8px">${opts('')}</select></div>
    <div class="scroll-x"><table class="t"><tr><th>✓</th><th>番手</th><th>キャリー</th><th>トータル</th><th>左右</th><th>BS</th><th>HS</th></tr>
    ${rows.map((r, i) => `<tr data-i="${i}"><td><input type="checkbox" class="ck" checked style="width:20px"></td><td><select class="cl">${opts(r.clubId)}</select></td>
      <td><input class="v" data-k="carry" value="${r.carry != null ? Math.round(toDisp(r.carry) * 10) / 10 : ''}"></td>
      <td><input class="v" data-k="total" value="${r.total != null ? Math.round(toDisp(r.total) * 10) / 10 : ''}"></td>
      <td><input class="v" data-k="side" value="${r.side != null ? Math.round(toDisp(r.side) * 10) / 10 : ''}"></td>
      <td><input class="v" data-k="ballSpeed" value="${r.ballSpeed ?? ''}"></td><td><input class="v" data-k="clubSpeed" value="${r.clubSpeed ?? ''}"></td></tr>`).join('')}
    </table></div>
    <button class="btn block" id="mon-save" style="margin-top:12px">保存して統計を見る</button>`);
  $('#all-club', el).onchange = e => { if (e.target.value) $$('.cl', el).forEach(s => s.value = e.target.value); };
  $('#mon-save', el).onclick = () => {
    const added = new Set(); let cnt = 0, missing = 0;
    $$('tr[data-i]', el).forEach(tr => {
      if (!$('.ck', tr).checked) return;
      const r = rows[+tr.dataset.i]; let cid = $('.cl', tr).value;
      if (!cid) { missing++; return; }
      if (cid.startsWith('new:')) {
        const name = cid.slice(4); let c = db.clubs.find(x => clubKey(x.name) === clubKey(name));
        if (!c) { c = { id: uid(), name: name.normalize('NFKC'), type: guessType(name), brand: '', model: '' }; db.clubs.push(c); }
        cid = c.id;
      }
      const get = k => num($(`.v[data-k="${k}"]`, tr).value);
      const conv = v => v == null ? null : r1(fromDisp(v));
      db.shots.push({ id: uid(), clubId: cid, date: new Date().toISOString(), src: 'monitor', sessionId, carry: conv(get('carry')), total: conv(get('total')), side: conv(get('side')), ballSpeed: get('ballSpeed'), clubSpeed: get('clubSpeed'), launch: r.launch, spin: r.spin });
      added.add(cid); cnt++;
    });
    if (missing) { toast(`番手が未選択の行が${missing}件あります`); return; }
    save(); closeModal(); toast(`${cnt}球を保存しました`);
    ui.highlight = [...added];
    if (after) after([...added]); else { ui.statsView = 'club'; ui.statsSrc = 'all'; ui.statsClub = added.size === 1 ? [...added][0] : null; switchTab('stats'); }
  };
}

/* =========================================================
   練習場
   ========================================================= */
const curSession = () => db.activeSession && db.sessions.find(s => s.id === db.activeSession);
function renderRange() {
  const el = $('#range-root'), s = curSession();
  $('#topinfo').textContent = '練習場';
  if (!s) {
    const hist = [...db.sessions].reverse().slice(0, 15).map(x => {
      const n = db.shots.filter(y => y.sessionId === x.id).length;
      return `<div class="list-item"><div class="grow"><b>${new Date(x.date).toLocaleDateString('ja-JP')} ${new Date(x.date).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</b><div class="small muted">${n}球${x.place ? '・' + esc(x.place) : ''}</div></div><button class="btn small light" data-open="${x.id}">詳細</button></div>`;
    }).join('');
    el.innerHTML = `<h2>練習場</h2>
      <div class="card">
        <button class="btn block" id="rg-start">🎯 練習を始める</button>
        <button class="btn block ghost" id="rg-mon">📷 計測モニターの画面を撮影して記録</button>
        <p class="small muted" style="margin:4px 0 0;line-height:1.6">1球ごとに飛距離・方向を入力するか、練習場の打席モニターや弾道測定器の画面を撮影すると、AIが数値を読み取って番手別の統計に追加します。</p>
      </div>
      ${hist ? `<h3>練習履歴</h3><div class="card">${hist}</div>` : ''}`;
    $('#rg-start').onclick = () => startSession();
    $('#rg-mon').onclick = () => { const id = startSession(true); importMonitorFlow({ sessionId: id, after: () => switchTab('range') }); };
    $$('[data-open]', el).forEach(b => b.onclick = () => showSessionDetail(b.dataset.open));
    return;
  }
  const clubs = sortedClubs().filter(c => c.type !== 'putter');
  if (!ui.rangeClub || !clubById(ui.rangeClub)) ui.rangeClub = clubs[0]?.id || null;
  const shots = db.shots.filter(x => x.sessionId === s.id);
  const cc = ui.rangeClub && clubById(ui.rangeClub);
  if (ui.rangeCarry == null && cc) { const v = clubCarry(cc); ui.rangeCarry = v ? Math.round(toDisp(v.v)) : 100; }
  const per = {}; shots.forEach(x => (per[x.clubId] = per[x.clubId] || []).push(x));
  el.innerHTML = `
    <div class="spread"><h2>練習中 <span class="small muted">${shots.length}球</span></h2><button class="btn small danger" id="rg-end">練習終了</button></div>
    ${clubs.length ? `<div class="card">
      <div class="chips" style="margin-bottom:10px">${clubs.map(c => `<button class="chip ${c.id === ui.rangeClub ? 'on' : ''}" data-club="${c.id}">${esc(c.name)}</button>`).join('')}</div>
      <div class="small muted" style="text-align:center">キャリー（${U() === 'm' ? 'm' : 'ヤード'}）</div>
      <div class="carry-input"><button data-d="-10">−10</button><button data-d="-1">−1</button><input id="rg-carry" type="number" inputmode="numeric" value="${ui.rangeCarry ?? ''}"><button data-d="1">＋1</button><button data-d="10">＋10</button></div>
      <div class="seg" style="margin-bottom:8px">${[['L', '← 左'], ['C', '真っ直ぐ'], ['R', '右 →']].map(([k, l]) => `<button data-dir="${k}" class="${ui.rangeDir === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="seg" style="margin-bottom:10px">${[[4, '◎ 会心'], [3, '○ 良い'], [2, '△ まあまあ'], [1, '× ミス']].map(([k, l]) => `<button data-q="${k}" class="${ui.rangeQ === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="btn block" id="rg-add" style="font-size:17px;padding:14px">＋ この1球を記録</button>
    </div>` : `<div class="notice">クラブが未登録です。「クラブ」タブで登録するか、計測モニターの撮影から始めてください。</div>`}
    <div class="grid2"><button class="btn ghost" id="rg-mon2">📷 モニター撮影</button><button class="btn accent" id="rg-coach">🤖 AIコーチ</button></div>
    <h3>今回の番手別</h3>
    <div class="card">${Object.keys(per).length ? `<table class="t"><tr><th>番手</th><th>球数</th><th>中央値</th><th>最大</th><th>幅</th><th>方向 左/中/右</th></tr>
      ${Object.entries(per).map(([cid, arr]) => { const a = agg(arr.map(x => x.carry)); const d = { L: 0, C: 0, R: 0 }; arr.forEach(x => { const k = x.dir || (isNum(x.side) ? (x.side < -5 ? 'L' : x.side > 5 ? 'R' : 'C') : null); if (k) d[k]++; }); return `<tr><td><b>${esc(clubById(cid)?.name || '?')}</b></td><td>${arr.length}</td><td>${a ? fmtN(a.med) : '—'}</td><td>${a ? fmtN(a.max) : '—'}</td><td>${a ? '±' + fmtN(a.rsd) : '—'}</td><td>${d.L}/${d.C}/${d.R}</td></tr>`; }).join('')}</table>` : '<span class="muted small">まだ記録がありません</span>'}</div>
    <h3>記録（新しい順）</h3>
    <div class="card">${shots.slice().reverse().slice(0, 40).map(x => `<div class="shot-line"><span><b>${esc(clubById(x.clubId)?.name || '?')}</b>　${fmt(x.carry)}${x.dir ? '　' + { L: '左', C: '中', R: '右' }[x.dir] : isNum(x.side) ? `　${x.side >= 0 ? '右' : '左'}${fmtN(Math.abs(x.side))}` : ''}${x.q ? '　' + ['', '×', '△', '○', '◎'][x.q] : ''}${x.src === 'monitor' ? ' <span class="badge gray">計測器</span>' : ''}</span><button class="x-btn" data-del="${x.id}">✕</button></div>`).join('') || '<span class="muted small">—</span>'}</div>`;
  $$('[data-club]', el).forEach(b => b.onclick = () => { ui.rangeClub = b.dataset.club; const v = clubCarry(clubById(ui.rangeClub)); const last = shots.filter(x => x.clubId === ui.rangeClub && isNum(x.carry)).pop(); ui.rangeCarry = last ? Math.round(toDisp(last.carry)) : v ? Math.round(toDisp(v.v)) : ui.rangeCarry; renderRange(); });
  $$('[data-d]', el).forEach(b => b.onclick = () => { const i = $('#rg-carry'); i.value = Math.max(0, (num(i.value) || 0) + +b.dataset.d); ui.rangeCarry = num(i.value); });
  $$('[data-dir]', el).forEach(b => b.onclick = () => { ui.rangeDir = b.dataset.dir; $$('[data-dir]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $$('[data-q]', el).forEach(b => b.onclick = () => { ui.rangeQ = +b.dataset.q; $$('[data-q]', el).forEach(x => x.classList.toggle('on', x === b)); });
  $$('[data-del]', el).forEach(b => b.onclick = () => { db.shots = db.shots.filter(x => x.id !== b.dataset.del); save(); renderRange(); });
  if ($('#rg-add')) $('#rg-add').onclick = () => {
    const v = num($('#rg-carry').value); if (!v || v <= 0) { toast('キャリーを入力してください'); return; }
    ui.rangeCarry = v;
    db.shots.push({ id: uid(), clubId: ui.rangeClub, date: new Date().toISOString(), src: 'range', sessionId: s.id, carry: r1(fromDisp(v)), dir: ui.rangeDir, q: ui.rangeQ });
    save(); renderRange(); toast(`${clubById(ui.rangeClub).name} ${Math.round(v)}${U()} 記録`, 1200);
  };
  $('#rg-mon2').onclick = () => importMonitorFlow({ sessionId: s.id, after: () => renderRange() });
  $('#rg-coach').onclick = () => coachSession(s.id);
  $('#rg-end').onclick = async () => {
    const n = db.shots.filter(x => x.sessionId === s.id).length;
    if (!n) { db.sessions = db.sessions.filter(x => x.id !== s.id); db.activeSession = null; save(); renderRange(); return; }
    db.activeSession = null; save(); toast(`お疲れさまでした（${n}球）`); renderRange(); showSessionDetail(s.id);
  };
}
function startSession(silent) {
  const s = { id: uid(), date: new Date().toISOString() };
  db.sessions.push(s); db.activeSession = s.id; save(); ui.rangeCarry = null;
  if (!silent) renderRange();
  return s.id;
}
function sessionText(id) {
  const shots = db.shots.filter(x => x.sessionId === id), per = {};
  shots.forEach(x => (per[x.clubId] = per[x.clubId] || []).push(x));
  return Object.entries(per).map(([cid, arr]) => {
    const a = agg(arr.map(x => x.carry)), d = { L: 0, C: 0, R: 0 }, q = [0, 0, 0, 0, 0];
    arr.forEach(x => { if (x.dir) d[x.dir]++; else if (isNum(x.side)) d[x.side < -5 ? 'L' : x.side > 5 ? 'R' : 'C']++; if (x.q) q[x.q]++; });
    const sd = agg(arr.map(x => x.side)), bs = agg(arr.map(x => x.ballSpeed)), hs = agg(arr.map(x => x.clubSpeed));
    return `${clubById(cid)?.name || '?'}: ${arr.length}球` + (a ? `, キャリー中央値${Math.round(a.med)}y(平均${Math.round(a.mean)}、最小${Math.round(a.min)}〜最大${Math.round(a.max)}、普段の幅±${Math.round(a.rsd)})` : '') + `, 方向 左${d.L}/中${d.C}/右${d.R}` + (sd ? `, 左右平均${r1(sd.mean)}y(σ${r1(sd.sd)})` : '') + (bs ? `, ボール初速${r1(bs.mean)}m/s` : '') + (hs ? `, HS${r1(hs.mean)}m/s` : '') + (q[1] + q[2] + q[3] + q[4] ? `, 手応え ◎${q[4]}○${q[3]}△${q[2]}×${q[1]}` : '');
  }).join('\n');
}
async function coachSession(id) {
  const txt = sessionText(id);
  if (!txt) { toast('まだ記録がありません'); return; }
  try {
    showLoading('AIコーチが分析中…');
    const ans = await callClaude({
      system: 'あなたは経験豊富なゴルフコーチです。日本語で、データに基づいて具体的に、前向きに助言します。見出しは使わず、短い段落と箇条書きで350字程度。',
      text: `今日の練習データ:\n${txt}\n\nこれまでの番手別データ:\n${bagSummaryForAI()}\n\n今日の傾向、気になる点（番手間の飛距離の階段、方向のばらつき等）、残りの時間でやるべき練習ドリルを2〜3個提案してください。`
    });
    hideLoading();
    const sess = db.sessions.find(x => x.id === id); if (sess) { sess.ai = ans; save(); }
    openModal(`<h2>🤖 AIコーチ</h2><div class="ai-answer">${esc(ans)}</div><button class="btn block ghost" style="margin-top:12px" onclick="closeModal()">閉じる</button>`);
  } catch (e) { hideLoading(); toast(e.message, 4500); }
}
function showSessionDetail(id) {
  const s = db.sessions.find(x => x.id === id); if (!s) return;
  const el = openModal(`<h2>${new Date(s.date).toLocaleString('ja-JP')}</h2><div class="card" style="white-space:pre-wrap;line-height:1.7;font-size:13.5px">${esc(sessionText(id).replace(/\d+(\.\d+)?y/g, m => fmt(parseFloat(m))) || '記録なし')}</div>
    ${s.ai ? `<div class="ai-answer">${esc(s.ai)}</div>` : ''}
    <div class="grid2" style="margin-top:12px"><button class="btn accent" id="sd-ai">🤖 AIコーチ</button><button class="btn danger" id="sd-del">削除</button></div>`);
  $('#sd-ai', el).onclick = () => { closeModal(); coachSession(id); };
  $('#sd-del', el).onclick = async () => { closeModal(); if (await confirmBox('この練習記録（ショットデータ含む）を削除しますか？', '削除')) { db.shots = db.shots.filter(x => x.sessionId !== id); db.sessions = db.sessions.filter(x => x.id !== id); save(); renderRange(); } };
}

/* =========================================================
   クラブ
   ========================================================= */
function renderClubs() {
  $('#topinfo').textContent = `${db.clubs.length}本`;
  const el = $('#clubs-root');
  const list = sortedClubs().map(c => {
    const cc = clubCarry(c), st = clubStats(c.id);
    return `<div class="list-item" data-edit="${c.id}"><div class="club-name">${esc(c.name)}</div>
      <div class="grow"><div><b>${esc([c.brand, c.model].filter(Boolean).join(' ') || TYPE_LABEL[c.type] || '')}</b></div>
      <div class="small muted">${[isNum(c.loft) ? c.loft + '°' : '', c.shaft, c.flex].filter(Boolean).map(esc).join('・') || '詳細未入力'}</div></div>
      <div style="text-align:right">${cc ? `<b style="font-size:18px">${fmt(cc.v)}</b><div class="small muted">${st.n ? st.n + '球' : cc.how}</div>` : '<span class="small muted">—</span>'}</div></div>`;
  }).join('');
  el.innerHTML = `<h2>マイクラブ</h2>
    <div class="card">
      <button class="btn block" id="cl-cam">📷 カメラで撮影して登録</button>
      <div class="grid2"><button class="btn ghost" id="cl-add">＋ 手動で追加</button><button class="btn light" id="cl-preset">標準セットを追加</button></div>
      <p class="small muted" style="margin:6px 0 0;line-height:1.6">ヘッドのソールやシャフトのラベル、キャディバッグ全体を撮影すると、AIがメーカー・モデル・番手・ロフト・シャフトを読み取ります。</p>
    </div>
    ${list ? `<div class="card">${list}</div>` : '<p class="muted">まだクラブがありません。</p>'}
    ${db.clubs.length ? `<h3>飛距離の階段</h3><div class="card">${gappingChart()}</div>` : ''}`;
  $('#cl-cam').onclick = clubCameraFlow;
  $('#cl-add').onclick = () => clubForm(null);
  $('#cl-preset').onclick = () => {
    let n = 0; PRESET.forEach(([name, type, loft, carry]) => { if (!db.clubs.some(c => clubKey(c.name) === clubKey(name))) { db.clubs.push({ id: uid(), name, type, loft, manualCarry: carry, brand: '', model: '' }); n++; } });
    save(); renderClubs(); toast(`${n}本追加しました。目安キャリーは編集で調整してください`, 3500);
  };
  $$('[data-edit]', el).forEach(r => r.onclick = () => clubForm(clubById(r.dataset.edit)));
}
function gappingChart() {
  const rows = sortedClubs().filter(c => c.type !== 'putter').map(c => ({ c, cc: clubCarry(c) })).filter(x => x.cc);
  if (!rows.length) return '<span class="small muted">飛距離データがありません</span>';
  const max = Math.max(...rows.map(x => x.cc.v + (x.cc.sd || 0))) * 1.05, W = 300, rowH = 24, H = rows.length * rowH + 6, x0 = 44;
  const sx = v => x0 + (v / max) * (W - x0 - 34);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">${rows.map((x, i) => {
    const y = i * rowH + 4, v = x.cc.v, sd = x.cc.sd || 0, prev = rows[i - 1];
    const gap = prev ? prev.cc.v - v : null, warn = gap != null && (gap < 6 || gap > 22);
    return `<text x="0" y="${y + 15}" font-size="12" font-weight="700" fill="#14532d">${esc(x.c.name)}</text>
      <rect x="${x0}" y="${y + 3}" width="${sx(v) - x0}" height="14" rx="4" fill="${x.cc.how === '実測' ? '#16a34a' : '#a7c4b0'}"/>
      ${sd ? `<line x1="${sx(v - sd)}" x2="${sx(v + sd)}" y1="${y + 10}" y2="${y + 10}" stroke="#14532d" stroke-width="1.5"/>` : ''}
      <text x="${sx(v) + 4}" y="${y + 15}" font-size="11" fill="${warn ? '#dc2626' : '#333'}">${fmtN(v)}${gap != null ? ` (${gap >= 0 ? '-' : '+'}${fmtN(Math.abs(gap))})` : ''}</text>`;
  }).join('')}</svg><div class="small muted">濃い緑=実測（中央値）、薄い緑=自己申告/推定。線は普段の幅。赤字は前の番手との差が小さすぎ/大きすぎ。</div>`;
}
function clubForm(c) {
  const isNew = !c; c = c || { name: '', type: 'iron' };
  const el = openModal(`<h2>${isNew ? 'クラブを追加' : 'クラブを編集'}</h2>
    <div class="grid2"><label class="f">番手（表示名）<input id="cf-name" value="${esc(c.name)}" placeholder="7I, 1W, 52°"></label>
    <label class="f">種類<select id="cf-type">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${c.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
    <div class="grid2"><label class="f">メーカー<input id="cf-brand" value="${esc(c.brand)}"></label><label class="f">モデル<input id="cf-model" value="${esc(c.model)}"></label></div>
    <div class="grid3"><label class="f">ロフト°<input id="cf-loft" inputmode="decimal" value="${c.loft ?? ''}"></label><label class="f">フレックス<input id="cf-flex" value="${esc(c.flex)}"></label><label class="f">目安キャリー(${U() === 'm' ? 'm' : 'yd'})<input id="cf-carry" inputmode="numeric" value="${isNum(c.manualCarry) ? Math.round(toDisp(c.manualCarry)) : ''}"></label></div>
    <label class="f">シャフト<input id="cf-shaft" value="${esc(c.shaft)}"></label>
    <label class="f">メモ<input id="cf-notes" value="${esc(c.notes)}"></label>
    <button class="btn block" id="cf-save">保存</button>
    ${isNew ? '' : `<div class="grid2"><button class="btn ghost" id="cf-stats">📊 統計を見る</button><button class="btn danger" id="cf-del">削除</button></div>`}`);
  $('#cf-name', el).oninput = e => { $('#cf-type', el).value = guessType(e.target.value); };
  $('#cf-save', el).onclick = () => {
    const name = $('#cf-name', el).value.trim().normalize('NFKC'); if (!name) { toast('番手を入力してください'); return; }
    const carry = num($('#cf-carry', el).value);
    Object.assign(c, { name, type: $('#cf-type', el).value, brand: $('#cf-brand', el).value.trim(), model: $('#cf-model', el).value.trim(), loft: num($('#cf-loft', el).value), flex: $('#cf-flex', el).value.trim(), shaft: $('#cf-shaft', el).value.trim(), notes: $('#cf-notes', el).value.trim(), manualCarry: carry != null ? r1(fromDisp(carry)) : null });
    if (isNew) { c.id = uid(); db.clubs.push(c); }
    save(); closeModal(); renderClubs();
  };
  if (!isNew) {
    $('#cf-del', el).onclick = async () => { closeModal(); const n = db.shots.filter(s => s.clubId === c.id).length; if (await confirmBox(`${c.name} を削除しますか？${n ? `（ショットデータ${n}件も削除されます）` : ''}`, '削除')) { db.clubs = db.clubs.filter(x => x.id !== c.id); db.shots = db.shots.filter(s => s.clubId !== c.id); save(); renderClubs(); } };
    $('#cf-stats', el).onclick = () => { closeModal(); ui.statsView = 'club'; ui.statsClub = c.id; switchTab('stats'); };
  }
}
async function clubCameraFlow() {
  const file = await pickFile('#file-image'); if (!file) return;
  try {
    showLoading('画像を準備中…');
    const b64 = await fileToJpegB64(file);
    showLoading('AIがクラブを識別中…');
    const txt = await callClaude({
      system: 'あなたはゴルフクラブに精通したフィッターです。写真からクラブ情報を読み取り、JSONのみを出力します。',
      images: [b64], maxTokens: 2500,
      text: `写真に写っているゴルフクラブ（ヘッド、ソールの刻印、シャフトのラベル、グリップ、キャディバッグ全体、スペック表など）を識別し、次の形式のJSONだけを返してください。
{"clubs":[{"name":"番手の略称（1W,3W,5W,4U,5I〜9I,PW,AW,SW,52°,PTなど）","type":"driver|wood|hybrid|iron|wedge|putter","brand":"メーカー名(カタカナ不要・一般的な表記)","model":"モデル名","loft":数値またはnull,"shaft":"シャフト名と重量など(読めればnull以外)","flex":"S/SR/R/X等またはnull","confidence":"high|medium|low"}]}
アイアンセットなど番手が複数見える場合は番手ごとに要素を作る。刻印やラベルで読めない項目はnull（推測で埋めない。ただしモデルが特定できれば標準ロフトは入れてよい）。`
    });
    hideLoading();
    const data = parseJSON(txt), found = (data.clubs || []).filter(c => c && c.name);
    if (!found.length) { toast('クラブを識別できませんでした。刻印やラベルが写るように撮影してください', 4500); return; }
    const el = openModal(`<h2>読み取り結果</h2><p class="small muted">内容を確認・修正して登録してください。同じ番手が登録済みの場合は上書きします。</p>
      ${found.map((c, i) => `<div class="card" data-i="${i}"><div class="spread"><label class="row"><input type="checkbox" class="ck" checked style="width:20px;height:20px"><b style="font-size:18px">候補 ${i + 1}</b></label>${c.confidence ? `<span class="badge ${c.confidence === 'high' ? '' : 'gray'}">確度 ${({ high: '高', medium: '中', low: '低' })[c.confidence] || c.confidence}</span>` : ''}</div>
        <div class="grid3"><label class="f">番手<input class="name" value="${esc(c.name)}"></label><label class="f">ロフト°<input class="loft" value="${c.loft ?? ''}"></label><label class="f">フレックス<input class="flex" value="${esc(c.flex || '')}"></label></div>
        <div class="grid2"><label class="f">メーカー<input class="brand" value="${esc(c.brand || '')}"></label><label class="f">モデル<input class="model" value="${esc(c.model || '')}"></label></div>
        <label class="f">シャフト<input class="shaft" value="${esc(c.shaft || '')}"></label><input type="hidden" class="type" value="${esc(c.type || '')}"></div>`).join('')}
      <button class="btn block" id="cc-save">登録する</button>`);
    $('#cc-save', el).onclick = () => {
      let n = 0;
      $$('[data-i]', el).forEach(card => {
        if (!$('.ck', card).checked) return;
        const name = $('.name', card).value.trim().normalize('NFKC'); if (!name) return;
        const t = $('.type', card).value, vals = { name, type: TYPE_LABEL[t] ? t : guessType(name), brand: $('.brand', card).value.trim(), model: $('.model', card).value.trim(), loft: num($('.loft', card).value), flex: $('.flex', card).value.trim(), shaft: $('.shaft', card).value.trim() };
        const ex = db.clubs.find(c => clubKey(c.name) === clubKey(name));
        if (ex) Object.assign(ex, vals); else db.clubs.push({ id: uid(), ...vals }); n++;
      });
      save(); closeModal(); renderClubs(); toast(`${n}本を登録しました`);
    };
  } catch (e) { hideLoading(); toast(e.message, 4500); }
}

/* =========================================================
   統計
   ========================================================= */
const SRC = { all: 'すべて', range: '練習場(手入力)', monitor: '計測器', course: 'コース実測' };
function renderStats() {
  $('#topinfo').textContent = `${db.shots.length}球`;
  const el = $('#stats-root');
  if (ui.statsView === 'club' && ui.statsClub && clubById(ui.statsClub)) return renderClubDetail(el, clubById(ui.statsClub));
  ui.statsClub = null;
  const seg = `<div class="seg" style="margin-bottom:12px"><button data-view="score" class="${ui.statsView === 'score' ? 'on' : ''}">📈 スコア分析</button><button data-view="club" class="${ui.statsView === 'club' ? 'on' : ''}">🏌️ クラブ飛距離</button></div>`;
  const bindSeg = () => $$('[data-view]', el).forEach(b => b.onclick = () => { ui.statsView = b.dataset.view; renderStats(); });
  if (ui.statsView === 'score') { $('#topinfo').textContent = `${db.rounds.length}ラウンド`; renderScoreStats(el, seg); bindSeg(); return; }
  const rows = sortedClubs().map(c => ({ c, st: clubStats(c.id, ui.statsSrc) })).filter(x => x.st.n);
  el.innerHTML = seg + `<h2>番手別の統計</h2>
    <div class="card"><button class="btn block" id="st-cam">📷 計測データの画像を読み込む</button><p class="small muted" style="margin:2px 0 0;line-height:1.6">弾道測定器・練習場モニター・アプリ画面のスクリーンショットを撮影/選択すると、登録クラブごとの統計に反映されます。</p></div>
    <div class="chips" style="margin-bottom:10px">${Object.entries(SRC).map(([k, v]) => `<button class="chip ${ui.statsSrc === k ? 'on' : ''}" data-src="${k}">${v}</button>`).join('')}</div>
    ${rows.length ? `<div class="card scroll-x"><table class="t"><tr><th>番手</th><th>球数</th><th>中央値</th><th>平均</th><th>最大</th><th>幅</th><th>トータル</th><th>傾向</th></tr>
      ${rows.map(({ c, st }) => `<tr class="click ${ui.highlight.includes(c.id) ? 'hl' : ''}" data-c="${c.id}"><td><b>${esc(c.name)}</b></td><td>${st.n}</td><td><b>${st.carry ? fmtN(st.carry.med) : '—'}</b></td><td>${st.carry ? fmtN(st.carry.mean) : '—'}</td><td>${st.carry ? fmtN(st.carry.max) : '—'}</td><td>${st.carry ? '±' + fmtN(st.carry.rsd) : '—'}</td><td>${st.total ? fmtN(st.total.med) : '—'}</td><td>${tendency(st) || '—'}</td></tr>`).join('')}
      </table><div class="small muted" style="margin-top:6px">キャリーは<b>中央値</b>（ミスショットに左右されない「普段の距離」）を基準にしています。幅＝普段のばらつき。行をタップすると詳細を表示。単位: ${U() === 'm' ? 'メートル' : 'ヤード'}</div></div>
      <h3>飛距離の階段</h3><div class="card">${gappingChart()}</div>`
      : '<p class="muted">この条件のデータはまだありません。練習場モードで記録するか、計測データの画像を読み込んでください。</p>'}`;
  bindSeg();
  $('#st-cam').onclick = () => importMonitorFlow({});
  $$('[data-src]', el).forEach(b => b.onclick = () => { ui.statsSrc = b.dataset.src; renderStats(); });
  $$('[data-c]', el).forEach(r => r.onclick = () => { ui.statsClub = r.dataset.c; renderStats(); });
}
function renderClubDetail(el, c) {
  const st = clubStats(c.id, ui.statsSrc);
  const box = (l, v) => `<div class="stat-box"><small>${l}</small><b>${v}</b></div>`;
  el.innerHTML = `<div class="spread"><button class="btn small ghost" id="st-back">◀ 一覧</button><div class="chips">${Object.entries(SRC).map(([k, v]) => `<button class="chip ${ui.statsSrc === k ? 'on' : ''}" data-src="${k}" style="padding:5px 9px;font-size:12px">${v.replace('(手入力)', '')}</button>`).join('')}</div></div>
    <h2 style="margin-top:12px">${esc(c.name)} <span class="small muted">${esc([c.brand, c.model].filter(Boolean).join(' '))}${isNum(c.loft) ? ' ' + c.loft + '°' : ''}</span></h2>
    ${st.n ? `<div class="card"><div class="grid3">
      ${box('キャリー（中央値）', st.carry ? fmt(st.carry.med) : '—')}${box('平均', st.carry ? fmt(st.carry.mean) : '—')}${box('球数', st.n)}
      ${box('普段の幅', st.carry ? '±' + fmt(st.carry.rsd) : '—')}${box('最大', st.carry ? fmt(st.carry.max) : '—')}${box('最小', st.carry ? fmt(st.carry.min) : '—')}
      ${box('平均トータル', st.total ? fmt(st.total.mean) : '—')}${box('左右平均', st.side ? (st.side.mean >= 0 ? '右' : '左') + fmt(Math.abs(st.side.mean)) : '—')}${box('方向 左/中/右', `${st.dirs.L}/${st.dirs.C}/${st.dirs.R}`)}
      ${st.bs ? box('ボール初速', r1(st.bs.mean) + 'm/s') : ''}${st.hs ? box('ヘッドスピード', r1(st.hs.mean) + 'm/s') : ''}${st.smash ? box('ミート率', st.smash.mean.toFixed(2)) : ''}
      ${st.launch ? box('打ち出し角', r1(st.launch.mean) + '°') : ''}${st.spin ? box('スピン', Math.round(st.spin.mean) + 'rpm') : ''}
    </div></div>
    ${st.side && st.carry ? `<h3>着弾の散布図</h3><div class="card">${scatter(st.shots)}</div>` : ''}
    ${st.carry && st.carry.n >= 2 ? `<h3>キャリーの推移</h3><div class="card">${trend(st.shots)}</div>` : ''}
    <h3>ショット一覧</h3><div class="card">${st.shots.slice().reverse().slice(0, 60).map(x => `<div class="shot-line"><span class="small muted">${new Date(x.date).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}</span><span>${x.carry != null ? 'C ' + fmt(x.carry) : ''} ${x.total != null ? 'T ' + fmt(x.total) : ''} ${isNum(x.side) ? (x.side >= 0 ? '右' : '左') + fmtN(Math.abs(x.side)) : x.dir ? { L: '左', C: '中', R: '右' }[x.dir] : ''}</span><span class="badge gray">${SRC[x.src].replace('(手入力)', '')}</span><button class="x-btn" data-del="${x.id}">✕</button></div>`).join('')}</div>`
      : '<p class="muted">この条件のデータはまだありません。</p>'}
    <button class="btn block accent" id="st-ai" style="margin-top:8px">🤖 この番手をAIに分析してもらう</button>`;
  $('#st-back').onclick = () => { ui.statsClub = null; renderStats(); };
  $$('[data-src]', el).forEach(b => b.onclick = () => { ui.statsSrc = b.dataset.src; renderStats(); });
  $$('[data-del]', el).forEach(b => b.onclick = () => { db.shots = db.shots.filter(x => x.id !== b.dataset.del); save(); renderStats(); });
  $('#st-ai').onclick = async () => {
    if (!st.n) return toast('データがありません');
    const lines = st.shots.slice(-80).map(x => [x.carry != null ? 'C' + Math.round(x.carry) : '', x.total != null ? 'T' + Math.round(x.total) : '', isNum(x.side) ? 'S' + r1(x.side) : x.dir || '', x.ballSpeed ? 'BS' + x.ballSpeed : '', x.clubSpeed ? 'HS' + x.clubSpeed : '', x.launch ? 'LA' + x.launch : '', x.spin ? 'SP' + x.spin : ''].filter(Boolean).join(' ')).join('\n');
    try {
      showLoading('AIが分析中…');
      const ans = await callClaude({ system: 'あなたはゴルフのフィッター兼コーチです。日本語で、データに基づいて具体的に。見出し無しで300字程度。', text: `クラブ: ${c.name} ${c.brand || ''} ${c.model || ''} ${c.loft ? c.loft + '°' : ''} シャフト:${c.shaft || '不明'} ${c.flex || ''}\nショットデータ(C=キャリーy, T=トータルy, S=左右y 右+, BS/HS=m/s, LA=打出角, SP=スピン):\n${lines}\n\n他の番手:\n${bagSummaryForAI()}\n\nこの番手の傾向、コースでの使い方（狙い方・番手選びの目安）、改善のための練習を提案してください。` });
      hideLoading();
      openModal(`<h2>🤖 ${esc(c.name)} の分析</h2><div class="ai-answer">${esc(ans)}</div><button class="btn block ghost" style="margin-top:12px" onclick="closeModal()">閉じる</button>`);
    } catch (e) { hideLoading(); toast(e.message, 4500); }
  };
}
function scatter(shots) {
  const pts = shots.filter(x => isNum(x.side) && isNum(x.carry)); if (!pts.length) return '';
  const W = 300, H = 260, maxS = Math.max(15, ...pts.map(p => Math.abs(p.side))) * 1.15;
  const cs = pts.map(p => p.carry), lo = Math.min(...cs) * 0.95, hi = Math.max(...cs) * 1.03;
  const sx = s => W / 2 + (s / maxS) * (W / 2 - 16), sy = v => H - 22 - ((v - lo) / ((hi - lo) || 1)) * (H - 40);
  const mc = cs.reduce((a, b) => a + b, 0) / cs.length, ms = pts.reduce((a, p) => a + p.side, 0) / pts.length;
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="background:#ecfdf3;border-radius:10px">
    <line x1="${W / 2}" x2="${W / 2}" y1="8" y2="${H - 20}" stroke="#86efac" stroke-dasharray="4 4"/>
    ${[lo, (lo + hi) / 2, hi].map(v => `<text x="4" y="${sy(v) + 4}" font-size="10" fill="#6b7570">${fmtN(v)}</text>`).join('')}
    <text x="8" y="${H - 6}" font-size="10" fill="#6b7570">← 左 ${fmtN(maxS)}</text><text x="${W - 8}" y="${H - 6}" font-size="10" fill="#6b7570" text-anchor="end">右 ${fmtN(maxS)} →</text>
    ${pts.map(p => `<circle cx="${sx(p.side)}" cy="${sy(p.carry)}" r="5" fill="#16a34a" fill-opacity=".55" stroke="#14532d" stroke-width=".8"/>`).join('')}
    <circle cx="${sx(ms)}" cy="${sy(mc)}" r="8" fill="none" stroke="#dc2626" stroke-width="2.5"/>
  </svg><div class="small muted">赤丸=平均着弾点（キャリー${fmt(mc)}・${ms >= 0 ? '右' : '左'}${fmt(Math.abs(ms))}）</div>`;
}
function trend(shots) {
  const pts = shots.filter(x => isNum(x.carry)); const W = 300, H = 140;
  const cs = pts.map(p => p.carry), lo = Math.min(...cs) * 0.97, hi = Math.max(...cs) * 1.02;
  const sx = i => 28 + i * (W - 36) / Math.max(1, pts.length - 1), sy = v => H - 14 - ((v - lo) / ((hi - lo) || 1)) * (H - 28);
  const avg = []; pts.forEach((p, i) => { const w = cs.slice(Math.max(0, i - 4), i + 1); avg.push(w.reduce((a, b) => a + b, 0) / w.length); });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%">
    ${[lo, hi].map(v => `<text x="0" y="${sy(v) + 4}" font-size="10" fill="#6b7570">${fmtN(v)}</text>`).join('')}
    ${pts.map((p, i) => `<circle cx="${sx(i)}" cy="${sy(p.carry)}" r="3" fill="#86efac"/>`).join('')}
    <polyline fill="none" stroke="#14532d" stroke-width="2" points="${avg.map((v, i) => `${sx(i)},${sy(v)}`).join(' ')}"/>
  </svg><div class="small muted">点=各ショット、線=直近5球の移動平均（古い→新しい）</div>`;
}

/* =========================================================
   設定
   ========================================================= */
function renderSettings() {
  $('#topinfo').textContent = '';
  const s = db.settings, el = $('#settings-root');
  el.innerHTML = `<h2>設定</h2>
    <div class="card">
      <label class="f">Anthropic APIキー（AI機能に必要）<input id="s-key" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-..." autocomplete="off"></label>
      <p class="small muted" style="line-height:1.6;margin-top:-4px">platform.claude.com（Claude Console）でAPIキーを発行して貼り付けてください。キーはこの端末内にだけ保存されます。AIを使うたびに、購入したクレジットから利用料が引かれます。</p>
      <label class="f">ワークスペースID（通常は空欄でOK）<input id="s-ws" value="${esc(s.workspaceId || '')}" placeholder="wrkspc_..." autocomplete="off"></label>
      <label class="f">AIモデル<select id="s-model">
        <option value="claude-sonnet-5-5">Claude Sonnet 5.5（おすすめ・バランス）</option>
        <option value="claude-haiku-5-5">Claude Haiku 5.5（速い・安い）</option>
        <option value="claude-opus-5-5">Claude Opus 5.5（高精度・高コスト）</option></select></label>
      <button class="btn small light" id="s-test">接続テスト</button>
    </div>
    <div class="card">
      <div class="switch"><span>距離の単位</span><select id="s-unit" style="padding:6px;border-radius:8px"><option value="yd">ヤード</option><option value="m">メートル</option></select></div>
      <div class="switch"><span>地図の種類</span><select id="s-map" style="padding:6px;border-radius:8px"><option value="esri">航空写真（Esri・無料）</option><option value="google">Google衛星写真</option><option value="osm">地図（OSM）</option></select></div>
      <div style="padding:10px 0;border-bottom:1px solid var(--line)"><div class="small muted" style="margin-bottom:6px">キャディのスタイル</div>
        <div class="seg"><button data-cs="attack">🔥 攻め</button><button data-cs="balance">⚖️ バランス</button><button data-cs="defend">🛡 守り</button></div>
        <div class="small muted" id="cs-desc" style="margin-top:6px"></div></div>
      <div class="switch"><span>AIの回答を読み上げる</span><input type="checkbox" id="s-voice" ${s.voice ? 'checked' : ''}></div>
      <div style="padding:10px 0;border-bottom:1px solid var(--line)">
        <label class="f" style="margin-bottom:6px">キャディの声<select id="s-vname"><option value="">おまかせ（若い女性の声を自動で選択）</option></select></label>
        <div class="grid2"><label class="f">声の高さ <b id="s-pitch-v"></b><input type="range" id="s-pitch" min="0.8" max="1.6" step="0.05" style="padding:0"></label>
        <label class="f">話す速さ <b id="s-rate-v"></b><input type="range" id="s-rate" min="0.8" max="1.4" step="0.05" style="padding:0"></label></div>
        <button class="btn small light" id="s-vtest">▶ 試しに聞く</button>
      </div>
      <div class="switch" style="border:0"><span>競技モード<br><span class="small muted">AIの番手・攻め方アドバイスを無効化</span></span><input type="checkbox" id="s-comp" ${s.competition ? 'checked' : ''}></div>
    </div>
    <div class="card">
      <label class="f">Google Maps APIキー（Google衛星写真を使う場合）<input id="s-gkey" type="password" value="${esc(s.googleKey || '')}" placeholder="AIza..." autocomplete="off"></label>
      <p class="small muted" style="line-height:1.6;margin-top:-4px">Google Cloud でプロジェクトを作り「Map Tiles API」を有効にしてAPIキーを発行します（請求先の登録が必要。2D地図タイルは毎月10万リクエストまで無料枠あり）。キーは「HTTPリファラー」を <code>${esc(location.origin)}/*</code> に制限しておくと安全です。</p>
      <button class="btn small light" id="s-gtest">Google接続テスト</button>
    </div>
    <div class="card" id="install-card" ${window.__installPrompt ? '' : 'hidden'}><button class="btn block" id="s-install">📲 ホーム画面に追加（アプリとして使う）</button></div>
    <div class="notice">ゴルフ規則では距離計測機器の使用は認められていますが、番手や攻め方の推奨を機器から受けることは公式競技では認められていません。競技に出るときは「競技モード」をオンにしてください。</div>
    <h3>データ</h3>
    <div class="card">
      <p class="small muted" style="margin-top:0">クラブ ${db.clubs.length}本 / ショット ${db.shots.length}球 / コース ${db.courses.length} / ラウンド ${db.rounds.length}</p>
      <div class="grid2"><button class="btn ghost" id="s-export">バックアップ保存</button><button class="btn ghost" id="s-import">バックアップ読込</button></div>
      <button class="btn block danger" id="s-reset" style="margin-top:8px">すべてのデータを削除</button>
    </div>
    <p class="small muted" style="line-height:1.6">地図: Esri World Imagery / Google（Map Tiles API）/ © OpenStreetMap contributors。コースデータ: OpenStreetMap（ODbL）。気象・標高: Open-Meteo。</p>`;
  $('#s-model').value = s.model; $('#s-unit').value = s.unit; $('#s-map').value = s.mapProvider || 'esri';
  $('#s-map').onchange = e => { s.mapProvider = e.target.value; save(); if (map) setBase(s.mapProvider); if (s.mapProvider === 'google' && !s.googleKey) toast('下の欄にGoogle Maps APIキーを入力してください'); };
  $('#s-gkey').onchange = e => { s.googleKey = e.target.value.trim(); s.gSession = null; save(); toast('Google Maps APIキーを保存しました'); if (map && s.mapProvider === 'google') setBase('google'); };
  $('#s-key').onchange = e => { s.apiKey = e.target.value.trim(); save(); toast('APIキーを保存しました'); };
  $('#s-ws').onchange = e => { s.workspaceId = e.target.value.trim(); save(); };
  $('#s-model').onchange = e => { s.model = e.target.value; save(); };
  $('#s-unit').onchange = e => { s.unit = e.target.value; save(); };
  $('#s-voice').onchange = e => { s.voice = e.target.checked; save(); };
  const csShow = () => { const k = caddieStyle(); $$('[data-cs]').forEach(b => b.classList.toggle('on', b.dataset.cs === k)); $('#cs-desc').textContent = CADDIE_STYLES[k].desc; };
  $$('[data-cs]').forEach(b => b.onclick = () => { s.caddieStyle = b.dataset.cs; save(); csShow(); }); csShow();
  const fillVoices = () => {
    const sel = $('#s-vname'); if (!sel) return;
    const vs = jaVoices(), auto = pickVoice();
    sel.innerHTML = `<option value="">おまかせ（若い女性の声を自動で選択）${auto && !s.voiceName ? '：' + esc(auto.name) : ''}</option>` + vs.map(v => `<option value="${esc(v.name)}" ${s.voiceName === v.name ? 'selected' : ''}>${esc(v.name)}${FEMALE_RE.test(v.name) && !isMaleName(v.name) ? '（女性）' : isMaleName(v.name) ? '（男性）' : ''}</option>`).join('');
    if (Bridge && Bridge.speak) { sel.disabled = true; sel.options[0].text = '端末の音声設定を使用'; }
  };
  fillVoices(); try { speechSynthesis.onvoiceschanged = fillVoices; } catch (e) { }
  const pv = isNum(s.voicePitch) ? s.voicePitch : 1.2, rv = isNum(s.voiceRate) ? s.voiceRate : 1.05;
  $('#s-pitch').value = pv; $('#s-rate').value = rv; $('#s-pitch-v').textContent = pv.toFixed(2); $('#s-rate-v').textContent = rv.toFixed(2);
  $('#s-vname').onchange = e => { s.voiceName = e.target.value; save(); };
  $('#s-pitch').oninput = e => { s.voicePitch = +e.target.value; $('#s-pitch-v').textContent = s.voicePitch.toFixed(2); save(); };
  $('#s-rate').oninput = e => { s.voiceRate = +e.target.value; $('#s-rate-v').textContent = s.voiceRate.toFixed(2); save(); };
  $('#s-vtest').onclick = () => { const on = s.voice; s.voice = true; speak('残り150ヤード、少しアゲンストです。7番アイアンでグリーンの真ん中を狙いましょう！'); s.voice = on; };
  $('#s-comp').onchange = e => { s.competition = e.target.checked; save(); };
  $('#s-gtest').onclick = async () => {
    s.googleKey = $('#s-gkey').value.trim(); s.gSession = null; save();
    try { showLoading('Googleに接続中…'); await googleLayer(); hideLoading(); toast('✅ Google衛星写真に接続できました', 3500); if (map) setBase('google'); s.mapProvider = 'google'; save(); $('#s-map').value = 'google'; }
    catch (e) { hideLoading(); toast('❌ ' + e.message, 7000); }
  };
  if ($('#s-install')) $('#s-install').onclick = async () => { const p = window.__installPrompt; if (!p) return; p.prompt(); await p.userChoice; window.__installPrompt = null; $('#install-card').hidden = true; };
  $('#s-test').onclick = async () => {
    s.apiKey = $('#s-key').value.trim(); s.workspaceId = $('#s-ws').value.trim(); save();
    try { showLoading('接続テスト中…'); const t = await callClaude({ system: '日本語で一言だけ返す', text: 'ゴルファーに短い挨拶を', maxTokens: 60 }); hideLoading(); toast('✅ 接続OK：' + t, 4000); }
    catch (e) { hideLoading(); toast('❌ ' + e.message, 5000); }
  };
  $('#s-export').onclick = () => {
    const json = JSON.stringify(Object.assign({}, db, { settings: Object.assign({}, db.settings, { apiKey: '', googleKey: '', gSession: null, workspaceId: '' }) }));
    const name = `aicaddie-backup-${new Date().toISOString().slice(0, 10)}.json`;
    if (Bridge && Bridge.saveFile) { Bridge.saveFile(name, json); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; a.click();
  };
  $('#s-import').onclick = async () => {
    const f = await pickFile('#file-json'); if (!f) return;
    try {
      const d = JSON.parse(await f.text()); if (!d.clubs || !d.shots) throw new Error('形式が違います');
      if (!(await confirmBox('現在のデータをバックアップの内容で置き換えますか？', '置き換え'))) return;
      const key = db.settings.apiKey, gk = db.settings.googleKey; db = mergeDB(d); Object.assign(db.settings, { apiKey: key, googleKey: gk }); flushSave(); toast('読み込みました'); renderSettings();
    } catch (e) { toast('読み込めませんでした: ' + e.message); }
  };
  $('#s-reset').onclick = async () => {
    if (await confirmBox('クラブ・ショット・コース・ラウンドのデータをすべて削除します。元に戻せません。', '全削除')) { const key = db.settings.apiKey, gk = db.settings.googleKey; db = defaultDB(); Object.assign(db.settings, { apiKey: key, googleKey: gk }); flushSave(); stopPlay(); toast('削除しました'); renderSettings(); }
  };
}

// 起動処理は round.js の最後にあります

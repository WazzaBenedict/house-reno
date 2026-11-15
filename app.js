/* 舊屋翻修管理 app。純前端，資料存在 Supabase，離線時先存在裝置上，連線後同步。 */
(() => {
"use strict";

const CFG = window.RENO_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key);
const $ = (s) => document.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem("reno." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("reno." + k, JSON.stringify(v)); } catch { /* 存不下就只留在記憶體 */ } },
  del(k) { try { localStorage.removeItem("reno." + k); } catch { /* ignore */ } },
};

// 一鍵載入連結：#import=<金鑰>。金鑰只在連結裡，repo 裡的 seed.enc 是加密過的。
(() => { const m = location.hash.match(/^#import=([A-Za-z0-9_-]{43})$/); if (m) { LS.set("importKey", m[1]); history.replaceState(null, "", location.pathname); } })();

const TSTAT = ["尚未詢價", "待補圖", "詢價中", "已簽約", "施工中", "已驗收"];
const PSTAT = ["未開始", "進行中", "完成"];
const TABS = [
  ["today", "今天", '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/>'],
  ["schedule", "進度", '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
  ["crew", "工班", '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.5c1.9.8 3 2.6 3 5"/>'],
  ["budget", "預算", '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-1-1.5-1.5-2.8-1.5-1.600 0-2.800.8-2.800 2.100 0 3 5.800 1.300 5.800 4.400 0 1.300-1.300 2.100-3 2.100-1.400 0-2.600-.6-3-1.700M12 6v1.700M12 16.300V18"/>'],
  ["todos", "待辦", '<path d="M4 6.500l1.500 1.500L8 5.500M4 12.500l1.500 1.500L8 11.500M4 18.500l1.500 1.500L8 17.500M11.500 7h9M11.500 13h9M11.500 19h9"/>'],
];

/* ---------- state ---------- */
const S = {
  items: new Map(LS.get("items", []).map((i) => [i.id, i])),
  dirty: new Set(LS.get("dirty", [])),
  session: null, me: LS.get("me", null), members: [], links: LS.get("links", {}),
  ready: false, denied: false, loaded: LS.get("loaded", false), flushing: false, err: null,
  seg: { schedule: "plan", crew: "trades" }, todoAll: LS.get("todoAll", false), rFilter: "",
  sheet: null, form: null, lb: null, confirm: null, authMsg: "", authBusy: false,
  crew: null,
};
let ver = 0;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const pd = (s) => { if (!s) return null; const a = String(s).split("-"); const d = new Date(+a[0], +a[1] - 1, +a[2]); return isNaN(d) ? null : d; };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const iso = (d) => d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
const days = (a, b) => Math.round((b - a) / 864e5);
const fd = (s) => { const d = pd(s); return d ? (d.getMonth() + 1) + "/" + d.getDate() : "未定"; };
const fdy = (s) => { const d = pd(s); return d ? d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate() : "未定"; };
const wk = (s) => { const d = pd(s); return d ? "週" + "日一二三四五六".charAt(d.getDay()) : ""; };
const money = (n) => "NT$ " + Math.round(n || 0).toLocaleString("en-US");
const wan = (n) => (Math.round((n || 0) / 1000) / 10).toLocaleString("en-US") + " 萬";
const photoUrl = (p) => CFG.url + "/storage/v1/object/public/photos/" + p;

function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3200); }

/* ---------- local store ---------- */
let persistT = null;
function persist() {
  clearTimeout(persistT);
  persistT = setTimeout(() => { LS.set("items", [...S.items.values()]); LS.set("dirty", [...S.dirty]); }, 150);
}
const all = (kind) => [...S.items.values()].filter((i) => i.kind === kind && !i.deleted).sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));
const get = (id) => S.items.get(id);
const meta = () => (all("meta")[0] || { data: {} }).data;
function touch(it) { it._v = ++ver; S.items.set(it.id, it); S.dirty.add(it.id); persist(); render(); flush(); }
function create(kind, data, sort) { const it = { id: uid(), kind, data, sort: sort == null ? Date.now() / 1e6 : sort, deleted: false }; touch(it); return it; }
function patch(id, d) { const it = get(id); if (!it) return; it.data = Object.assign({}, it.data, d); touch(it); }
function remove(id) { const it = get(id); if (!it) return; it.deleted = true; touch(it); }

/* ---------- sync ---------- */
async function flush() {
  if (S.flushing || !S.session || !S.dirty.size || !navigator.onLine) { setSync(); return; }
  S.flushing = true; setSync();
  const ids = [...S.dirty];
  const rows = ids.map(get).filter(Boolean);
  const stamp = new Map(rows.map((i) => [i.id, i._v]));
  let error = null;
  try { ({ error } = await sb.from("items").upsert(rows.map((i) => ({ id: i.id, kind: i.kind, data: i.data, sort: i.sort, deleted: !!i.deleted })))); }
  catch (e) { error = e; }
  S.flushing = false;
  if (error) { S.err = error.message || "同步失敗"; setSync(); return; }
  S.err = null;
  ids.forEach((id) => { const it = get(id); if (!it || it._v === stamp.get(id)) S.dirty.delete(id); });
  persist(); setSync();
  if (S.dirty.size) flush();
}
async function pull() {
  if (!S.session || !navigator.onLine || S.denied) return;
  let rows = [];
  try {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from("items").select("id,kind,data,sort,deleted").order("id").range(from, from + 999);
      if (error) throw error;
      rows = rows.concat(data);
      if (data.length < 1000) break;
    }
    const lk = await sb.from("crew_links").select("token,trade_id");
    if (!lk.error) { S.links = {}; lk.data.forEach((l) => { S.links[l.trade_id] = l.token; }); LS.set("links", S.links); }
  } catch (e) { S.err = e.message || "讀取失敗"; setSync(); return; }
  const seen = new Set();
  rows.forEach((r) => { seen.add(r.id); if (!S.dirty.has(r.id)) S.items.set(r.id, r); });
  [...S.items.keys()].forEach((id) => { if (!seen.has(id) && !S.dirty.has(id)) S.items.delete(id); });
  S.loaded = true; LS.set("loaded", true); S.err = null;
  persist(); render(); flush(); linkImport();
}
async function linkImport() {
  const k = LS.get("importKey", null);
  if (!k || !S.ready || !navigator.onLine || linkImport.busy) return;
  linkImport.busy = true;
  try {
    const res = await fetch("seed.enc", { cache: "no-store" });
    if (!res.ok) { toast("規劃資料還沒準備好，請一分鐘後再開一次連結"); return; }
    const buf = new Uint8Array(await res.arrayBuffer());
    const raw = Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    let rows;
    try {
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      rows = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, key, buf.slice(12)))).items;
    } catch { LS.del("importKey"); toast("這條載入連結無效"); return; }
    let n = 0;
    rows.forEach((r, i) => { if (S.items.has(r.id)) return; S.items.set(r.id, { id: r.id, kind: r.kind, data: r.data, sort: r.sort == null ? i : r.sort, deleted: false, _v: ++ver }); S.dirty.add(r.id); n++; });
    LS.del("importKey"); persist(); render(); flush();
    toast(n ? "已載入 " + n + " 筆翻修規劃" : "翻修規劃已經載入過了");
  } catch { toast("沒有載入成功，請再開一次連結"); }
  finally { linkImport.busy = false; }
}
let channel = null;
function listen() {
  if (channel) return;
  channel = sb.channel("items-live").on("postgres_changes", { event: "*", schema: "public", table: "items" }, (p) => {
    const r = p.new;
    if (r && r.id && !S.dirty.has(r.id)) { S.items.set(r.id, { id: r.id, kind: r.kind, data: r.data, sort: r.sort, deleted: r.deleted }); persist(); render(); }
  }).subscribe();
}
function setSync() {
  const el = $("#sync"); if (!el) return;
  let c = "", t = "已同步";
  if (!navigator.onLine) { c = "off"; t = S.dirty.size ? "離線，" + S.dirty.size + " 筆待上傳" : "離線"; }
  else if (S.err) { c = "err"; t = "同步失敗"; }
  else if (S.flushing || S.dirty.size) { c = "busy"; t = "同步中"; }
  el.className = "sync " + c; el.innerHTML = "<i></i>" + t; el.title = S.err || "";
}
window.addEventListener("online", () => { setSync(); pull(); });
window.addEventListener("offline", setSync);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.ready) pull(); });

/* ---------- auth ---------- */
async function onSession(session) {
  const was = S.session && S.session.user.id;
  S.session = session;
  if (!session) { S.ready = false; S.denied = false; render(); return; }
  if (was === session.user.id && S.ready) return;
  const email = (session.user.email || "").toLowerCase();
  if (S.me && S.me.email !== email) { S.items.clear(); S.dirty.clear(); S.me = null; S.loaded = false; LS.del("items"); LS.del("dirty"); LS.del("me"); }
  if (navigator.onLine) {
    try {
      await sb.rpc("claim_owner");
      const { data, error } = await sb.from("members").select("email,role,name");
      if (error) throw error;
      S.members = data || [];
      const me = S.members.find((m) => m.email === email);
      S.me = me ? { email, role: me.role } : null; S.denied = !me;
      if (me) LS.set("me", S.me); else LS.del("me");
    } catch (e) {
      if (!S.me) { S.setupErr = e.message || String(e); S.denied = true; }
    }
  } else if (!S.me) { S.denied = true; }
  S.ready = !S.denied;
  render();
  if (S.ready) { listen(); pull(); }
}
async function authSubmit(mode) {
  const email = $("#au-email").value.trim(), pw = $("#au-pw").value;
  if (!email || pw.length < 6) { S.authMsg = "請輸入 email，密碼至少 6 個字。"; render(); return; }
  S.authBusy = true; S.authMsg = ""; render();
  let res;
  try {
    res = mode === "up"
      ? await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin + location.pathname } })
      : await sb.auth.signInWithPassword({ email, password: pw });
  } catch (e) { res = { error: e }; }
  S.authBusy = false;
  if (res.error) {
    const m = res.error.message || "";
    S.authMsg = /Invalid login/i.test(m) ? "email 或密碼不對。" : /not confirmed/i.test(m) ? "這個 email 還沒驗證，請到信箱點確認連結。" : /already registered/i.test(m) ? "這個 email 已經註冊過，請直接登入。" : /fetch/i.test(m) ? "連不上伺服器，請確認網路。" : "沒有成功：" + m;
  } else if (mode === "up" && !(res.data && res.data.session)) {
    S.authMsg = "確認信已寄到 " + email + "。點信裡的連結後，回到這裡登入。";
  }
  render();
}

/* ---------- photos ---------- */
function shrink(file) {
  return new Promise((res, rej) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(u);
      c.toBlob((b) => (b ? res(b) : rej(new Error("轉檔失敗"))), "image/jpeg", 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error("讀不了這張照片")); };
    img.src = u;
  });
}
async function uploadPhotos(files, prefix) {
  if (!navigator.onLine) { toast("照片要有網路才能上傳"); return []; }
  toast("上傳照片中…");
  const out = []; let fail = 0;
  for (const f of files) {
    try {
      const blob = await shrink(f), path = prefix + "/" + uid() + ".jpg";
      const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: "image/jpeg", upsert: false });
      if (error) throw error;
      out.push(path);
    } catch { fail++; }
  }
  toast(fail ? (out.length ? "有 " + fail + " 張沒上傳成功" : "照片沒上傳成功，請再試一次") : "已加入 " + out.length + " 張照片");
  return out;
}
function photoStrip(list, opt) {
  opt = opt || {};
  const enc = esc(JSON.stringify(list || []));
  return '<div class="photos">' + (list || []).map((p, k) =>
    '<div class="ph"><img src="' + esc(photoUrl(p)) + '" alt="現場照片" loading="lazy" data-a="lightbox" data-list="' + enc + '" data-i="' + k + '">' +
    (opt.del ? '<button type="button" data-a="' + opt.del + '" data-i="' + k + '" data-id="' + esc(opt.id || "") + '" aria-label="移除照片">✕</button>' : "") + "</div>").join("") +
    (opt.add ? '<label class="addph">＋<br>照片<input type="file" accept="image/*" multiple data-up="' + opt.add + '" data-id="' + esc(opt.id || "") + '"></label>' : "") + "</div>";
}

/* ---------- small builders ---------- */
const pill = (t, c) => '<span class="pill ' + (c || "") + '">' + esc(t) + "</span>";
const tpill = (s) => pill(s, { "待補圖": "warn", "詢價中": "acc", "已簽約": "acc", "施工中": "acc", "已驗收": "ok" }[s]);
const ppill = (s) => pill(s, { "進行中": "acc", "完成": "ok" }[s]);
const check = (on, a, id, extra) => '<button type="button" class="checkbox' + (on ? " on" : "") + '" data-a="' + a + '" data-id="' + esc(id) + '"' + (extra || "") + ' aria-pressed="' + !!on + '" aria-label="' + (on ? "標成未完成" : "標成完成") + '">✓</button>';
const seg = (name, cur, opts) => '<div class="seg">' + opts.map((o) => '<button type="button" class="' + (o[0] === cur ? "on" : "") + '" data-a="seg" data-name="' + name + '" data-v="' + o[0] + '">' + o[1] + "</button>").join("") + "</div>";
const bar = (n, d) => '<div class="bar"><i style="width:' + (d ? (n / d) * 100 : 0) + '%"></i></div>';

function totals() {
  let c = 0, p = 0, lo = 0, hi = 0, n = 0;
  all("budget").forEach((b) => { const d = b.data; if (d.contract) { c += +d.contract; n++; } (d.payments || []).forEach((x) => { p += +x.amount || 0; }); if (d.pri === 1) { lo += +d.lo || 0; hi += +d.hi || 0; } });
  return { contract: c, paid: p, lo, hi, n, cap: +meta().cap || 2000000 };
}
function meterHtml(T) {
  const base = Math.max(T.cap, T.contract, 1), c = Math.min(T.contract, T.cap) / base * 100, p = Math.min(T.paid, base) / base * 100, o = T.contract > T.cap ? (T.contract - T.cap) / base * 100 : 0;
  return '<div class="meter"><i class="c" style="width:' + c + '%"></i>' + (o ? '<i class="over" style="left:' + c + "%;width:" + o + '%"></i>' : "") + '<i class="p" style="width:' + p + '%"></i></div>' +
    '<div class="legend"><span><i style="background:var(--accent)"></i>已付款</span><span><i style="background:var(--accent-soft);border:1px solid var(--accent)"></i>已簽約</span>' + (o ? '<span><i style="background:var(--bad)"></i>超出上限</span>' : "") + "</div>";
}
function curPhase() {
  const t = today(), ps = all("phase");
  return ps.find((p) => p.data.status === "進行中") ||
    ps.find((p) => { const a = pd(p.data.start), b = pd(p.data.end); return p.data.status !== "完成" && a && b && a <= t && t <= b; }) ||
    ps.find((p) => p.data.status !== "完成") || null;
}
const openIssues = () => all("report").filter((r) => r.data.issue && !r.data.resolved);
const reportsSorted = () => all("report").sort((a, b) => String(b.data.date || "").localeCompare(String(a.data.date || "")) || ((b.data.created_at || 0) - (a.data.created_at || 0)));

/* ---------- views ---------- */
function vToday() {
  const m = meta(), t = today(), T = totals();
  if (!S.items.size) {
    return '<div class="card"><h2>還沒有翻修資料</h2><p>' + (S.loaded ? "資料庫是空的。請到設定匯入翻修資料檔，或直接從各分頁開始新增。" : "正在從資料庫讀取…") + "</p>" + (S.loaded ? '<button class="btn pri" data-a="settings">開啟設定</button>' : "") + "</div>";
  }
  let h = "";
  const cp = curPhase(), ps = all("phase"), dn = ps.filter((p) => p.data.status === "完成").length;
  const ds = pd(m.start), df = pd(m.finish);
  let head = "";
  if (ds && t < ds) head = "距離開工 " + days(t, ds) + " 天";
  else if (df && t <= df) head = "距離完工目標 " + days(t, df) + " 天";
  else if (df) head = "已超過完工目標 " + days(df, t) + " 天";
  h += '<button class="card hero tap" data-a="tab" data-v="schedule"><h3>' + esc(fdy(iso(t)) + " " + wk(iso(t))) + '</h3><div class="big">' + esc(head || "尚未設定日期") + "</div>" +
    (cp ? '<div class="stack"><span class="title">目前階段：' + esc(cp.data.name) + '</span><span class="sub num">' + fdy(cp.data.start) + " 到 " + fdy(cp.data.end) + "</span></div>" : "") +
    bar(dn, ps.length) + '<span class="sub">' + dn + " / " + ps.length + " 個階段完成</span></button>";

  // 需要處理
  const issues = openIssues();
  const soon = all("todo").filter((x) => !x.data.done && x.data.due && days(t, pd(x.data.due)) <= 7).sort((a, b) => String(a.data.due).localeCompare(String(b.data.due)));
  const visits = all("visit").filter((v) => !v.data.done).map((v) => ({ v, p: get(v.data.phase_id) })).filter((x) => x.p && !x.p.deleted);
  const vSoon = visits.filter((x) => { const a = pd(x.p.data.start); return a && days(t, a) <= 14; });
  h += "<h3>需要你處理</h3>";
  if (!issues.length && !soon.length && !vSoon.length) h += '<div class="card"><p class="sub">目前沒有需要馬上處理的事。</p></div>';
  else {
    h += '<div class="list">';
    issues.forEach((r) => { h += '<div class="li">' + pill("工班問題", "bad") + '<div class="tx" data-a="openReport" data-id="' + r.id + '"><span class="t">' + esc(r.data.issue) + '</span><br><span class="sub">' + esc(r.data.trade || "") + "，" + fd(r.data.date) + " " + esc(r.data.by || "") + '</span></div><button class="btn sm" data-a="resolve" data-id="' + r.id + '">已處理</button></div>'; });
    vSoon.forEach((x) => { h += '<div class="li">' + check(false, "visit", x.v.id) + '<div class="tx" data-a="openPhase" data-id="' + x.p.id + '"><span class="t">' + esc(x.v.data.text) + '</span><br><span class="sub">要本人到場，' + esc(x.p.data.name) + " " + fd(x.p.data.start) + " 起</span></div></div>"; });
    soon.forEach((x) => { const n = days(t, pd(x.data.due)); h += '<div class="li">' + check(false, "todo", x.id) + '<div class="tx" data-a="editTodo" data-id="' + x.id + '"><span class="t">' + esc(x.data.text) + "</span><br>" + pill(n < 0 ? "過期 " + (-n) + " 天" : n === 0 ? "今天到期" : n + " 天後到期", n <= 0 ? "bad" : "warn") + "</div></div>"; });
    h += "</div>";
  }
  const td = all("todo"), left = td.filter((x) => !x.data.done).length;
  let ck = 0, cn = 0; all("stage").forEach((s) => (s.data.checks || []).forEach((c) => { cn++; if (c.done) ck++; }));
  h += '<div class="stats"><button class="stat" data-a="tab" data-v="budget"><div class="k">已簽約</div><div class="v">' + wan(T.contract) + '</div><div class="k">上限 ' + wan(T.cap) + '</div></button>' +
    '<button class="stat" data-a="tab" data-v="todos"><div class="k">待辦</div><div class="v">' + left + '</div><div class="k">件未完成</div></button>' +
    '<button class="stat" data-a="segtab" data-v="schedule" data-s="checks"><div class="k">驗收</div><div class="v">' + ck + " / " + cn + '</div><div class="k">項通過</div></button></div>';

  const next = visits.filter((x) => vSoon.indexOf(x) < 0).slice(0, 3);
  if (next.length) {
    h += '<h3>之後要本人到場</h3><div class="list">';
    next.forEach((x) => { h += '<div class="li"><span class="pill warn num">' + fd(x.p.data.start) + ' 起</span><div class="tx" data-a="openPhase" data-id="' + x.p.id + '">' + esc(x.v.data.text) + "</div></div>"; });
    h += "</div>";
  }
  const rs = reportsSorted().slice(0, 3);
  h += '<div class="row"><h3 class="grow">最新工班回報</h3><button class="btn sm" data-a="segtab" data-v="crew" data-s="reports">全部</button></div>';
  if (!rs.length) h += '<div class="card"><p class="sub">還沒有回報。到「工班」分頁的工種裡產生回報連結，傳給師傅。</p></div>';
  else { h += '<div class="list">'; rs.forEach((r) => { h += '<button class="rowbtn" data-a="openReport" data-id="' + r.id + '"><div class="grow stack"><span>' + pill(r.data.trade || "未分類", "acc") + ' <span class="sub num">' + fd(r.data.date) + " " + esc(r.data.by || "") + '</span></span><span class="t">' + esc((r.data.work || r.data.issue || "").slice(0, 60)) + '</span></div><span class="chev">›</span></button>'; }); h += "</div>"; }
  h += '<div class="row wrap"><button class="btn soft grow" data-a="addTodo">＋ 待辦</button><button class="btn soft grow" data-a="addReport">＋ 回報</button><button class="btn soft grow" data-a="addPayQuick">＋ 付款</button></div>';
  return h;
}

function gantt() {
  const ps = all("phase"), m = meta();
  const ds = ps.map((p) => pd(p.data.start)).filter(Boolean), de = ps.map((p) => pd(p.data.end)).filter(Boolean);
  if (!ds.length || !de.length) return "";
  if (pd(m.deadline)) de.push(pd(m.deadline));
  let min = new Date(Math.min.apply(null, ds)), max = new Date(Math.max.apply(null, de));
  min = new Date(min.getFullYear(), min.getMonth(), 1); max = new Date(max.getFullYear(), max.getMonth() + 1, 1);
  const span = max - min, x = (d) => Math.max(0, Math.min(100, (d - min) / span * 100));
  let g = '<div class="axis">', lines = "";
  for (let d = new Date(min); d < max; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) { g += '<span style="left:' + x(d) + '%">' + (d.getMonth() + 1) + "月</span>"; lines += '<i class="gline" style="left:' + x(d) + '%"></i>'; }
  g += "</div>" + lines;
  [max.getFullYear() - 1, max.getFullYear()].forEach((y) => { const a = new Date(y, 4, 15), b = new Date(y, 5, 20); if (b > min && a < max) g += '<i class="gband" style="left:' + x(a) + "%;width:" + (x(b) - x(a)) + '%"></i>'; });
  const t = today(); if (t >= min && t <= max) g += '<i class="gline today" style="left:' + x(t) + '%"></i>';
  if (pd(m.deadline)) g += '<i class="gline dead" style="left:' + x(pd(m.deadline)) + '%"></i>';
  ps.forEach((p) => { const a = pd(p.data.start), b = pd(p.data.end); if (!a || !b) return; const b2 = new Date(b.getTime() + 864e5);
    g += '<div class="grow-g"><div class="glabel"><span>' + esc(p.data.name) + '</span><span class="sub num">' + fd(p.data.start) + "–" + fd(p.data.end) + '</span></div><div class="gtrack"><i class="gbar ' + (p.data.name === "緩衝" ? "buf" : "s" + Math.max(0, PSTAT.indexOf(p.data.status))) + '" style="left:' + x(a) + "%;width:" + Math.max(0.8, x(b2) - x(a)) + '%"></i></div></div>'; });
  return '<div class="card"><div class="gantt">' + g + '</div><div class="legend"><span><i style="background:var(--muted);opacity:.55"></i>未開始</span><span><i style="background:var(--accent)"></i>進行中</span><span><i style="background:var(--ok)"></i>完成</span><span><i style="background:var(--warn-soft)"></i>梅雨季</span><span><i style="background:var(--bad);width:2px;height:12px"></i>今天</span><span><i style="background:var(--warn);width:2px;height:12px"></i>完工期限</span></div></div>';
}
function vSchedule() {
  let h = seg("schedule", S.seg.schedule, [["plan", "時程"], ["checks", "驗收"]]);
  if (S.seg.schedule === "plan") {
    const ps = all("phase");
    if (!ps.length) return h + '<div class="empty">還沒有時程。按右下角新增階段。</div>';
    h += gantt() + '<div class="list">';
    ps.forEach((p) => { const vs = all("visit").filter((v) => v.data.phase_id === p.id), vd = vs.filter((v) => v.data.done).length;
      h += '<button class="rowbtn" data-a="openPhase" data-id="' + p.id + '"><div class="grow stack"><span class="title">' + esc(p.data.name) + '</span><span class="sub num">' + fdy(p.data.start) + " 到 " + fdy(p.data.end) + (vs.length ? "，到場 " + vd + "/" + vs.length : "") + "</span></div>" + ppill(p.data.status || "未開始") + '<span class="chev">›</span></button>'; });
    return h + "</div>";
  }
  const ss = all("stage");
  if (!ss.length) return h + '<div class="empty">還沒有驗收清單。按右下角新增階段。</div>';
  h += '<p class="sub">每個階段都要在下一個工種進場前驗收，被蓋住之後就看不到了。</p><div class="list">';
  ss.forEach((s) => { const cs = s.data.checks || [], dn = cs.filter((c) => c.done).length;
    h += '<button class="rowbtn" data-a="openStage" data-id="' + s.id + '"><div class="grow stack"><span class="title">' + esc(s.data.name) + "</span>" + bar(dn, cs.length) + "</div>" + pill(dn + " / " + cs.length, cs.length && dn === cs.length ? "ok" : "") + '<span class="chev">›</span></button>'; });
  return h + "</div>";
}

function reportCard(r, crewView) {
  const d = r.data;
  return '<div class="card"><div class="row">' + pill(d.trade || "未分類", "acc") + '<span class="grow sub">' + esc(d.by || "未具名") + (d.people ? "，出工 " + esc(d.people) + " 人" : "") + (d.source === "crew" && !crewView ? "，工班連結" : "") + "</span>" +
    (crewView ? "" : '<button class="btn sm" data-a="editReport" data-id="' + r.id + '">編輯</button>') + "</div>" +
    (d.work ? '<div><h3>今天</h3><p class="pre">' + esc(d.work) + "</p></div>" : "") + (d.next ? '<div><h3>明天</h3><p class="pre">' + esc(d.next) + "</p></div>" : "") +
    (d.issue ? '<div class="note' + (d.resolved ? " ok" : "") + '"><b>' + (d.resolved ? "已處理" : "待處理") + '：</b><span class="pre">' + esc(d.issue) + "</span>" + (crewView ? "" : '<div style="margin-top:8px"><button class="btn sm" data-a="resolve" data-id="' + r.id + '">' + (d.resolved ? "改回待處理" : "標成已處理") + "</button></div>") + "</div>" : "") +
    ((d.photos || []).length ? photoStrip(d.photos) : "") + "</div>";
}
function vCrew() {
  let h = seg("crew", S.seg.crew, [["trades", "工種"], ["reports", "回報"]]);
  if (S.seg.crew === "trades") {
    const tr = all("trade");
    if (!tr.length) return h + '<div class="empty">還沒有工種。按右下角新增。</div>';
    h += '<p class="sub">每個工種至少找 2 到 3 家，給同一份圖和工項清單。只寫「一式」的報價不要收。</p><div class="list">';
    tr.forEach((t) => { const vs = t.data.vendors || [], ch = vs.find((v) => v.chosen);
      h += '<button class="rowbtn" data-a="openTrade" data-id="' + t.id + '"><div class="grow stack"><span class="title">' + esc(t.data.name) + '</span><span class="sub">' + (ch ? "選定 " + esc(ch.name || "未命名") + (ch.quote ? "，" + money(ch.quote) : "") : vs.length ? vs.length + " 家報價" : "還沒有工班") + "</span></div>" + tpill(t.data.status || TSTAT[0]) + '<span class="chev">›</span></button>'; });
    return h + "</div>";
  }
  const rs = reportsSorted(), names = all("trade").map((t) => t.data.name);
  h += '<div class="chips"><button class="chip' + (S.rFilter === "" ? " on" : "") + '" data-a="rf" data-v="">全部</button><button class="chip' + (S.rFilter === "!" ? " on" : "") + '" data-a="rf" data-v="!">待處理問題 ' + openIssues().length + "</button>" +
    names.filter((n) => rs.some((r) => r.data.trade === n)).map((n) => '<button class="chip' + (S.rFilter === n ? " on" : "") + '" data-a="rf" data-v="' + esc(n) + '">' + esc(n) + "</button>").join("") + "</div>";
  const L = rs.filter((r) => !S.rFilter || (S.rFilter === "!" ? (r.data.issue && !r.data.resolved) : r.data.trade === S.rFilter));
  if (!L.length) return h + '<div class="empty">' + (rs.length ? "沒有符合條件的回報。" : "還沒有回報。到工種裡產生回報連結傳給師傅，或按右下角自己記一筆。") + "</div>";
  let last = "";
  L.forEach((r) => { if (r.data.date !== last) { last = r.data.date; h += '<h3 class="num">' + fdy(r.data.date) + " " + wk(r.data.date) + "</h3>"; } h += reportCard(r); });
  return h;
}

function vBudget() {
  const bs = all("budget"), T = totals();
  let h = '<div class="card"><div class="row"><div class="grow"><h3>已簽約</h3><div class="big">' + wan(T.contract) + '</div></div><button class="btn sm" data-a="editMeta">上限 ' + wan(T.cap) + "</button></div>" + meterHtml(T) +
    '<div class="kv"><span>已付款</span><b>' + money(T.paid) + '</b></div><div class="kv"><span>簽約後還沒付</span><b>' + money(Math.max(0, T.contract - T.paid)) + '</b></div><div class="kv"><span>上限還剩</span><b>' + money(T.cap - T.contract) + "</b></div>" +
    (T.contract > T.cap ? '<div class="note">簽約金額已超過上限 ' + money(T.contract - T.cap) + "。</div>" : "") + "</div>";
  if (!bs.length) return h + '<div class="empty">還沒有預算項目。按右下角新增。</div>';
  if (T.hi) h += '<p class="sub">粗估是依一般行情估的區間，沒有查證當地報價，只用來排優先順序。第一優先粗估合計 ' + T.lo + " 到 " + T.hi + " 萬。</p>";
  [[1, "第一優先：這次一定要做"], [2, "第二優先：可以分期或降規格"], [0, "其他項目"]].forEach((g) => {
    const L = bs.filter((b) => (b.data.pri || 0) === g[0]); if (!L.length) return;
    h += "<h3>" + g[1] + '</h3><div class="list">';
    L.forEach((b) => { const d = b.data, c = +d.contract || 0, paid = (d.payments || []).reduce((a, p) => a + (+p.amount || 0), 0), hi = (+d.hi || 0) * 10000;
      const st = c ? (hi && c > hi ? pill("高於粗估", "bad") : paid >= c ? pill("已付清", "ok") : pill("已簽約", "acc")) : pill("未簽約");
      h += '<button class="rowbtn" data-a="openBudget" data-id="' + b.id + '"><div class="grow stack"><span class="title">' + esc(d.name) + '</span><span class="sub num">' + (c ? "簽約 " + money(c) + (paid ? "，已付 " + money(paid) : "") : d.hi ? "粗估 " + d.lo + " 到 " + d.hi + " 萬" : "沒有粗估") + "</span></div>" + st + '<span class="chev">›</span></button>'; });
    h += "</div>";
  });
  return h;
}

function todoGroups() { const gs = (meta().todo_groups || []).slice(); all("todo").forEach((x) => { if (gs.indexOf(x.data.group || "其他") < 0) gs.push(x.data.group || "其他"); }); return gs; }
function vTodos() {
  const td = all("todo"), left = td.filter((x) => !x.data.done).length;
  let h = seg("todoAll", S.todoAll ? "all" : "open", [["open", "未完成 " + left], ["all", "全部 " + td.length]]);
  if (!td.length) return h + '<div class="empty">還沒有待辦。按右下角新增。</div>';
  todoGroups().forEach((g) => {
    const L = td.filter((x) => (x.data.group || "其他") === g), dn = L.filter((x) => x.data.done).length, show = L.filter((x) => S.todoAll || !x.data.done);
    if (!L.length || (!show.length && !S.todoAll)) return;
    h += '<div class="row"><h3 class="grow">' + esc(g) + '</h3><span class="sub num">' + dn + " / " + L.length + '</span></div><div class="list">';
    show.forEach((x) => { const d = x.data, n = d.due ? days(today(), pd(d.due)) : null;
      h += '<div class="li' + (d.done ? " done" : "") + '">' + check(d.done, "todo", x.id) + '<div class="tx" data-a="editTodo" data-id="' + x.id + '"><span class="t" style="font-weight:500">' + esc(d.text) + "</span>" +
        (d.detail ? '<br><span class="sub">' + esc(d.detail) + "</span>" : "") + (d.note ? '<br><span class="sub">備註：' + esc(d.note) + "</span>" : "") +
        (d.due && !d.done ? "<br>" + pill(fd(d.due) + " 到期", n <= 0 ? "bad" : n <= 7 ? "warn" : "") : "") + "</div></div>"; });
    h += "</div>";
  });
  if (!S.todoAll && !left) h += '<div class="empty">全部完成了。</div>';
  return h;
}

/* ---------- detail sheets ---------- */
const SHEETS = {
  phase(id) {
    const p = get(id); if (!p || p.deleted) return null; const d = p.data, vs = all("visit").filter((v) => v.data.phase_id === id);
    let h = '<div class="card"><p class="sub num">' + fdy(d.start) + " " + wk(d.start) + " 到 " + fdy(d.end) + " " + wk(d.end) + "</p>" + (d.desc ? '<p class="pre">' + esc(d.desc) + "</p>" : "") + (d.note ? '<p class="sub pre">備註：' + esc(d.note) + "</p>" : "") + "</div>";
    h += "<h3>狀態</h3>" + '<div class="seg">' + PSTAT.map((s) => '<button type="button" class="' + ((d.status || PSTAT[0]) === s ? "on" : "") + '" data-a="setStatus" data-id="' + id + '" data-v="' + s + '">' + s + "</button>").join("") + "</div>";
    h += "<h3>要本人到場</h3>";
    if (vs.length) { h += '<div class="list">'; vs.forEach((v) => { h += '<div class="li' + (v.data.done ? " done" : "") + '">' + check(v.data.done, "visit", v.id) + '<div class="tx" data-a="editVisit" data-id="' + v.id + '"><span class="t">' + esc(v.data.text) + "</span></div></div>"; }); h += "</div>"; }
    h += '<button class="btn" data-a="addVisit" data-id="' + id + '">＋ 新增到場時間點</button>';
    return { title: d.name, body: h, foot: '<button class="btn grow" data-a="editPhase" data-id="' + id + '">編輯日期和內容</button>' };
  },
  stage(id) {
    const s = get(id); if (!s || s.deleted) return null; const cs = s.data.checks || [], dn = cs.filter((c) => c.done).length;
    let h = '<div class="row">' + '<div class="grow">' + bar(dn, cs.length) + '</div><span class="sub num">' + dn + " / " + cs.length + "</span></div>";
    cs.forEach((c, k) => {
      h += '<div class="card"><div class="row" style="align-items:flex-start">' + check(c.done, "chk", id, ' data-i="' + k + '"') + '<div class="grow' + (c.done ? " sub" : "") + '">' + esc(c.text) + "</div></div>" +
        (c.note ? '<p class="sub pre">備註：' + esc(c.note) + "</p>" : "") + photoStrip(c.photos, { add: "chk:" + k, del: "delChkPhoto:" + k, id }) +
        '<div class="row"><span class="grow"></span><button class="btn sm" data-a="editChk" data-id="' + id + '" data-i="' + k + '">備註和修改</button></div></div>';
    });
    if (!cs.length) h += '<p class="sub">這個階段還沒有檢查項目。</p>';
    return { title: s.data.name, body: h, foot: '<button class="btn" data-a="editStage" data-id="' + id + '">改名稱</button><button class="btn pri grow" data-a="addChk" data-id="' + id + '">＋ 新增檢查項目</button>' };
  },
  trade(id) {
    const t = get(id); if (!t || t.deleted) return null; const d = t.data, vs = d.vendors || [];
    const qs = vs.map((v) => +v.quote || 0).filter(Boolean), low = qs.length > 1 ? Math.min.apply(null, qs) : 0;
    let h = "<h3>狀態</h3>" + '<div class="chips">' + TSTAT.map((s) => '<button class="chip' + ((d.status || TSTAT[0]) === s ? " on" : "") + '" data-a="setStatus" data-id="' + id + '" data-v="' + s + '">' + s + "</button>").join("") + "</div>";
    if (d.scope || d.missing || d.note) h += '<div class="card">' + (d.scope ? '<div><h3>工作範圍</h3><p class="pre">' + esc(d.scope) + "</p></div>" : "") + (d.missing ? '<div><h3>還缺的圖和資訊</h3><p class="pre">' + esc(d.missing) + "</p></div>" : "") + (d.note ? '<div><h3>備註</h3><p class="pre">' + esc(d.note) + "</p></div>" : "") + "</div>";
    h += "<h3>工班和報價</h3>";
    vs.forEach((v, k) => {
      h += '<div class="card"' + (v.chosen ? ' style="border-color:var(--accent);background:var(--accent-soft)"' : "") + '><div class="row"><div class="grow stack"><span class="title">' + esc(v.name || "未命名") + '</span><span class="sub">' + esc([v.contact, v.phone].filter(Boolean).join("，") || "沒有聯絡資料") + "</span></div>" +
        '<div class="stack" style="align-items:flex-end"><b class="num">' + (v.quote ? money(v.quote) : "未報價") + "</b>" + (low && +v.quote === low ? pill("最低", "ok") : "") + "</div></div>" +
        (v.note ? '<p class="sub pre">' + esc(v.note) + "</p>" : "") +
        '<div class="row"><button class="btn sm' + (v.chosen ? " pri" : "") + '" data-a="choose" data-id="' + id + '" data-i="' + k + '">' + (v.chosen ? "已選定" : "選這家") + '</button><span class="grow"></span>' + (v.phone ? '<a class="btn sm" style="display:inline-flex;align-items:center;text-decoration:none" href="tel:' + esc(String(v.phone).replace(/[^0-9+]/g, "")) + '">撥電話</a>' : "") + '<button class="btn sm" data-a="editVendor" data-id="' + id + '" data-i="' + k + '">編輯</button></div></div>';
    });
    if (!vs.length) h += '<p class="sub">還沒有工班。新增後可以並排比較報價。</p>';
    h += '<button class="btn" data-a="addVendor" data-id="' + id + '">＋ 新增工班</button>';
    const tok = S.links[id];
    h += '<h3>工班回報連結</h3><div class="card">' + (tok
      ? '<p class="sub">把這條連結傳給師傅。他不用註冊，打開只看得到這個工種的回報表單和回報紀錄。</p><input class="input" readonly value="' + esc(crewUrl(tok)) + '" onfocus="this.select()"><div class="row"><button class="btn pri grow" data-a="shareLink" data-id="' + id + '">分享或複製連結</button><button class="btn danger" data-a="' + (S.confirm === "link" + id ? "revokeLink" : "ask") + '" data-id="' + id + '" data-k="link' + id + '">' + (S.confirm === "link" + id ? "確定作廢" : "作廢") + "</button></div>"
      : '<p class="sub">產生一條專屬連結，師傅不用註冊就能每天回報進度、問題和照片。</p><button class="btn pri" data-a="makeLink" data-id="' + id + '">產生回報連結</button>') + "</div>";
    return { title: d.name, body: h, foot: '<button class="btn grow" data-a="editTrade" data-id="' + id + '">編輯工種內容</button>' };
  },
  budget(id) {
    const b = get(id); if (!b || b.deleted) return null; const d = b.data, c = +d.contract || 0, ps = d.payments || [], paid = ps.reduce((a, p) => a + (+p.amount || 0), 0);
    let h = '<div class="card">' + (d.hi ? '<div class="kv"><span>粗估</span><b>' + d.lo + " 到 " + d.hi + " 萬</b></div>" : "") + '<div class="kv"><span>簽約金額</span><b>' + (c ? money(c) : "未簽約") + "</b></div>" +
      (c ? '<div class="kv"><span>已付</span><b>' + money(paid) + '</b></div><div class="kv"><span>未付</span><b>' + money(c - paid) + "</b></div>" + bar(Math.min(paid, c), c) : "") +
      (d.hint ? '<p class="sub">' + esc(d.hint) + "</p>" : "") + (d.note ? '<p class="sub pre">備註：' + esc(d.note) + "</p>" : "") + "</div><h3>付款紀錄</h3>";
    if (ps.length) { h += '<div class="list">'; ps.forEach((p, k) => { h += '<button class="rowbtn" data-a="editPay" data-id="' + id + '" data-i="' + k + '"><div class="grow stack"><span class="title num">' + money(p.amount) + '</span><span class="sub num">' + fdy(p.date) + (p.label ? "，" + esc(p.label) : "") + '</span></div><span class="chev">›</span></button>'; }); h += "</div>"; }
    else h += '<p class="sub">還沒有付款。尾款至少留一成到驗收完成。</p>';
    return { title: d.name, body: h, foot: '<button class="btn" data-a="editBudget" data-id="' + id + '">編輯金額</button><button class="btn pri grow" data-a="addPay" data-id="' + id + '">＋ 新增付款</button>' };
  },
  report(id) { const r = get(id); if (!r || r.deleted) return null; return { title: fdy(r.data.date) + " 回報", body: reportCard(r) }; },
  settings() {
    const m = meta(), owner = S.me && S.me.role === "owner";
    let h = '<div class="card"><h3>帳號</h3><div class="kv"><span>' + esc(S.me ? S.me.email : "") + "</span><b>" + (owner ? "屋主" : "成員") + '</b></div><button class="btn" data-a="signOut">登出</button></div>';
    h += '<div class="card"><h3>可以登入的人</h3><p class="sub">加入 email 後，對方用這個 email 在登入頁建立帳號，就看得到全部資料。工班不用加在這裡，用工種裡的回報連結就好。</p>';
    S.members.forEach((x) => { h += '<div class="row"><span class="grow" style="overflow-wrap:anywhere">' + esc(x.email) + "</span>" + (x.role === "owner" ? pill("屋主", "acc") : owner ? '<button class="btn sm danger" data-a="' + (S.confirm === "m" + x.email ? "delMember" : "ask") + '" data-k="m' + esc(x.email) + '" data-v="' + esc(x.email) + '">' + (S.confirm === "m" + x.email ? "確定移除" : "移除") + "</button>" : pill("成員")) + "</div>"; });
    h += owner ? '<button class="btn pri" data-a="addMember">＋ 加入成員</button>' : '<p class="sub">只有屋主可以加入或移除成員。</p>';
    h += "</div>";
    h += '<div class="card"><h3>專案設定</h3><div class="kv"><span>預算上限</span><b>' + money(+m.cap || 2000000) + '</b></div><div class="kv"><span>開工</span><b>' + fdy(m.start) + '</b></div><div class="kv"><span>完工目標</span><b>' + fdy(m.finish) + '</b></div><div class="kv"><span>完工期限</span><b>' + fdy(m.deadline) + '</b></div><button class="btn" data-a="editMeta">修改</button></div>';
    h += '<div class="card"><h3>資料</h3><p class="sub">匯出一份備份檔，或匯入翻修資料檔。匯入同一份檔案不會重複。</p><div class="row wrap"><button class="btn grow" data-a="exportData">匯出備份</button><label class="btn grow" style="display:inline-flex;align-items:center;justify-content:center;cursor:pointer">匯入資料<input type="file" accept="application/json,.json" data-up="import" style="position:absolute;width:1px;height:1px;opacity:0"></label></div></div>';
    h += '<div class="card"><h3>加到主畫面</h3><p class="sub">iPhone：用 Safari 開啟，點分享，再選「加入主畫面」。Android：點瀏覽器選單裡的「安裝應用程式」。裝好後沒網路也能開。</p></div>';
    return { title: "設定", body: h };
  },
};
const crewUrl = (tok) => location.origin + location.pathname + "#/r/" + tok;
function openSheet(type, id) { S.sheet = { type, id }; S.confirm = null; render(); }

/* ---------- forms ---------- */
function openForm(o) { o.v = Object.assign({}, o.value || {}); if (o.fields.some((f) => f.type === "photos")) o.v.photos = (o.v.photos || []).slice(); S.form = o; S.confirm = null; renderForm(); const el = $("#form [data-auto]"); if (el && !("ontouchstart" in window)) el.focus(); }
function fieldHtml(f, v) {
  const val = v[f.k] == null ? "" : v[f.k], id = "ff-" + f.k, common = ' id="' + id + '" name="' + f.k + '"' + (f.auto ? " data-auto" : "");
  if (f.type === "photos") return "<div><h3>" + esc(f.label) + "</h3>" + photoStrip(v.photos, { add: "form", del: "delFormPhoto" }) + "</div>";
  let inp;
  if (f.type === "textarea") inp = "<textarea" + common + ' rows="3" placeholder="' + esc(f.ph || "") + '">' + esc(val) + "</textarea>";
  else if (f.type === "select") inp = "<select" + common + ">" + f.options.map((o) => { const ov = Array.isArray(o) ? o[0] : o, ol = Array.isArray(o) ? o[1] : o; return '<option value="' + esc(ov) + '"' + (String(ov) === String(val) ? " selected" : "") + ">" + esc(ol) + "</option>"; }).join("") + "</select>";
  else inp = "<input" + common + ' type="' + (f.type || "text") + '"' + (f.type === "number" ? ' inputmode="numeric" min="0"' : "") + ' value="' + esc(val) + '" placeholder="' + esc(f.ph || "") + '">';
  return '<label class="f">' + esc(f.label) + inp + "</label>";
}
function renderForm() {
  const o = S.form, el = $("#form");
  if (!o) { el.hidden = true; el.innerHTML = ""; lock(); return; }
  let body = "", row = [];
  const flushRow = () => { if (row.length) { body += '<div class="fields">' + row.join("") + "</div>"; row = []; } };
  o.fields.forEach((f) => { if (f.half) row.push(fieldHtml(f, o.v)); else { flushRow(); body += fieldHtml(f, o.v); } });
  flushRow();
  el.innerHTML = '<form class="panel" id="formEl" novalidate><div class="panel-h"><h2>' + esc(o.title) + '</h2><button type="button" class="x" data-a="closeForm" aria-label="關閉">✕</button></div><div class="panel-b">' + (o.intro ? '<p class="sub">' + esc(o.intro) + "</p>" : "") + body + "</div>" +
    '<div class="panel-f">' + (o.onDelete ? '<button type="button" class="btn danger" data-a="' + (S.confirm === "form" ? "formDelete" : "ask") + '" data-k="form">' + (S.confirm === "form" ? "確定刪除" : "刪除") + "</button>" : "") + '<button type="submit" class="btn pri grow">' + esc(o.saveLabel || "儲存") + "</button></div></form>";
  el.hidden = false; lock();
}
function readForm() {
  const o = S.form, f = $("#formEl"); if (!o || !f) return;
  o.fields.forEach((x) => { if (x.type === "photos") return; const e = f.elements[x.k]; if (!e) return; o.v[x.k] = x.type === "number" ? (e.value === "" ? null : Math.max(0, +e.value)) : e.value.trim(); });
}
function submitForm() {
  const o = S.form; readForm();
  const miss = o.fields.find((x) => x.req && (o.v[x.k] == null || o.v[x.k] === ""));
  if (miss) { toast("請填「" + miss.label + "」"); const e = $("#ff-" + miss.k); if (e) e.focus(); return; }
  const r = o.onSave(o.v);
  if (r === false) return;
  S.form = null; renderForm(); render();
}

/* form definitions */
const tradeOpts = () => all("trade").map((t) => [t.id, t.data.name]);
const F = {
  todo(id, preset) { const x = id ? get(id) : null, gs = todoGroups();
    openForm({ title: x ? "編輯待辦" : "新增待辦", value: x ? x.data : Object.assign({ group: gs[gs.length - 1] || "其他" }, preset),
      fields: [{ k: "text", label: "要做的事", req: 1, auto: !x }, { k: "detail", label: "說明", type: "textarea" }, { k: "group", label: "分類", type: "select", options: gs.length ? gs : ["其他"], half: 1 }, { k: "due", label: "到期日（可不填）", type: "date", half: 1 }, { k: "note", label: "備註、結果、誰回覆的", type: "textarea" }],
      onSave: (v) => { x ? patch(id, v) : create("todo", Object.assign({ done: false }, v)); }, onDelete: x ? () => remove(id) : null }); },
  report(id) { const x = id ? get(id) : null, opts = tradeOpts();
    if (!opts.length) { toast("請先新增工種"); return; }
    openForm({ title: x ? "編輯回報" : "新增回報", value: x ? x.data : { date: iso(today()), trade_id: opts[0][0], by: LS.get("by", "") },
      fields: [{ k: "date", label: "日期", type: "date", req: 1, half: 1 }, { k: "trade_id", label: "工種", type: "select", options: opts, half: 1 }, { k: "by", label: "回報人", half: 1 }, { k: "people", label: "出工人數", type: "number", half: 1 },
        { k: "work", label: "今天做了什麼", type: "textarea" }, { k: "next", label: "明天預計做什麼", type: "textarea" }, { k: "issue", label: "問題、追加，或需要決定的事", type: "textarea", ph: "沒有就留空" }, { k: "photos", label: "照片", type: "photos" }],
      onSave: (v) => { if (!v.work && !v.issue) { toast("請寫下今天做了什麼，或遇到的問題"); return false; } const t = get(v.trade_id); v.trade = t ? t.data.name : ""; LS.set("by", v.by || "");
        x ? patch(id, v) : create("report", Object.assign({ resolved: false, source: "member", created_at: Date.now() }, v)); }, onDelete: x ? () => remove(id) : null }); },
  phase(id) { const x = id ? get(id) : null;
    openForm({ title: x ? "編輯階段" : "新增階段", value: x ? x.data : { status: PSTAT[0] },
      fields: [{ k: "name", label: "階段名稱", req: 1, auto: !x }, { k: "start", label: "開始", type: "date", half: 1 }, { k: "end", label: "結束", type: "date", half: 1 }, { k: "desc", label: "這個階段要做什麼", type: "textarea" }, { k: "note", label: "備註", type: "textarea" }],
      onSave: (v) => { if (v.start && v.end && v.end < v.start) { toast("結束日期不能早於開始日期"); return false; } x ? patch(id, v) : create("phase", v); }, onDelete: x ? () => { remove(id); S.sheet = null; } : null }); },
  visit(id, phaseId) { const x = id ? get(id) : null;
    openForm({ title: x ? "編輯到場時間點" : "新增到場時間點", value: x ? x.data : {}, fields: [{ k: "text", label: "到場要做什麼", type: "textarea", req: 1, auto: !x }],
      onSave: (v) => { x ? patch(id, v) : create("visit", Object.assign({ phase_id: phaseId, done: false }, v)); }, onDelete: x ? () => remove(id) : null }); },
  stage(id) { const x = id ? get(id) : null;
    openForm({ title: x ? "編輯驗收階段" : "新增驗收階段", value: x ? x.data : {}, fields: [{ k: "name", label: "階段名稱", req: 1, auto: 1 }],
      onSave: (v) => { x ? patch(id, v) : create("stage", Object.assign({ checks: [] }, v)); }, onDelete: x ? () => { remove(id); S.sheet = null; } : null }); },
  chk(sid, k) { const s = get(sid), cs = (s.data.checks || []).slice(), c = k == null ? null : cs[k];
    openForm({ title: c ? "檢查項目" : "新增檢查項目", value: c || {}, fields: [{ k: "text", label: "要檢查什麼", type: "textarea", req: 1, auto: !c }, { k: "note", label: "備註", type: "textarea" }],
      onSave: (v) => { if (c) cs[k] = Object.assign({}, c, v); else cs.push(Object.assign({ id: uid(), done: false, photos: [] }, v)); patch(sid, { checks: cs }); },
      onDelete: c ? () => { cs.splice(k, 1); patch(sid, { checks: cs }); } : null }); },
  trade(id) { const x = id ? get(id) : null;
    openForm({ title: x ? "編輯工種" : "新增工種", value: x ? x.data : { status: TSTAT[0] },
      fields: [{ k: "name", label: "工種名稱", req: 1, auto: !x }, { k: "scope", label: "工作範圍", type: "textarea" }, { k: "missing", label: "還缺的圖和資訊", type: "textarea" }, { k: "note", label: "備註", type: "textarea" }],
      onSave: (v) => { x ? patch(id, v) : create("trade", Object.assign({ vendors: [] }, v)); }, onDelete: x ? () => { remove(id); S.sheet = null; } : null }); },
  vendor(tid, k) { const t = get(tid), vs = (t.data.vendors || []).slice(), c = k == null ? null : vs[k];
    openForm({ title: c ? "編輯工班" : "新增工班", value: c || {},
      fields: [{ k: "name", label: "工班或廠商", req: 1, auto: !c }, { k: "contact", label: "聯絡人", half: 1 }, { k: "phone", label: "電話或 LINE", type: "tel", half: 1 }, { k: "quote", label: "報價（元）", type: "number" }, { k: "note", label: "備註（材料品牌、含不含、保固）", type: "textarea" }],
      onSave: (v) => { if (c) vs[k] = Object.assign({}, c, v); else vs.push(Object.assign({ id: uid(), chosen: false }, v)); patch(tid, { vendors: vs }); },
      onDelete: c ? () => { vs.splice(k, 1); patch(tid, { vendors: vs }); } : null }); },
  budget(id) { const x = id ? get(id) : null;
    openForm({ title: x ? "編輯預算項目" : "新增預算項目", value: x ? x.data : { pri: 0 },
      fields: [{ k: "name", label: "項目名稱", req: 1, auto: !x }, { k: "contract", label: "簽約金額（元）", type: "number" }, { k: "lo", label: "粗估下限（萬）", type: "number", half: 1 }, { k: "hi", label: "粗估上限（萬）", type: "number", half: 1 },
        { k: "pri", label: "優先順序", type: "select", options: [[1, "第一優先：這次一定要做"], [2, "第二優先：可以分期"], [0, "其他"]] }, { k: "note", label: "備註", type: "textarea" }],
      onSave: (v) => { v.pri = +v.pri; x ? patch(id, v) : create("budget", Object.assign({ payments: [] }, v)); }, onDelete: x ? () => { remove(id); S.sheet = null; } : null }); },
  pay(bid, k) { const b = get(bid), ps = (b.data.payments || []).slice(), c = k == null ? null : ps[k];
    openForm({ title: (c ? "編輯付款" : "新增付款") + "：" + b.data.name, value: c || { date: iso(today()) },
      fields: [{ k: "amount", label: "金額（元）", type: "number", req: 1, auto: !c }, { k: "date", label: "日期", type: "date", half: 1 }, { k: "label", label: "說明", ph: "訂金、進場、完成、尾款", half: 1 }],
      onSave: (v) => { if (c) ps[k] = Object.assign({}, c, v); else ps.push(Object.assign({ id: uid() }, v)); patch(bid, { payments: ps }); },
      onDelete: c ? () => { ps.splice(k, 1); patch(bid, { payments: ps }); } : null }); },
  payQuick() { const bs = all("budget"); if (!bs.length) { toast("請先新增預算項目"); return; }
    openForm({ title: "新增付款", value: { date: iso(today()), bid: bs[0].id },
      fields: [{ k: "bid", label: "預算項目", type: "select", options: bs.map((b) => [b.id, b.data.name]) }, { k: "amount", label: "金額（元）", type: "number", req: 1 }, { k: "date", label: "日期", type: "date", half: 1 }, { k: "label", label: "說明", ph: "訂金、進場、完成、尾款", half: 1 }],
      onSave: (v) => { const b = get(v.bid); patch(v.bid, { payments: (b.data.payments || []).concat([{ id: uid(), amount: v.amount, date: v.date, label: v.label }]) }); toast("已記到「" + b.data.name + "」"); } }); },
  meta() { const m = all("meta")[0];
    openForm({ title: "專案設定", value: m ? m.data : { cap: 2000000 },
      fields: [{ k: "cap", label: "預算上限（元）", type: "number", req: 1 }, { k: "start", label: "開工日", type: "date", half: 1 }, { k: "finish", label: "完工目標", type: "date", half: 1 }, { k: "deadline", label: "完工期限", type: "date" }],
      onSave: (v) => { m ? patch(m.id, v) : create("meta", v, 0); } }); },
  member() {
    openForm({ title: "加入成員", intro: "對方之後用這個 email 在登入頁建立帳號。", value: {}, saveLabel: "加入", fields: [{ k: "email", label: "Email", type: "email", req: 1, auto: 1 }],
      onSave: (v) => { const email = v.email.toLowerCase(); if (!/^\S+@\S+\.\S+$/.test(email)) { toast("email 格式不對"); return false; }
        sb.from("members").insert({ email, role: "member" }).then(({ error }) => { if (error) toast(/duplicate/i.test(error.message) ? "這個 email 已經在名單裡" : "沒有加入成功：" + error.message); else { S.members.push({ email, role: "member" }); toast("已加入 " + email); render(); } }); } }); },
};

/* ---------- actions ---------- */
const A = {
  tab(el) { location.hash = el.dataset.v; },
  segtab(el) { S.seg[el.dataset.v] = el.dataset.s; location.hash = el.dataset.v; render(); },
  seg(el) { if (el.dataset.name === "todoAll") { S.todoAll = el.dataset.v === "all"; LS.set("todoAll", S.todoAll); } else S.seg[el.dataset.name] = el.dataset.v; },
  rf(el) { S.rFilter = el.dataset.v; },
  ask(el) { S.confirm = el.dataset.k; renderForm(); },
  closeSheet() { S.sheet = null; }, closeForm() { S.form = null; renderForm(); },
  formDelete() { const o = S.form; S.form = null; renderForm(); o.onDelete(); toast("已刪除"); },
  settings() { openSheet("settings"); refreshMembers(); },
  fab() { const t = tab(); if (t === "todos") F.todo(); else if (t === "budget") F.budget(); else if (t === "crew") (S.seg.crew === "trades" ? F.trade() : F.report()); else if (t === "schedule") (S.seg.schedule === "plan" ? F.phase() : F.stage()); },
  addTodo() { F.todo(); }, editTodo(el) { F.todo(el.dataset.id); },
  todo(el) { const x = get(el.dataset.id); patch(x.id, { done: !x.data.done }); },
  visit(el) { const x = get(el.dataset.id); patch(x.id, { done: !x.data.done }); },
  addReport() { F.report(); }, editReport(el) { F.report(el.dataset.id); },
  openReport(el) { openSheet("report", el.dataset.id); },
  resolve(el) { const x = get(el.dataset.id); patch(x.id, { resolved: !x.data.resolved }); },
  openPhase(el) { openSheet("phase", el.dataset.id); }, editPhase(el) { F.phase(el.dataset.id); },
  addVisit(el) { F.visit(null, el.dataset.id); }, editVisit(el) { F.visit(el.dataset.id); },
  setStatus(el) { patch(el.dataset.id, { status: el.dataset.v }); },
  openStage(el) { openSheet("stage", el.dataset.id); }, editStage(el) { F.stage(el.dataset.id); },
  addChk(el) { F.chk(el.dataset.id); }, editChk(el) { F.chk(el.dataset.id, +el.dataset.i); },
  chk(el) { const s = get(el.dataset.id), cs = (s.data.checks || []).slice(), k = +el.dataset.i; cs[k] = Object.assign({}, cs[k], { done: !cs[k].done }); patch(s.id, { checks: cs }); },
  openTrade(el) { openSheet("trade", el.dataset.id); }, editTrade(el) { F.trade(el.dataset.id); },
  addVendor(el) { F.vendor(el.dataset.id); }, editVendor(el) { F.vendor(el.dataset.id, +el.dataset.i); },
  choose(el) { const t = get(el.dataset.id), k = +el.dataset.i; patch(t.id, { vendors: (t.data.vendors || []).map((v, j) => Object.assign({}, v, { chosen: j === k ? !v.chosen : false })) }); },
  async makeLink(el) { const id = el.dataset.id; if (!navigator.onLine) { toast("要有網路才能產生連結"); return; }
    if (S.dirty.has(id)) await flush();
    const { data, error } = await sb.from("crew_links").insert({ trade_id: id }).select("token").single();
    if (error) { toast("沒有產生成功：" + error.message); return; }
    S.links[id] = data.token; LS.set("links", S.links); render(); },
  async revokeLink(el) { const id = el.dataset.id; const { error } = await sb.from("crew_links").delete().eq("trade_id", id);
    if (error) { toast("沒有作廢成功：" + error.message); return; } delete S.links[id]; LS.set("links", S.links); S.confirm = null; toast("連結已作廢"); render(); },
  async shareLink(el) { const t = get(el.dataset.id), url = crewUrl(S.links[t.id]), text = t.data.name + " 每日回報連結";
    try { if (navigator.share) { await navigator.share({ title: text, text, url }); return; } } catch (e) { if (e && e.name === "AbortError") return; }
    try { await navigator.clipboard.writeText(url); toast("連結已複製"); } catch { toast("請長按上面的連結複製"); } },
  openBudget(el) { openSheet("budget", el.dataset.id); }, editBudget(el) { F.budget(el.dataset.id); },
  addPay(el) { F.pay(el.dataset.id); }, editPay(el) { F.pay(el.dataset.id, +el.dataset.i); }, addPayQuick() { F.payQuick(); },
  editMeta() { F.meta(); }, addMember() { F.member(); },
  async delMember(el) { const email = el.dataset.v; const { error } = await sb.from("members").delete().eq("email", email);
    if (error) { toast("沒有移除成功：" + error.message); return; } S.members = S.members.filter((m) => m.email !== email); S.confirm = null; render(); },
  async signOut() { if (S.dirty.size && !navigator.onLine) { toast("還有 " + S.dirty.size + " 筆沒上傳，連上網路後再登出"); return; }
    await flush(); await sb.auth.signOut(); S.items.clear(); S.dirty.clear(); S.me = null; S.sheet = null; ["items", "dirty", "me", "links", "loaded"].forEach(LS.del); S.loaded = false; },
  exportData() { const data = { app: "house-reno", exported_at: new Date().toISOString(), items: [...S.items.values()].filter((i) => !i.deleted).map((i) => ({ id: i.id, kind: i.kind, data: i.data, sort: i.sort })) };
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" })); a.download = "翻修備份-" + iso(today()) + ".json"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
  lightbox(el) { S.lb = { list: JSON.parse(el.dataset.list), i: +el.dataset.i }; renderLb(); },
  lbClose() { S.lb = null; renderLb(); }, lbPrev() { lbMove(-1); }, lbNext() { lbMove(1); },
  delFormPhoto(el) { readForm(); S.form.v.photos.splice(+el.dataset.i, 1); renderForm(); },
  authIn() { authSubmit("in"); }, authUp() { authSubmit("up"); },
  authOut() { sb.auth.signOut(); }, retry() { S.session && onSessionForce(); },
  crewSend() { crewSend(); }, crewDelPhoto(el) { saveCrewDraft(); S.crew.draft.photos.splice(+el.dataset.i, 1); LS.set("crewDraft", S.crew.draft); render(); },
};
function onSessionForce() { const s = S.session; S.session = null; S.ready = false; S.denied = false; S.setupErr = null; onSession(s); }
async function refreshMembers() { if (!navigator.onLine) return; const { data, error } = await sb.from("members").select("email,role,name"); if (!error && data) { S.members = data; render(); } }
function lbMove(n) { const l = S.lb; if (!l) return; l.i = (l.i + n + l.list.length) % l.list.length; renderLb(); }
function renderLb() {
  const el = $("#lightbox"), l = S.lb;
  if (!l) { el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = '<img src="' + esc(photoUrl(l.list[l.i])) + '" alt="現場照片">' + '<button class="lx" data-a="lbClose" aria-label="關閉">✕</button>' + (l.list.length > 1 ? '<button class="lp" data-a="lbPrev" aria-label="上一張">‹</button><button class="ln" data-a="lbNext" aria-label="下一張">›</button><span class="lc num">' + (l.i + 1) + " / " + l.list.length + "</span>" : "");
  el.hidden = false;
}
let tx = null;
$("#lightbox").addEventListener("touchstart", (e) => { tx = e.touches[0].clientX; }, { passive: true });
$("#lightbox").addEventListener("touchend", (e) => { if (tx == null) return; const dx = e.changedTouches[0].clientX - tx; tx = null; if (Math.abs(dx) > 50) lbMove(dx < 0 ? 1 : -1); });

async function importFile(file) {
  let j; try { j = JSON.parse(await file.text()); } catch { toast("這不是可以匯入的檔案"); return; }
  const rows = Array.isArray(j) ? j : j.items;
  if (!Array.isArray(rows)) { toast("這不是可以匯入的檔案"); return; }
  let n = 0;
  rows.forEach((r, k) => { if (!r || !r.kind || typeof r.data !== "object") return; const it = { id: r.id || uid(), kind: r.kind, data: r.data, sort: r.sort == null ? k : r.sort, deleted: false, _v: ++ver }; S.items.set(it.id, it); S.dirty.add(it.id); n++; });
  persist(); render(); flush(); toast("已匯入 " + n + " 筆資料");
}

/* ---------- crew page (no login) ---------- */
function crewToken() { const m = location.hash.match(/^#\/r\/([0-9a-f]{8,64})$/); return m ? m[1] : null; }
async function crewLoad() {
  const tok = crewToken();
  S.crew = S.crew && S.crew.token === tok ? S.crew : { token: tok, state: "loading", draft: Object.assign({ date: iso(today()), by: LS.get("by", ""), people: "", work: "", next: "", issue: "", photos: [] }, (LS.get("crewDraft", null) || {})) };
  if (!S.crew.draft.date) S.crew.draft.date = iso(today());
  render();
  if (!navigator.onLine) { S.crew.state = S.crew.trade ? "ok" : "offline"; render(); return; }
  try { const { data, error } = await sb.rpc("crew_open", { p_token: tok }); if (error) throw error;
    if (!data) S.crew.state = "bad"; else { S.crew.state = "ok"; S.crew.trade = data.trade; S.crew.reports = data.reports || []; }
  } catch { S.crew.state = S.crew.trade ? "ok" : "offline"; }
  render();
}
function saveCrewDraft() { const c = S.crew; if (!c) return; ["date", "by", "people", "work", "next", "issue"].forEach((k) => { const e = $("#cr-" + k); if (e) c.draft[k] = e.value; }); LS.set("crewDraft", c.draft); }
async function crewSend() {
  saveCrewDraft(); const c = S.crew, d = c.draft;
  if (!d.work.trim() && !d.issue.trim()) { toast("請寫下今天做了什麼，或遇到的問題"); return; }
  if (!navigator.onLine) { toast("現在沒有網路。內容已先存在手機裡，有網路後再按送出。"); return; }
  c.sending = true; render();
  const { error } = await sb.rpc("crew_submit", { p_token: c.token, p: { date: d.date, by: d.by.trim(), people: String(d.people || ""), work: d.work.trim(), next: d.next.trim(), issue: d.issue.trim(), photos: d.photos } });
  c.sending = false;
  if (error) { toast(/too many/.test(error.message) ? "回報太頻繁，請稍後再試" : "沒有送出成功，請再試一次"); render(); return; }
  LS.set("by", d.by.trim()); c.draft = { date: iso(today()), by: d.by.trim(), people: "", work: "", next: "", issue: "", photos: [] }; LS.del("crewDraft");
  toast("回報已送出，謝謝"); crewLoad();
}
function vCrewPage() {
  const c = S.crew;
  if (!c || c.state === "loading") return '<div class="boot">讀取中…</div>';
  if (c.state === "bad") return '<div class="auth"><h1>連結已失效</h1><p>這條回報連結不能用了，請向屋主要新的連結。</p></div>';
  if (c.state === "offline") return '<div class="auth"><h1>沒有網路</h1><p>連上網路後再打開這條連結。</p><button class="btn pri" onclick="location.reload()">重新整理</button></div>';
  const d = c.draft, f = (k, label, inp) => '<label class="f">' + label + inp + "</label>";
  let h = '<header class="top"><div class="in"><h1>' + esc(c.trade.name) + ' 每日回報</h1></div></header><main>';
  h += '<div class="card"><div class="fields">' + f("date", "日期", '<input id="cr-date" type="date" value="' + esc(d.date) + '">') + f("by", "回報人", '<input id="cr-by" type="text" value="' + esc(d.by) + '" placeholder="姓名或工班名稱">') + f("people", "今天出工人數", '<input id="cr-people" type="number" inputmode="numeric" min="0" value="' + esc(d.people) + '">') + "</div>" +
    f("work", "今天做了什麼", '<textarea id="cr-work" rows="3" placeholder="例如：二樓主臥廁所給排水管配完，還沒試水">' + esc(d.work) + "</textarea>") +
    f("next", "明天預計做什麼", '<textarea id="cr-next" rows="2" placeholder="例如：一樓廚房配管，下午試水壓">' + esc(d.next) + "</textarea>") +
    f("issue", "問題、追加，或需要屋主決定的事", '<textarea id="cr-issue" rows="2" placeholder="沒有就留空。追加工程請先報價，屋主同意後再施工">' + esc(d.issue) + "</textarea>") +
    "<div><h3>照片</h3>" + photoStrip(d.photos, { add: "crew", del: "crewDelPhoto" }) + "</div>" +
    '<button class="btn pri block" data-a="crewSend"' + (c.sending ? " disabled" : "") + ">" + (c.sending ? "送出中…" : "送出回報") + "</button></div>";
  h += "<h3>最近的回報</h3>";
  if (!(c.reports || []).length) h += '<p class="sub">還沒有回報。</p>';
  (c.reports || []).forEach((r) => { h += '<p class="sub num" style="font-weight:700">' + fdy(r.data.date) + " " + wk(r.data.date) + "</p>" + reportCard(r, true); });
  return h + "</main>";
}

/* ---------- render ---------- */
const VIEWS = { today: vToday, schedule: vSchedule, crew: vCrew, budget: vBudget, todos: vTodos };
const tab = () => { const h = location.hash.replace("#", ""); return VIEWS[h] ? h : "today"; };
function lock() { document.body.classList.toggle("locked", !!(S.sheet || S.form)); }
function vAuth() {
  return '<div class="auth"><img class="logo" src="icons/icon-192.png" alt=""><h1>舊屋翻修管理</h1><p class="sub">屋主和家人請用 email 登入。工班師傅請直接開屋主傳給你的回報連結，不用登入。</p>' +
    '<label class="f">Email<input id="au-email" type="email" autocomplete="email" inputmode="email"></label><label class="f">密碼<input id="au-pw" type="password" autocomplete="current-password"></label>' +
    (S.authMsg ? '<div class="note">' + esc(S.authMsg) + "</div>" : "") +
    '<button class="btn pri block" data-a="authIn"' + (S.authBusy ? " disabled" : "") + '>登入</button><button class="btn block" data-a="authUp"' + (S.authBusy ? " disabled" : "") + ">第一次使用，建立帳號</button></div>";
}
function vDenied() {
  const email = S.session.user.email;
  return '<div class="auth"><h1>' + (S.setupErr ? "資料庫還沒設定好" : "這個帳號還沒被加入") + "</h1>" +
    (S.setupErr ? "<p>登入成功，但讀不到資料表。請確認已在 Supabase 的 SQL Editor 執行過 supabase/schema.sql。</p><p class=\"sub\">" + esc(S.setupErr) + "</p>" : "<p>" + esc(email) + " 不在可以登入的名單裡。請屋主到設定的「可以登入的人」加入這個 email。</p>") +
    '<button class="btn pri block" data-a="retry">再試一次</button><button class="btn block" data-a="authOut">登出</button></div>';
}
function render() {
  const app = $("#app");
  if (crewToken()) { if (!S.crew || S.crew.token !== crewToken()) { crewLoad(); return; } saveCrewDraft(); const a = document.activeElement, fid = a && a.id; app.innerHTML = vCrewPage(); if (fid && $("#" + fid)) $("#" + fid).focus(); return; }
  if (!S.session) { const e = $("#au-email"), p = $("#au-pw"), ev = e ? e.value : "", pv = p ? p.value : ""; app.innerHTML = S.booted ? vAuth() : '<div class="boot">讀取中…</div>'; if ($("#au-email")) { $("#au-email").value = ev; $("#au-pw").value = pv; } closeLayers(); return; }
  if (S.denied) { app.innerHTML = vDenied(); closeLayers(); return; }
  if (!S.ready) { app.innerHTML = '<div class="boot">讀取中…</div>'; return; }
  const t = tab(), sy = window.scrollY, issues = openIssues().length;
  app.innerHTML = '<header class="top"><div class="in"><h1>' + esc(meta().title || "舊屋翻修") + '</h1><span id="sync" class="sync"></span><button class="btn sm" data-a="settings">設定</button></div></header><main>' + VIEWS[t]() + "</main>" +
    (t !== "today" ? '<button class="fab" data-a="fab">＋ 新增</button>' : "") +
    '<nav class="tabs"><div class="in">' + TABS.map((x) => '<a href="#' + x[0] + '" class="' + (x[0] === t ? "on" : "") + '"' + (x[0] === t ? ' aria-current="page"' : "") + '><svg viewBox="0 0 24 24" aria-hidden="true">' + x[2] + "</svg>" + x[1] + (x[0] === "crew" && issues ? '<span class="dot">' + issues + "</span>" : "") + "</a>").join("") + "</div></nav>";
  setSync(); window.scrollTo(0, sy);
  const sh = $("#sheet");
  if (S.sheet) {
    const d = SHEETS[S.sheet.type](S.sheet.id);
    if (!d) { S.sheet = null; sh.hidden = true; sh.innerHTML = ""; }
    else { const b = sh.querySelector(".panel-b"), st = b ? b.scrollTop : 0, same = sh.dataset.k === S.sheet.type + S.sheet.id;
      sh.innerHTML = '<div class="panel"' + (same ? ' style="animation:none"' : "") + '><div class="panel-h"><h2>' + esc(d.title) + '</h2><button class="x" data-a="closeSheet" aria-label="關閉">✕</button></div><div class="panel-b">' + d.body + "</div>" + (d.foot ? '<div class="panel-f">' + d.foot + "</div>" : "") + "</div>";
      sh.dataset.k = S.sheet.type + S.sheet.id; sh.hidden = false; if (same) sh.querySelector(".panel-b").scrollTop = st; }
  } else { sh.hidden = true; sh.innerHTML = ""; sh.dataset.k = ""; }
  lock();
}
function closeLayers() { S.sheet = null; S.form = null; $("#sheet").hidden = true; $("#form").hidden = true; lock(); }

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-a]");
  if (!el) { if (e.target.id === "sheet") { S.sheet = null; render(); } return; }
  const a = el.dataset.a;
  if (!A[a]) return;
  if (a !== "ask") S.confirm = null;
  const r = A[a](el);
  if ((r && r.then) || /^(lightbox|lb)/.test(a) || S.form) return; // 非同步動作和表單自己會重畫
  render();
});
document.addEventListener("submit", (e) => { e.preventDefault(); if (e.target.id === "formEl") submitForm(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { if (S.lb) { S.lb = null; renderLb(); } else if (S.form) { S.form = null; renderForm(); } else if (S.sheet) { S.sheet = null; render(); } }
  if (e.key === "Enter" && e.target.id === "au-pw") authSubmit("in");
});
document.addEventListener("change", async (e) => {
  const t = e.target, up = t.dataset && t.dataset.up; if (!up) return;
  const files = [...(t.files || [])]; if (!files.length) return;
  if (up === "import") { importFile(files[0]); t.value = ""; return; }
  if (up === "form") { readForm(); const o = S.form; const got = await uploadPhotos(files, "m"); if (S.form === o) { readForm(); o.v.photos = o.v.photos.concat(got); renderForm(); } return; }
  if (up === "crew") { saveCrewDraft(); const got = await uploadPhotos(files, "crew"); saveCrewDraft(); S.crew.draft.photos = S.crew.draft.photos.concat(got).slice(0, 8); LS.set("crewDraft", S.crew.draft); render(); return; }
  if (up.indexOf("chk:") === 0) { const k = +up.slice(4), sid = t.dataset.id; const got = await uploadPhotos(files, "m"); const s = get(sid); if (!s || !got.length) return; const cs = (s.data.checks || []).slice(); cs[k] = Object.assign({}, cs[k], { photos: (cs[k].photos || []).concat(got) }); patch(sid, { checks: cs }); }
});
document.addEventListener("click", (e) => { // 驗收照片移除（動作名稱帶索引）
  const el = e.target.closest('[data-a^="delChkPhoto:"]'); if (!el) return;
  const k = +el.dataset.a.split(":")[1], s = get(el.dataset.id), cs = (s.data.checks || []).slice(), ph = (cs[k].photos || []).slice();
  ph.splice(+el.dataset.i, 1); cs[k] = Object.assign({}, cs[k], { photos: ph }); patch(s.id, { checks: cs });
});
document.addEventListener("input", (e) => { if (e.target.id && e.target.id.indexOf("cr-") === 0) { clearTimeout(saveCrewDraft.t); saveCrewDraft.t = setTimeout(saveCrewDraft, 400); } });
window.addEventListener("hashchange", () => { S.sheet = null; S.form = null; renderForm(); if (crewToken()) crewLoad(); else { render(); window.scrollTo(0, 0); } });

/* ---------- boot ---------- */
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
if (crewToken()) crewLoad();
else {
  sb.auth.onAuthStateChange((ev, session) => { setTimeout(() => { S.booted = true; onSession(session); }, 0); });
  sb.auth.getSession().then(({ data }) => { S.booted = true; if (!data.session) render(); }).catch(() => { S.booted = true; render(); });
}
})();

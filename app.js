/* appMoove - オフライン動画プレイヤー (Phase 1) */
"use strict";

const APP_VERSION = "0.4.1";
const $ = (id) => document.getElementById(id);
const video = $("video");
const audio = $("audio");
const listEl = $("list");
const importProgressEl = $("import-progress");

// 今アクティブな再生要素。音声アイテムは<audio>で鳴らす（iOSでロック中・裏に回しても止まりにくい）
let media = video;
let currentId = null;
let currentURL = null;
let lastSavedPos = 0;
let videos = []; // メタデータキャッシュ（addedAt昇順）

/* ---------- IndexedDB (メタデータ) ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("moove", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("videos", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function dbOp(mode, fn) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction("videos", mode);
    const req = fn(tx.objectStore("videos"));
    tx.oncomplete = () => res(req && req.result);
    tx.onerror = () => rej(tx.error);
  });
}
const dbPut = (v) => dbOp("readwrite", (s) => s.put(v));
const dbDelete = (id) => dbOp("readwrite", (s) => s.delete(id));
const dbAll = () => dbOp("readonly", (s) => s.getAll());

/* ---------- 表示ユーティリティ ---------- */
function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + " MB";
  return Math.max(1, Math.round(bytes / 1e3)) + " KB";
}
// 取得済みバイト数の表示用（合計不明のとき「12.3MB」のように小数1桁で出す）
function fmtLoaded(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + "GB";
  return (bytes / 1e6).toFixed(1) + "MB";
}
function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- 種別（音声/動画）判定 ---------- */
const EXT_MIME = {
  mp3: "audio/mpeg", m4a: "audio/mp4", m4b: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac",
  aif: "audio/aiff", aiff: "audio/aiff", caf: "audio/x-caf",
  mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm",
  "3gp": "video/3gpp", mkv: "video/x-matroska",
};
function extOfName(name) {
  const m = /\.([^./\\]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
}
function mimeFromExt(nameOrExt) {
  const ext = String(nameOrExt || "").toLowerCase().replace(/^.*\./, "");
  return EXT_MIME[ext] || "";
}
// ブラウザ/OSごとの別名を、<audio>/<video>が素直に受け取る標準的な名前にそろえる
const MIME_ALIAS = {
  "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4", "audio/x-m4b": "audio/mp4", "audio/m4b": "audio/mp4",
  "audio/mp3": "audio/mpeg", "audio/x-mp3": "audio/mpeg", "audio/x-mpeg": "audio/mpeg", "audio/mpeg3": "audio/mpeg", "audio/x-mpeg-3": "audio/mpeg",
  "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
  "audio/x-flac": "audio/flac", "audio/x-aac": "audio/aac", "audio/aacp": "audio/aac",
  "audio/x-aiff": "audio/aiff", "audio/opus": "audio/ogg", "application/ogg": "audio/ogg",
};
// Content-Type等から「audio/xxx」「video/xxx」だけを取り出す（; charset等は捨てる。それ以外は空）
function mediaMime(ct) {
  let t = String(ct || "").split(";")[0].trim().toLowerCase();
  t = MIME_ALIAS[t] || t;
  return /^(audio|video)\//.test(t) ? t : "";
}
// 明らかに動画・音声やない拡張子（type が空で来ても弾けるように）
const NON_MEDIA_EXT = /^(pdf|jpe?g|png|gif|heic|heif|webp|bmp|tiff?|svg|zip|rar|7z|gz|tar|txt|rtf|md|csv|json|xml|html?|docx?|xlsx?|pptx?|pages|numbers|key|epub|ipa|apk|exe|dmg|srt|vtt|ass)$/;
// 取り込むファイルの保存MIMEを決める。動画でも音声でもなさそうなら "" を返す
// 優先: 拡張子が音声（iOSは m4a を video/mp4 等で渡すこともある）→ file.type → 拡張子 → 既定（動画）
function importMime(file) {
  const ext = extOfName(file.name);
  const byExt = mimeFromExt(ext);
  const raw = String(file.type || "").split(";")[0].trim().toLowerCase();
  const byType = mediaMime(raw);
  if (/^audio\//.test(byExt)) return byExt;
  if (byType) return byType;
  if (byExt) return byExt;
  // type が中身を示しとって（octet-stream 等の「不明」以外）、それが動画・音声やないなら弾く
  if (raw && raw !== "application/octet-stream") return "";
  if (NON_MEDIA_EXT.test(ext)) return "";
  // 拡張子も type も手がかりなし: 従来どおり動画扱い（再生できるかは中身次第）
  return "video/mp4";
}
// 種別情報(kind)を持たん古いレコードは type で判定し、それも無ければ動画扱い
function isAudio(meta) {
  if (meta.kind) return meta.kind === "audio";
  return /^audio\//.test(meta.type || "");
}

async function refreshStorageMeter() {
  if (!navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    $("storage").hidden = false;
    $("storage-text").textContent =
      `使用 ${fmtSize(usage || 0)} / 空き枠 ${fmtSize(quota || 0)}`;
    $("storage-fill").style.width = quota ? Math.min(100, (usage / quota) * 100) + "%" : "0";
  } catch (_) { /* 表示だけの機能なので握りつぶす */ }
}

/* ---------- 一覧 ---------- */
async function renderList() {
  videos = (await dbAll()).sort((a, b) => a.addedAt - b.addedAt);
  if (!videos.length) {
    listEl.innerHTML = `<div class="empty"><div class="big">🎬</div>まだ何も入ってへんで。<br>「＋ 動画・音声を取り込む」から mp4 や mp3 等を入れてや。</div>`;
    return;
  }
  listEl.innerHTML = videos.map((v) => {
    const pct = v.duration ? Math.min(100, (v.position / v.duration) * 100) : 0;
    const dur = v.duration ? fmtTime(v.duration) : "";
    const pos = v.position > 3 ? `・続き ${fmtTime(v.position)}` : "";
    const kind = isAudio(v)
      ? `<span class="kind audio" title="音声">🎵</span>`
      : `<span class="kind" title="動画">🎬</span>`;
    return `<div class="item ${v.id === currentId ? "playing" : ""}" data-id="${v.id}">
      <div class="info">
        <div class="title">${kind}${esc(v.name)}</div>
        <div class="meta">${fmtSize(v.size)}${dur ? "・" + dur : ""}${pos}</div>
        <div class="watchbar"><i style="width:${pct}%"></i></div>
      </div>
      <button class="del" data-del="${v.id}" aria-label="削除">✕</button>
    </div>`;
  }).join("");
}

listEl.addEventListener("click", async (e) => {
  const delId = e.target.dataset && e.target.dataset.del;
  if (delId) {
    e.stopPropagation();
    const v = videos.find((x) => x.id === delId);
    if (!confirm(`「${v ? v.name : ""}」を削除するで。ええか？`)) return;
    await removeVideo(delId);
    return;
  }
  const item = e.target.closest(".item");
  if (item) play(item.dataset.id);
});

async function removeVideo(id) {
  if (id === currentId) {
    media.pause();
    media.removeAttribute("src");
    media.load();
    currentId = null;
    $("player-box").classList.remove("show", "audio-mode");
    if (currentURL) { URL.revokeObjectURL(currentURL); currentURL = null; }
  }
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(id);
  } catch (_) { /* 実体が既に無くてもメタは消す */ }
  await dbDelete(id);
  await renderList();
  refreshStorageMeter();
}

/* ---------- 取り込み (Worker → OPFS) ---------- */
const worker = new Worker("store-worker.js");
const pendingImports = new Map(); // id -> {file, rowEl}

function showFatal(msg) {
  const el = document.createElement("div");
  el.className = "progress-row error";
  el.innerHTML = `<div class="name"></div>`;
  el.querySelector(".name").textContent = "⚠ " + msg;
  importProgressEl.appendChild(el);
}
worker.onerror = (e) => showFatal(`Workerエラー: ${e.message || "不明"}（${e.filename}:${e.lineno}）`);

/* 取り込み中は画面を消灯させない（iOSはロック時にAccessHandleを閉じるため） */
let wakeLock = null;
async function acquireWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch (_) { /* 非対応・拒否時はリトライ機構に任せる */ }
}
function releaseWakeLockIfIdle() {
  if (!pendingImports.size && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pendingImports.size) acquireWakeLock();
});
window.addEventListener("error", (e) => showFatal(`アプリエラー: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => showFatal(`エラー: ${(e.reason && e.reason.message) || e.reason}`));

worker.onmessage = async (e) => {
  const { id, type, written, total, message, mime } = e.data;
  const p = pendingImports.get(id);
  if (!p) return;
  const label = p.name || (p.file ? p.file.name : "video");
  if (type === "progress") {
    if (total > 0) {
      // total は cobalt の推定値（Estimated-Content-Length）のこともあるので 100% で頭打ちにする
      const pct = Math.min(100, Math.round((written / total) * 100));
      p.rowEl.classList.remove("indeterminate");
      p.rowEl.querySelector("i").style.width = pct + "%";
      p.rowEl.querySelector(".name").textContent = `${label}（${fmtSize(total)}）取り込み中… ${pct}%`;
    } else {
      // total不明（CORSプロキシがContent-Lengthを通さん等）= 取得済みバイト数だけ出す＋バーは不定モード
      p.rowEl.classList.add("indeterminate");
      p.rowEl.querySelector("i").style.width = "";
      p.rowEl.querySelector(".name").textContent = `${label} 取り込み中… ${fmtLoaded(written)} 取得済み`;
    }
  } else if (type === "done") {
    const name = p.name || (p.file ? p.file.name.replace(/\.[^.]+$/, "") : "video");
    const size = p.file ? p.file.size : (written || 0);
    // 実際の種別を保存する。ファイル: file.type→拡張子、URL: Content-Type→拡張子→指定モードの順で推定
    let mtype, kind;
    if (p.file) {
      mtype = p.mtype || importMime(p.file) || "video/mp4";
      kind = /^audio\//.test(mtype) ? "audio" : "video";
    } else {
      mtype = mediaMime(mime) || mimeFromExt(p.ext) || (p.audioOnly ? "audio/mpeg" : "video/mp4");
      // 音声のみ指定やのに video/mp4 等で返ってきた場合は、中身は音声なので audio/ 側にそろえる
      if (p.audioOnly) mtype = mtype.replace(/^video\//, "audio/");
      kind = /^audio\//.test(mtype) ? "audio" : "video";
    }
    await dbPut({
      id, name, size, type: mtype, kind,
      addedAt: Date.now(), position: 0, duration: 0,
    });
    p.rowEl.remove();
    pendingImports.delete(id);
    releaseWakeLockIfIdle();
    await renderList();
    refreshStorageMeter();
  } else if (type === "error") {
    p.rowEl.classList.add("error");
    let quotaInfo = "";
    try {
      const { usage, quota } = await navigator.storage.estimate();
      quotaInfo = `\nこのアプリの枠: 使用${fmtSize(usage || 0)} ÷ 上限${fmtSize(quota || 0)}`;
    } catch (_) { /* 診断表示のみ */ }
    let hint = "";
    if (/AccessHandle is closed|InvalidState/i.test(message)) {
      hint = "\n※画面ロックやアプリ切替で中断された可能性が高いで。画面を点けたまま置いといてや";
    }
    const detail = `保存失敗: ${message}\n${fmtSize(written || 0)}まで書けた${quotaInfo}${hint}`;
    p.rowEl.querySelector(".name").textContent = `✕ ${label} — ${detail.replace(/\n/g, "／")}`;
    pendingImports.delete(id);
    releaseWakeLockIfIdle();
    alert(`「${label}」\n${detail}`);
  }
};

$("file-input").addEventListener("change", (e) => {
  const picked = [...e.target.files];
  e.target.value = "";
  // ピッカーはどのファイルでも選べるので、動画・音声やなさそうなものはここで弾く
  const files = [], rejected = [];
  for (const file of picked) {
    const mtype = importMime(file);
    if (mtype) files.push({ file, mtype }); else rejected.push(file.name);
  }
  if (rejected.length) {
    alert(`${rejected.map((n) => `「${n}」`).join("")}は動画でも音声でもなさそうやから、取り込まへんかったで。\nmp4・mov・m4a・mp3 みたいなファイルを選んでな。`);
  }
  if (!files.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  acquireWakeLock();
  for (const { file, mtype } of files) {
    const id = crypto.randomUUID();
    const rowEl = document.createElement("div");
    rowEl.className = "progress-row";
    rowEl.innerHTML = `<div class="name">${esc(file.name)}（${fmtSize(file.size)}）取り込み開始… 0%</div><div class="bar"><i></i></div>`;
    importProgressEl.appendChild(rowEl);
    pendingImports.set(id, { file, rowEl, mtype });
    worker.postMessage({ id, file });
  }
});

/* ---------- URLで取り込み（cobalt API経由・実験） ---------- */
// corsProxy は自前の Cloudflare Worker（proxy/ 参照）の URL を利用者が詳細設定で入れる。既定は未設定
const DEFAULTS = {
  cobaltApi: "https://api.cobalt.liubquanti.click/",
  corsProxy: "",
};
// 以前の既定値（もう消滅したサービス）。localStorage に残っとったら未設定扱いにする
const DEAD_PROXY = /^https?:\/\/proxy\.cors\.sh\b/i;
function getCfg() {
  let corsProxy = (localStorage.getItem("moove.corsProxy") ?? DEFAULTS.corsProxy).trim();
  if (DEAD_PROXY.test(corsProxy)) {
    corsProxy = "";
    localStorage.removeItem("moove.corsProxy");
  }
  // 前置き形式（corsProxy + 転送先URL）で使うので、末尾の / が抜けとったら補う
  if (corsProxy && !/[/?=]$/.test(corsProxy)) corsProxy += "/";
  return {
    cobaltApi: localStorage.getItem("moove.cobaltApi") || DEFAULTS.cobaltApi,
    corsProxy,
  };
}
const NO_PROXY_MSG = "中継役（CORSプロキシ）が未設定やで。「詳細設定」の「CORSプロキシ」欄に、自分の Cloudflare Worker の URL（例: https://appmoove-proxy.○○.workers.dev/）を入れて保存してな";
function saveCfg(cobaltApi, corsProxy) {
  localStorage.setItem("moove.cobaltApi", cobaltApi.trim() || DEFAULTS.cobaltApi);
  localStorage.setItem("moove.corsProxy", corsProxy.trim());
}

// cobaltにURLを渡してメディアURL(tunnel等)を得る
// quality === "audio" のときは音声のみ（iOSで確実に鳴るよう mp3 を明示。cobaltの既定も mp3）
async function resolveViaCobalt(pageUrl, quality) {
  const cfg = getCfg();
  const api = cfg.cobaltApi.endsWith("/") ? cfg.cobaltApi : cfg.cobaltApi + "/";
  const endpoint = cfg.corsProxy ? cfg.corsProxy + api : api;
  const audioOnly = quality === "audio";
  // alwaysProxy: ダウンロード先を常に cobalt 自身（tunnel）にする。
  // 元サイトの CDN へ redirect されると、中継役の許可リスト外になって弾かれるため
  const body = audioOnly
    ? { url: pageUrl, downloadMode: "audio", audioFormat: "mp3", alwaysProxy: true }
    : { url: pageUrl, videoQuality: quality, downloadMode: "auto", alwaysProxy: true };
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`cobaltに接続できん: ${err.message}（CORSプロキシが落ちてる/弾かれてる可能性。詳細設定の URL と、中継役の ALLOWED_ORIGINS にこのサイトが入っとるかを見直してや）`);
  }
  let text = "";
  try { text = await res.text(); } catch (_) { /* 本文なし扱い */ }
  let data = null;
  try { data = JSON.parse(text); } catch (_) { /* JSON やない（プロキシのエラー文等） */ }
  if (res.status === 429) {
    throw new Error("cobaltの回数制限に引っかかったわ（HTTP 429）。数分待ってからもう一回やってみてな");
  }
  if (!data || typeof data !== "object") {
    const snippet = text.trim().replace(/\s+/g, " ").slice(0, 200);
    if (!res.ok && snippet) throw new Error(`cobalt/中継役がエラーを返したで（HTTP ${res.status}）: ${snippet}`);
    throw new Error(`cobaltの応答が壊れとる（HTTP ${res.status}）。プロキシがブロックページを返しとるかも`);
  }

  switch (data.status) {
    case "tunnel":
    case "redirect":
    case "stream":
      return { url: data.url, name: cleanName(data.filename, audioOnly), ext: extOf(data.filename) };
    case "picker": {
      // 音声のみ指定でスライドショー等が返ってきたら、付属の音声(data.audio)を取る
      if (audioOnly && data.audio) {
        const fn = data.audioFilename || data.filename;
        return { url: data.audio, name: cleanName(fn, true), ext: extOf(fn) };
      }
      const item = (data.picker || []).find((x) => x.type === "video") || (data.picker || [])[0];
      if (!item) throw new Error("pickerが空やった");
      const fn = data.filename || item.filename;
      return { url: item.url, name: cleanName(fn, audioOnly), ext: extOf(fn) };
    }
    case "local-processing":
      throw new Error("この動画はクライアント側での合成が必要な形式（未対応）。画質を下げるか別の動画で試してや");
    case "error":
      throw new Error(`cobaltエラー: ${(data.error && data.error.code) || "不明"}`);
    default:
      throw new Error(`未知の応答: ${JSON.stringify(data).slice(0, 120)}`);
  }
}
function cleanName(fn, audioOnly) {
  if (!fn) return (audioOnly ? "audio " : "video ") + new Date().toISOString().slice(0, 16).replace("T", " ");
  return fn.replace(/\.[^.]+$/, "").slice(0, 120);
}
function extOf(fn) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(fn || "");
  return m ? m[1].toLowerCase() : "";
}

async function importFromUrl(pageUrl, quality) {
  if (!getCfg().corsProxy) {
    alert(NO_PROXY_MSG);
    const cfgBox = document.querySelector("details.cfg");
    if (cfgBox) cfgBox.open = true;
    $("cfg-proxy").focus();
    return;
  }
  const id = crypto.randomUUID();
  const rowEl = document.createElement("div");
  rowEl.className = "progress-row";
  rowEl.innerHTML = `<div class="name">URL解析中…（cobaltに問い合わせ）</div><div class="bar"><i></i></div>`;
  importProgressEl.appendChild(rowEl);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  acquireWakeLock();
  try {
    const { url, name, ext } = await resolveViaCobalt(pageUrl, quality);
    // メディア本体（cobalt の tunnel）も中継役を通す（cobalt は CORS で読ませてくれんため）
    const cfg = getCfg();
    const mediaUrl = cfg.corsProxy ? cfg.corsProxy + url : url;
    rowEl.querySelector(".name").textContent = `${name} 取り込み開始…`;
    pendingImports.set(id, { name, rowEl, ext, audioOnly: quality === "audio" });
    // tunnel URL は発行から1分ちょっとで失効するので、store-worker 側は URL 取り込みを待たせず即開始する
    worker.postMessage({ id, url: mediaUrl });
  } catch (err) {
    rowEl.classList.add("error");
    rowEl.querySelector(".name").textContent = "✕ " + err.message;
    releaseWakeLockIfIdle();
    alert(err.message);
  }
}

$("url-go").addEventListener("click", () => {
  const input = $("url-input");
  const url = input.value.trim();
  if (!/^https?:\/\//i.test(url)) { alert("http(s) で始まるURLを貼ってや"); return; }
  const quality = $("url-quality").value;
  input.value = "";
  importFromUrl(url, quality);
});

// ワンアクション取り込み：クリップボードを読んで妥当なURLなら即取り込む。
// iOS Safariは readText() がユーザージェスチャ起点やないと弾かれるので、
// クリックハンドラ内で（先に何もawaitせず）直接 readText() を呼ぶこと。
$("paste-go").addEventListener("click", () => {
  const fallback = (msg) => { alert(msg); $("url-input").focus(); };
  if (!navigator.clipboard || !navigator.clipboard.readText) {
    fallback("クリップボード読み取りに非対応の環境やわ。下の欄にURL貼って「取り込み」押してや");
    return;
  }
  const quality = $("url-quality").value;
  navigator.clipboard.readText().then((text) => {
    const url = (text || "").trim();
    if (!/^https?:\/\//i.test(url)) {
      fallback("クリップボードにURLが入ってへんみたいや。下の欄に貼って「取り込み」押してや");
      return;
    }
    importFromUrl(url, quality);
  }).catch(() => {
    fallback("クリップボード読めへんかった（権限拒否かも）。下の欄にURL貼って「取り込み」押してや");
  });
});

// 詳細設定の初期値流し込み＆保存
(function initCfg() {
  const cfg = getCfg();
  $("cfg-api").value = cfg.cobaltApi;
  $("cfg-proxy").value = cfg.corsProxy;
  $("cfg-save").addEventListener("click", () => {
    saveCfg($("cfg-api").value, $("cfg-proxy").value);
    const c = getCfg();
    $("cfg-api").value = c.cobaltApi;
    $("cfg-proxy").value = c.corsProxy;
    alert("設定を保存したで");
  });
})();

/* ---------- 再生 ---------- */
async function play(id) {
  await savePosition();
  const meta = videos.find((v) => v.id === id);
  if (!meta) return;
  let file;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(id);
    file = await fh.getFile();
  } catch (_) {
    alert("ファイルの実体が見つからん。OSに消された可能性があるで。取り込み直してや。");
    await dbDelete(id);
    await renderList();
    return;
  }
  // 音声は<audio>、動画は<video>で鳴らす。種別が変わるときは前の要素を止めて空にしとく
  const el = isAudio(meta) ? audio : video;
  if (el !== media) {
    media.pause();
    media.removeAttribute("src");
    media.load();
    media = el;
  }
  $("player-box").classList.toggle("audio-mode", media === audio);
  if (currentURL) URL.revokeObjectURL(currentURL);
  // OPFSのFileは type が空なので、音声は保存済みMIMEを付けて渡す（iOSの判定漏れ対策）
  const src = media === audio && meta.type && !file.type ? new Blob([file], { type: meta.type }) : file;
  currentURL = URL.createObjectURL(src);
  currentId = id;
  lastSavedPos = 0;
  $("player-box").classList.add("show");
  $("now-playing").innerHTML = `${isAudio(meta) ? "🎵" : "▶"} <b>${esc(meta.name)}</b>`;
  el.src = currentURL;
  applyRate();
  el.addEventListener("loadedmetadata", function onMeta() {
    el.removeEventListener("loadedmetadata", onMeta);
    if (!meta.duration && isFinite(el.duration)) {
      meta.duration = el.duration;
      dbPut(meta);
    }
    if (meta.position > 3 && meta.position < (el.duration || Infinity) - 5) {
      el.currentTime = meta.position;
    }
    applyRate();
  });
  el.play().catch(() => { /* 自動再生ブロック時はユーザーが▶を押す */ });
  setMediaSession(meta);
  renderList();
}

/* ---------- 再生速度・スリープタイマー・連続再生 ---------- */
const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const rateSel = $("rate-select");
function getRate() {
  const r = parseFloat(localStorage.getItem("moove.rate"));
  return RATES.includes(r) ? r : 1;
}
// src差し替え時に playbackRate は defaultPlaybackRate に戻されるので、両方そろえる
function applyRate() {
  const r = getRate();
  for (const el of [video, audio]) {
    el.defaultPlaybackRate = r;
    el.playbackRate = r;
  }
}
rateSel.value = String(getRate());
rateSel.addEventListener("change", () => {
  localStorage.setItem("moove.rate", rateSel.value);
  applyRate();
});
applyRate();

// スリープタイマー: 終了時刻を持っておき、1秒ごと＋timeupdateで判定
// （裏に回るとsetIntervalが止まることがあるので、再生中に飛んでくるtimeupdateでも見る）
const sleepSel = $("sleep-select");
const sleepLeft = $("sleep-left");
let sleepAt = 0;
let sleepTimer = null;
function clearSleep() {
  sleepAt = 0;
  if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
  sleepSel.value = "0";
  sleepLeft.textContent = "";
}
function checkSleep() {
  if (!sleepAt) return;
  const left = sleepAt - Date.now();
  if (left <= 0) {
    media.pause();
    clearSleep();
    return;
  }
  sleepLeft.textContent = "残り " + fmtTime(left / 1000);
}
sleepSel.addEventListener("change", () => {
  const min = Number(sleepSel.value) || 0;
  if (!min) { clearSleep(); return; }
  sleepAt = Date.now() + min * 60 * 1000;
  if (!sleepTimer) sleepTimer = setInterval(checkSleep, 1000);
  checkSleep();
});

// 連続再生（終わったら次へ）のオン/オフ。既定はオン
const autoBtn = $("auto-next");
const getAutoNext = () => localStorage.getItem("moove.autoNext") !== "0";
function syncAutoBtn() {
  const on = getAutoNext();
  autoBtn.textContent = on ? "⏭ 連続再生 ON" : "⏭ 連続再生 OFF";
  autoBtn.setAttribute("aria-pressed", String(on));
  autoBtn.classList.toggle("on", on);
}
autoBtn.addEventListener("click", () => {
  localStorage.setItem("moove.autoNext", getAutoNext() ? "0" : "1");
  syncAutoBtn();
});
syncAutoBtn();

/* ---------- ミニ再生 (PiP) ＆ ロック画面コントロール (Media Session) ---------- */
const pipBtn = $("pip-btn");
// 対応チェックは「APIが生えとるか」だけで判定する
// （webkitSupportsPresentationModeは動画ロード前だとfalseを返すことがある）
const hasWebkitPip = typeof video.webkitSetPresentationMode === "function";
const hasStdPip = !!(document.pictureInPictureEnabled && video.requestPictureInPicture);
if (pipBtn && (hasWebkitPip || hasStdPip)) {
  pipBtn.classList.add("show");
  // ホーム画面PWAのiOSはPiP不可（supportsが常にfalse）— その場合はボタンを引っ込める
  video.addEventListener("loadedmetadata", () => {
    if (hasWebkitPip && typeof video.webkitSupportsPresentationMode === "function"
      && !video.webkitSupportsPresentationMode("picture-in-picture")) {
      pipBtn.classList.remove("show");
    }
  });
  function togglePip() {
    if (!currentId || !video.src) { alert("先に動画を再生してからやで"); return; }
    try {
      if (hasWebkitPip) {
        const before = video.webkitPresentationMode;
        video.webkitSetPresentationMode(before === "picture-in-picture" ? "inline" : "picture-in-picture");
        setTimeout(() => {
          if (video.webkitPresentationMode === before) {
            const diag = [
              `mode=${before}のまま`,
              `supports=${typeof video.webkitSupportsPresentationMode === "function" ? video.webkitSupportsPresentationMode("picture-in-picture") : "?"}`,
              `readyState=${video.readyState}`,
              `paused=${video.paused}`,
              `standalone=${!!window.navigator.standalone}`,
              (navigator.userAgent.match(/OS \d+_\d+/) || ["iOS?"])[0],
            ].join(" / ");
            alert(`切替が効かんかった\n${diag}`);
          }
        }, 600);
      } else if (document.pictureInPictureElement) {
        document.exitPictureInPicture();
      } else {
        video.requestPictureInPicture().catch((err) => {
          alert(`ミニ再生に切り替えられんかった: ${err.name} ${err.message}`);
        });
      }
    } catch (err) {
      alert(`ミニ再生に切り替えられんかった: ${(err && err.name) || ""} ${(err && err.message) || err}`);
    }
  }
  pipBtn.addEventListener("click", togglePip);
  const syncPipLabel = () => {
    const inPip = video.webkitPresentationMode === "picture-in-picture" || !!document.pictureInPictureElement;
    pipBtn.textContent = inPip ? "◲ 戻す" : "◱ ミニ再生";
  };
  video.addEventListener("webkitpresentationmodechanged", syncPipLabel);
  video.addEventListener("enterpictureinpicture", syncPipLabel);
  video.addEventListener("leavepictureinpicture", syncPipLabel);
}

/* <video>/<audio>両方にリスナーを張り、今アクティブな方(media)からのイベントだけ処理する
   （種別切替時に止めた側の pause 等で、別アイテムの位置を上書きせんように） */
function onMedia(type, fn) {
  for (const el of [video, audio]) {
    el.addEventListener(type, (e) => { if (e.target === media) fn(e); });
  }
}

/* 再生状態・位置をOSに報告し続ける（ロック画面からの復帰率を上げる） */
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(media.duration) || !media.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: media.duration,
      playbackRate: media.playbackRate,
      position: Math.min(media.currentTime, media.duration),
    });
  } catch (_) { /* 位置報告は補助機能 */ }
}
onMedia("play", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  updatePositionState();
});
onMedia("pause", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  updatePositionState();
});
onMedia("seeked", updatePositionState);
onMedia("ratechange", updatePositionState);

function setMediaSession(meta) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: meta.name, artist: "appMoove" });
  navigator.mediaSession.setActionHandler("play", () => media.play());
  navigator.mediaSession.setActionHandler("pause", () => media.pause());
  navigator.mediaSession.setActionHandler("seekbackward", (d) => { media.currentTime = Math.max(0, media.currentTime - (d.seekOffset || 10)); });
  navigator.mediaSession.setActionHandler("seekforward", (d) => { media.currentTime = Math.min(media.duration || Infinity, media.currentTime + (d.seekOffset || 30)); });
  try {
    // ロック画面のシークバー操作
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.seekTime == null) return;
      const t = Math.max(0, Math.min(d.seekTime, media.duration || Infinity));
      if (d.fastSeek && typeof media.fastSeek === "function") media.fastSeek(t);
      else media.currentTime = t;
      updatePositionState();
    });
  } catch (_) { /* seekto非対応の環境 */ }
  try {
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      const idx = videos.findIndex((v) => v.id === currentId);
      if (videos[idx + 1]) play(videos[idx + 1].id);
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      const idx = videos.findIndex((v) => v.id === currentId);
      if (videos[idx - 1]) play(videos[idx - 1].id);
    });
  } catch (_) { /* 一部ハンドラ非対応の環境 */ }
}

async function savePosition() {
  if (!currentId) return;
  const meta = videos.find((v) => v.id === currentId);
  if (!meta) return;
  meta.position = media.currentTime || 0;
  if (isFinite(media.duration) && media.duration) meta.duration = media.duration;
  await dbPut(meta);
}

onMedia("timeupdate", () => {
  checkSleep();
  if (!currentId) return;
  if (Math.abs(media.currentTime - lastSavedPos) > 5) {
    lastSavedPos = media.currentTime;
    savePosition();
  }
});
onMedia("pause", savePosition);
onMedia("ended", async () => {
  const meta = videos.find((v) => v.id === currentId);
  if (meta) { meta.position = 0; await dbPut(meta); }
  const idx = videos.findIndex((v) => v.id === currentId);
  const next = videos[idx + 1];
  if (next && getAutoNext()) play(next.id); else renderList();
});
window.addEventListener("pagehide", savePosition);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") savePosition();
});

/* ---------- 起動 ---------- */
(async function init() {
  $("ver").textContent = "v" + APP_VERSION;
  const supported = !!(navigator.storage && navigator.storage.getDirectory);
  if (!supported) $("unsupported-hint").classList.add("show");
  if (!window.navigator.standalone && /iPhone|iPad/.test(navigator.userAgent)) {
    $("standalone-hint").classList.add("show");
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
  await renderList();
  refreshStorageMeter();
})();

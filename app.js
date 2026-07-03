/* appMoove - オフライン動画プレイヤー (Phase 1) */
"use strict";

const APP_VERSION = "0.1.6";
const $ = (id) => document.getElementById(id);
const video = $("video");
const listEl = $("list");
const importProgressEl = $("import-progress");

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
function fmtTime(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
    listEl.innerHTML = `<div class="empty"><div class="big">🎬</div>まだ動画がないで。<br>「＋ 動画を取り込む」から mp4 等を入れてや。</div>`;
    return;
  }
  listEl.innerHTML = videos.map((v) => {
    const pct = v.duration ? Math.min(100, (v.position / v.duration) * 100) : 0;
    const dur = v.duration ? fmtTime(v.duration) : "";
    const pos = v.position > 3 ? `・続き ${fmtTime(v.position)}` : "";
    return `<div class="item ${v.id === currentId ? "playing" : ""}" data-id="${v.id}">
      <div class="info">
        <div class="title">${esc(v.name)}</div>
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
    video.pause();
    video.removeAttribute("src");
    video.load();
    currentId = null;
    $("player-box").classList.remove("show");
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
  const { id, type, written, total, message } = e.data;
  const p = pendingImports.get(id);
  if (!p) return;
  if (type === "progress") {
    const pct = Math.round((written / total) * 100);
    p.rowEl.querySelector("i").style.width = pct + "%";
    p.rowEl.querySelector(".name").textContent =
      `${p.file.name}（${fmtSize(p.file.size)}）取り込み中… ${pct}%`;
  } else if (type === "done") {
    await dbPut({
      id, name: p.file.name.replace(/\.[^.]+$/, ""), size: p.file.size,
      type: p.file.type, addedAt: Date.now(), position: 0, duration: 0,
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
    p.rowEl.querySelector(".name").textContent = `✕ ${p.file.name} — ${detail.replace(/\n/g, "／")}`;
    pendingImports.delete(id);
    releaseWakeLockIfIdle();
    alert(`「${p.file.name}」\n${detail}`);
  }
};

$("file-input").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  acquireWakeLock();
  for (const file of files) {
    const id = crypto.randomUUID();
    const rowEl = document.createElement("div");
    rowEl.className = "progress-row";
    rowEl.innerHTML = `<div class="name">${esc(file.name)}（${fmtSize(file.size)}）取り込み開始… 0%</div><div class="bar"><i></i></div>`;
    importProgressEl.appendChild(rowEl);
    pendingImports.set(id, { file, rowEl });
    worker.postMessage({ id, file });
  }
});

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
    alert("動画の実体が見つからん。OSに消された可能性があるで。取り込み直してや。");
    await dbDelete(id);
    await renderList();
    return;
  }
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = URL.createObjectURL(file);
  currentId = id;
  lastSavedPos = 0;
  $("player-box").classList.add("show");
  $("now-playing").innerHTML = `▶ <b>${esc(meta.name)}</b>`;
  video.src = currentURL;
  video.addEventListener("loadedmetadata", function onMeta() {
    video.removeEventListener("loadedmetadata", onMeta);
    if (!meta.duration && isFinite(video.duration)) {
      meta.duration = video.duration;
      dbPut(meta);
    }
    if (meta.position > 3 && meta.position < (video.duration || Infinity) - 5) {
      video.currentTime = meta.position;
    }
  });
  video.play().catch(() => { /* 自動再生ブロック時はユーザーが▶を押す */ });
  setMediaSession(meta);
  renderList();
}

/* ---------- ミニ再生 (PiP) ＆ ロック画面コントロール (Media Session) ---------- */
const pipBtn = $("pip-btn");
const pipSupported = typeof video.webkitSupportsPresentationMode === "function"
  && video.webkitSupportsPresentationMode("picture-in-picture");
if (pipSupported) {
  pipBtn.classList.add("show");
  pipBtn.addEventListener("click", () => {
    const inPip = video.webkitPresentationMode === "picture-in-picture";
    video.webkitSetPresentationMode(inPip ? "inline" : "picture-in-picture");
  });
  video.addEventListener("webkitpresentationmodechanged", () => {
    pipBtn.textContent = video.webkitPresentationMode === "picture-in-picture" ? "◲ 戻す" : "◱ ミニ再生";
  });
}

function setMediaSession(meta) {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title: meta.name, artist: "appMoove" });
  navigator.mediaSession.setActionHandler("play", () => video.play());
  navigator.mediaSession.setActionHandler("pause", () => video.pause());
  navigator.mediaSession.setActionHandler("seekbackward", (d) => { video.currentTime = Math.max(0, video.currentTime - (d.seekOffset || 10)); });
  navigator.mediaSession.setActionHandler("seekforward", (d) => { video.currentTime = Math.min(video.duration || Infinity, video.currentTime + (d.seekOffset || 30)); });
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
  meta.position = video.currentTime || 0;
  if (isFinite(video.duration) && video.duration) meta.duration = video.duration;
  await dbPut(meta);
}

video.addEventListener("timeupdate", () => {
  if (!currentId) return;
  if (Math.abs(video.currentTime - lastSavedPos) > 5) {
    lastSavedPos = video.currentTime;
    savePosition();
  }
});
video.addEventListener("pause", savePosition);
video.addEventListener("ended", async () => {
  const meta = videos.find((v) => v.id === currentId);
  if (meta) { meta.position = 0; await dbPut(meta); }
  const idx = videos.findIndex((v) => v.id === currentId);
  const next = videos[idx + 1];
  if (next) play(next.id); else renderList();
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

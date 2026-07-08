/* appMoove - オフライン動画プレイヤー (Phase 1) */
"use strict";

const APP_VERSION = "0.2.0";
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
  const label = p.name || (p.file ? p.file.name : "video");
  if (type === "progress") {
    if (total > 0) {
      const pct = Math.round((written / total) * 100);
      p.rowEl.querySelector("i").style.width = pct + "%";
      p.rowEl.querySelector(".name").textContent = `${label}（${fmtSize(total)}）取り込み中… ${pct}%`;
    } else {
      // total不明（ネット取得でContent-Lengthが無い）= 書けたバイト数だけ出す
      p.rowEl.querySelector("i").style.width = "100%";
      p.rowEl.querySelector("i").style.opacity = "0.4";
      p.rowEl.querySelector(".name").textContent = `${label} 取り込み中… ${fmtSize(written)}`;
    }
  } else if (type === "done") {
    const name = p.name || (p.file ? p.file.name.replace(/\.[^.]+$/, "") : "video");
    const size = p.file ? p.file.size : (written || 0);
    await dbPut({
      id, name, size, type: (p.file && p.file.type) || "video/mp4",
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

/* ---------- URLで取り込み（cobalt API経由・実験） ---------- */
const DEFAULTS = {
  cobaltApi: "https://api.cobalt.liubquanti.click/",
  corsProxy: "https://proxy.cors.sh/",
};
function getCfg() {
  return {
    cobaltApi: localStorage.getItem("moove.cobaltApi") || DEFAULTS.cobaltApi,
    corsProxy: localStorage.getItem("moove.corsProxy") ?? DEFAULTS.corsProxy,
  };
}
function saveCfg(cobaltApi, corsProxy) {
  localStorage.setItem("moove.cobaltApi", cobaltApi.trim() || DEFAULTS.cobaltApi);
  localStorage.setItem("moove.corsProxy", corsProxy.trim());
}

// cobaltにURLを渡してメディアURL(tunnel等)を得る
async function resolveViaCobalt(pageUrl, quality) {
  const cfg = getCfg();
  const api = cfg.cobaltApi.endsWith("/") ? cfg.cobaltApi : cfg.cobaltApi + "/";
  const endpoint = cfg.corsProxy ? cfg.corsProxy + api : api;
  let res;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ url: pageUrl, videoQuality: quality, downloadMode: "auto" }),
    });
  } catch (err) {
    throw new Error(`cobaltに接続できん: ${err.message}（CORSプロキシが落ちてる/弾かれてる可能性。詳細設定を見直してや）`);
  }
  let data;
  try { data = await res.json(); }
  catch (_) { throw new Error(`cobaltの応答が壊れとる（HTTP ${res.status}）。プロキシがブロックページを返しとるかも`); }

  switch (data.status) {
    case "tunnel":
    case "redirect":
    case "stream":
      return { url: data.url, name: cleanName(data.filename) };
    case "picker": {
      const item = (data.picker || []).find((x) => x.type === "video") || (data.picker || [])[0];
      if (!item) throw new Error("pickerが空やった");
      return { url: item.url, name: cleanName(data.filename || item.filename) };
    }
    case "local-processing":
      throw new Error("この動画はクライアント側での合成が必要な形式（未対応）。画質を下げるか別の動画で試してや");
    case "error":
      throw new Error(`cobaltエラー: ${(data.error && data.error.code) || "不明"}`);
    default:
      throw new Error(`未知の応答: ${JSON.stringify(data).slice(0, 120)}`);
  }
}
function cleanName(fn) {
  if (!fn) return "video " + new Date().toISOString().slice(0, 16).replace("T", " ");
  return fn.replace(/\.[^.]+$/, "").slice(0, 120);
}

async function importFromUrl(pageUrl, quality) {
  const id = crypto.randomUUID();
  const rowEl = document.createElement("div");
  rowEl.className = "progress-row";
  rowEl.innerHTML = `<div class="name">URL解析中…（cobaltに問い合わせ）</div><div class="bar"><i></i></div>`;
  importProgressEl.appendChild(rowEl);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  acquireWakeLock();
  try {
    const { url, name } = await resolveViaCobalt(pageUrl, quality);
    rowEl.querySelector(".name").textContent = `${name} 取り込み開始…`;
    pendingImports.set(id, { name, rowEl });
    worker.postMessage({ id, url });
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

/* 再生状態・位置をOSに報告し続ける（ロック画面からの復帰率を上げる） */
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(video.duration) || !video.duration) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: video.duration,
      playbackRate: video.playbackRate,
      position: Math.min(video.currentTime, video.duration),
    });
  } catch (_) { /* 位置報告は補助機能 */ }
}
video.addEventListener("play", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
  updatePositionState();
});
video.addEventListener("pause", () => {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  updatePositionState();
});
video.addEventListener("seeked", updatePositionState);
video.addEventListener("ratechange", updatePositionState);

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

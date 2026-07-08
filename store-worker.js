/* appMoove - OPFSへ動画をチャンク書き込みするWorker（メモリに全載せしない）
   iOSは画面ロック/バックグラウンドでAccessHandleを閉じることがあるため、
   位置指定のslice読み＋ハンドル再取得リトライで続きから書き込み再開する */
"use strict";

const CHUNK = 8 * 1024 * 1024;
const MAX_RETRY = 120; // 約2分ぶん粘る（復帰待ち）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queue = Promise.resolve();
self.onmessage = (e) => {
  const job = e.data;
  const task = job && job.url ? () => storeFromUrl(job) : () => store(job);
  queue = queue.then(task).catch(() => {});
};

/* ネットワーク(cobalt tunnel等)から取得してOPFSへ流し込む。
   ネットワークストリームは途中再開が難しいので、失敗したら破棄して報告する */
async function storeFromUrl({ id, url }) {
  let at = 0;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : "?"}`);
    if (!res.body) throw new Error("レスポンスにストリームが無い");
    const total = Number(res.headers.get("content-length")) || 0;
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(id, { create: true });
    const handle = await fh.createSyncAccessHandle();
    postMessage({ id, type: "progress", written: 0, total });
    const reader = res.body.getReader();
    let lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.byteLength;
      if (at - lastPost >= 4 * 1024 * 1024) {
        lastPost = at;
        postMessage({ id, type: "progress", written: at, total });
      }
    }
    handle.flush();
    handle.close();
    if (at === 0) throw new Error("0バイト（取得失敗）");
    postMessage({ id, type: "done", written: at });
  } catch (err) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(id);
    } catch (_) { /* 書きかけが無ければそれでよい */ }
    const name = (err && err.name) || "";
    const msg = (err && err.message) || String(err);
    // ブラウザはCORS遮断を "Failed to fetch" として理由を隠す
    const cors = /Failed to fetch|Load failed|NetworkError/i.test(msg)
      ? "（CORS遮断かネット断の可能性。取得URLが appMoove からの読み取りを許可してへん）" : "";
    postMessage({ id, type: "error", message: `${name} ${msg}${cors}`, written: at });
  }
}

async function store({ id, file }) {
  let at = 0;
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(id, { create: true });
    let handle = await fh.createSyncAccessHandle();
    postMessage({ id, type: "progress", written: 0, total: file.size });
    let lastPost = 0;
    while (at < file.size) {
      const end = Math.min(at + CHUNK, file.size);
      let wrote = false;
      for (let attempt = 0; !wrote; attempt++) {
        try {
          const buf = await file.slice(at, end).arrayBuffer();
          handle.write(buf, { at });
          wrote = true;
        } catch (err) {
          if (attempt >= MAX_RETRY) throw err;
          await sleep(1000);
          try { handle.close(); } catch (_) { /* 既に閉じられている */ }
          try { handle = await fh.createSyncAccessHandle(); } catch (_) { /* 復帰前なら次の周回で再試行 */ }
        }
      }
      at = end;
      if (at - lastPost >= 2 * CHUNK) {
        lastPost = at;
        postMessage({ id, type: "progress", written: at, total: file.size });
      }
    }
    handle.flush();
    handle.close();
    postMessage({ id, type: "done", written: at });
  } catch (err) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(id);
    } catch (_) { /* 書きかけが無ければそれでよい */ }
    postMessage({ id, type: "error", message: `${(err && err.name) || ""} ${(err && err.message) || err}`, written: at });
  }
}

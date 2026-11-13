/* appMoove - OPFSへ動画・音声をチャンク書き込みするWorker（メモリに全載せしない）
   iOSは画面ロック/バックグラウンドでAccessHandleを閉じることがあるため、
   位置指定のslice読み＋ハンドル再取得リトライで続きから書き込み再開する */
"use strict";

const CHUNK = 8 * 1024 * 1024;
const MAX_RETRY = 120; // 約2分ぶん粘る（復帰待ち）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let queue = Promise.resolve();
self.onmessage = (e) => {
  const job = e.data;
  // URL取り込み（cobalt tunnel）は発行から約70〜90秒で失効するので、キューで待たせず即開始する。
  // 書き込み先は取り込みごとに別ファイル(id)なので、ファイル取り込みと並行しても衝突せん
  if (job && job.url) { storeFromUrl(job); return; }
  queue = queue.then(() => store(job)).catch(() => {});
};

/* ネットワーク(cobalt tunnel等)から取得してOPFSへ流し込む。
   ネットワークストリームは途中再開が難しいので、失敗したら破棄して報告する */
async function storeFromUrl({ id, url }) {
  let at = 0;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res) throw new Error("HTTP ?");
    if (!res.ok) {
      // 中継役の「forbidden origin」「target host not allowed: ○○」等を利用者に見せる
      let text = "";
      try { text = (await res.text()).trim().replace(/\s+/g, " ").slice(0, 200); } catch (_) { /* 本文なし */ }
      const hint = res.status === 404 || res.status === 410
        ? "（cobaltのダウンロードURLの期限切れかも。もう一回取り込んでみてな）"
        : res.status === 429 ? "（回数制限。数分待ってからやり直してな）" : "";
      throw new Error(`HTTP ${res.status}${text ? ": " + text : ""}${hint}`);
    }
    if (!res.body) throw new Error("レスポンスにストリームが無い");
    // CORSプロキシ経由やと Content-Length が expose されず取れんことがある（その時は0扱い）。
    // cobalt の tunnel は Content-Length の代わりに推定値 Estimated-Content-Length を付けることがある
    const total = Number(res.headers.get("content-length"))
      || Number(res.headers.get("estimated-content-length")) || 0;
    // Content-Type はCORSセーフリスト対象なので、プロキシ経由でも読める（実際の種別として保存に使う）
    const mime = res.headers.get("content-type") || "";
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
      // 進捗通知は毎チャンクやと過剰なので、前回から256KB以上増えた時だけ間引いて送る
      if (at - lastPost >= 256 * 1024) {
        lastPost = at;
        postMessage({ id, type: "progress", written: at, total });
      }
    }
    handle.flush();
    handle.close();
    if (at === 0) throw new Error("0バイト（取得失敗）");
    postMessage({ id, type: "done", written: at, mime });
  } catch (err) {
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(id);
    } catch (_) { /* 書きかけが無ければそれでよい */ }
    const name = (err && err.name) || "";
    const msg = (err && err.message) || String(err);
    // ブラウザはCORS遮断を "Failed to fetch" として理由を隠す
    const cors = /Failed to fetch|Load failed|NetworkError/i.test(msg)
      ? "（CORS遮断かネット断の可能性。詳細設定の中継役（CORSプロキシ）の URL と稼働を確認してな）" : "";
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

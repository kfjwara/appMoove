/* appMoove - OPFSへ動画をチャンク書き込みするWorker（メモリに全載せしない） */
"use strict";

let queue = Promise.resolve();
self.onmessage = (e) => {
  const job = e.data;
  queue = queue.then(() => store(job)).catch(() => {});
};

async function store({ id, file }) {
  try {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(id, { create: true });
    const handle = await fh.createSyncAccessHandle();
    postMessage({ id, type: "progress", written: 0, total: file.size });
    const reader = file.stream().getReader();
    let at = 0;
    let lastPost = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.byteLength;
      if (at - lastPost > 4 * 1024 * 1024) {
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
    postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
}

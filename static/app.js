/* ============================================================
   局域网快传 · 前端主逻辑
   所有跨视图数据关联走 bus.js 事件（对应 bus.ts emit/on 语义），
   服务端通过 SSE /api/events 实时推送，页面永不手动刷新。
   ============================================================ */

(function () {
  "use strict";

  const state = {
    config: null,
    peers: [],
    view: "shares",
    share: null,
    path: "/",
    authed: new Set(),
    pendingShare: null,
    pickPath: "",
    dlShowAll: false,
    dlCopy: {},   // task -> { name, dir }
  };

  /* ---------------- 工具 ---------------- */

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // 统一的百分比计算：除零/非数字一律返回 0（杜绝 NaN%）
  function safePct(received, total) {
    if (!total || !Number.isFinite(received) || !Number.isFinite(total)) return 0;
    return Math.min(100, Math.round(received / total * 100));
  }

  function fmtSize(n) {
    if (n == null || isNaN(n)) return "";
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + " " + units[i];
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ---------------- 图标（内联 SVG，无 emoji） ---------------- */

  const I = {
    folder: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>',
    file: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    image: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
    video: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 10 6-3v10l-6-3z"/></svg>',
    audio: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
    archive: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M4 21h16"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M4 21h16"/></svg>',
    zip: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 13v6"/><path d="M9 13h2l-2 3h2"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    device: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    qr: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM20 14h1M14 20h1M18 18h3v3h-3z"/></svg>',
    drive: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="0.5" fill="currentColor"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    empty: '<svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 11v5"/><path d="M9.5 13.5 12 11l2.5 2.5"/></svg>',
    settings: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  };

  const FILE_ICON = {
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", heic: "image",
    mp4: "video", webm: "video", mov: "video", mkv: "video", avi: "video",
    mp3: "audio", wav: "audio", flac: "audio", aac: "audio", m4a: "audio", ogg: "audio",
    zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", xz: "archive",
  };

  const INLINE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic", "mp4", "webm", "mov", "mkv", "avi", "mp3", "wav", "flac", "aac", "m4a", "ogg", "pdf", "txt", "md", "log"]);

  function fileIcon(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return I[FILE_ICON[ext] || "file"];
  }

  /* ---------------- API ---------------- */

  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error((data && data.error) || "请求失败 (" + res.status + ")");
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------------- Toast ---------------- */

  function toast(msg, type) {
    const box = $("#toasts");
    const el = document.createElement("div");
    el.className = "toast" + (type === "error" ? " toast-error" : type === "ok" ? " toast-ok" : "");
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2600);
    setTimeout(() => el.remove(), 3000);
  }

  /* ---------------- 剪贴板（多级兜底） ---------------- */

  function copyTextToClipboard(text) {
    return new Promise((resolve, reject) => {
      // 1) 桌面版：由 Qt 层写系统剪贴板（navigator.clipboard 在 QtWebEngine 无权限）
      if (window.native && typeof window.native.copyText === "function") {
        try {
          window.native.copyText(text);
          resolve();
          return;
        } catch (e) { /* 继续兜底 */ }
      }
      // 2) 标准 Clipboard API（仅安全上下文可用）
      const fallback = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        ta.style.top = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
        ta.remove();
        ok ? resolve() : reject(new Error("clipboard denied"));
      };
      if (navigator.clipboard && window.isSecureContext && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(resolve).catch(fallback);
      } else {
        fallback();
      }
    });
  }

  /* ---------------- 数据加载（SSE 实时推送驱动） ---------------- */

  async function refreshConfig() {
    try {
      const cfg = await api("/api/config");
      state.config = cfg;
      Bus.emit("config:loaded", cfg);
    } catch (e) {
      toast("加载配置失败：" + e.message, "error");
    }
  }

  async function refreshPeers() {
    try {
      const data = await api("/api/peers");
      state.peers = data.peers || [];
      Bus.emit("peers:loaded", state.peers);
    } catch (e) { /* 静默，SSE 会重试 */ }
  }

  function connectSSE() {
    const es = new EventSource("/api/events");
    es.addEventListener("config", () => refreshConfig());
    es.addEventListener("peers", () => refreshPeers());
    es.addEventListener("downloads", () => { if (state.view === "admin") renderDlList(); });
    es.addEventListener("dlcopy", (e) => {
      try { handleDlCopy(JSON.parse(e.data || "{}")); } catch (err) { /* ignore */ }
    });
    es.addEventListener("stats", (e) => {
      try { updateSpeed(JSON.parse(e.data)); } catch (err) { /* 忽略 */ }
    });
    es.onerror = () => { /* EventSource 自动重连 */ };
  }

  let speedIdleTimer = null;

  function updateSpeed(d) {
    if (!d) return;
    const down = $("#speedDown");
    const up = $("#speedUp");
    if (down) down.textContent = "↓ " + fmtSize(d.down.speed) + "/s";
    if (up) up.textContent = "↑ " + fmtSize(d.up.speed) + "/s";
    clearTimeout(speedIdleTimer);
    speedIdleTimer = setTimeout(() => {
      if (down) down.textContent = "↓ --";
      if (up) up.textContent = "↑ --";
    }, 3000);
  }

  /* ---------------- 视图渲染 ---------------- */

  // 桌面版：从窗口任意位置拖入文件夹 -> 展开「添加共享」并填入真实路径。
  // 保存前不会进入「已配置的共享」，避免误拖即共享。
  window.copyTextToClipboard = copyTextToClipboard;  // 挂到全局便于自检断言
  window.__lanshareDropPath = function (p) {
    if (!p) return;
    state.view = "admin";
    render();
    setTimeout(() => {
      const card = $("#addShareCard");
      if (!card) { renderAdmin(); return; }
      const body = card.querySelector(".ac-body");
      if (body && body.hidden) body.hidden = false;
      const arrow = card.querySelector(".ac-arrow");
      if (arrow) arrow.style.transform = "rotate(90deg)";
      const f = $("#fPath");
      if (f) f.value = p;
      const fn = $("#fName");
      if (fn && !fn.value) {
        fn.value = p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "共享文件夹";
      }
      toast("已填入文件夹路径，确认设置后点「保存共享」", "ok");
    }, 80);
  };

  function render() {
    if (!state.config) return;
    if (state.view === "peers") return renderPeers();
    if (state.view === "admin") return renderAdmin();
    if (state.view === "dlcenter") return renderDlCenter();
    if (state.share) return renderBrowse();
    renderShares();
  }

  /* ---------------- 下载中心（仅桌面版，本机下载历史） ---------------- */

  // 下载中（实时增量，由桌面端推送）与已完成（持久化历史）
  state.dlRunning = state.dlRunning || {};   // id -> {name, dir, size, received, total, ts}
  state.dlHistory = state.dlHistory || [];   // 已完成列表
  state.dlTab = state.dlTab || "running";    // 下载中心页签：running | done

  // 桌面端 Qt 推送入口：进度高频更新只改对应条目，不做整表重渲染（防 UI 跳动）
  window.__lanshareDlEvent = function (p) {
    if (!p || !p.type) return;
    if (p.type === "start" || p.type === "progress") {
      const cur = state.dlRunning[p.id] || { name: p.name || "", dir: p.dir || "", size: p.size || 0, ts: p.ts || 0 };
      cur.name = p.name || cur.name;
      cur.dir = p.dir || cur.dir;
      cur.size = p.size || cur.size;
      cur.received = p.received || 0;
      cur.total = p.total || 0;
      cur.ts = p.ts || cur.ts;
      state.dlRunning[p.id] = cur;
      if (state.view === "dlcenter" && state.dlTab === "running") {
        const row = document.querySelector('[data-dlr="' + p.id + '"]');
        const bar = row && row.querySelector(".dlc-bar-fill");
        const pct = row && row.querySelector(".dlc-pct");
        if (bar) {
          bar.style.width = safePct(cur.received, cur.total) + "%";
          if (pct) pct.textContent = safePct(cur.received, cur.total) + "%";
        }
      }
    } else if (p.type === "done") {
      delete state.dlRunning[p.id];
      loadLocalDownloads();   // 从桌面端拉最新历史（已完成列表刷新）
    } else if (p.type === "record") {
      // 桌面端写入「已取消/下载失败」历史后刷新列表
      loadLocalDownloads();
    }
    updateDlBadge();
  };

  // ---- 本机下载接管：/api/dlcopy 后台复制 + SSE 进度 -> 按钮圆圈进度条 ----
  function dlCopyEnabled() {
    return !!(state.config && state.config.is_local &&
      state.config.download_dir && window.native);
  }

  function startDlCopy(shareId, path, btn, isDir) {
    // 防重复点击：按钮已挂任务时忽略
    if (btn && (btn.dataset.dlpyid || btn.dataset.dlctask)) {
      toast("该文件已有下载任务（可到下载中心继续）", "ok");
      return;
    }
    const name = path.split("/").filter(Boolean).pop() || "文件";
    const task = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    // 进入下载中列表 + 顶栏角标
    state.dlRunning[task] = { name: name, dir: state.config.download_dir || "", size: 0, received: 0, total: 0, ts: Date.now() / 1000 };
    state.dlCopy[task] = { name: name };
    updateDlBadge();
    // 按钮 -> 同尺寸圆圈进度（不跳动布局）
    btn.dataset.dlctask = task;
    btn.dataset.dlRestore = btn.innerHTML;
    btn.classList.add("is-busy");
    btn.innerHTML = '<span class="dl-ring" style="--p:0"></span>';
    fetch("/api/dlcopy?share=" + encodeURIComponent(shareId) +
      "&path=" + encodeURIComponent(path) + "&task=" + encodeURIComponent(task))
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        if (!d || !d.ok) {
          resetDlBtn(btn, task, name);
          toast("保存失败：请检查「高级设置 → 下载位置」", "error");
        }
      })
      .catch(() => {
        resetDlBtn(btn, task, name);
        toast("下载请求失败", "error");
      });
  }

  function handleDlCopy(p) {
    if (!p || !p.task) return;
    const btn = document.querySelector('[data-dlctask="' + p.task + '"]');
    const ring = btn && btn.querySelector(".dl-ring");
    if (p.type === "progress") {
      const pct = Math.min(100, p.percent || 0);
      if (ring) ring.style.setProperty("--p", pct);
      // 同步下载中心「下载中」列表进度（总进度按 100% 计）
      const cur = state.dlRunning[p.task];
      if (cur) { cur.received = pct; cur.total = 100; }
      if (state.view === "dlcenter" && state.dlTab === "running") {
        const row = document.querySelector('[data-dlr="' + p.task + '"]');
        const bar = row && row.querySelector(".dlc-bar-fill");
        const pctEl = row && row.querySelector(".dlc-pct");
        if (bar) {
          bar.style.width = pct + "%";
          if (pctEl) pctEl.textContent = pct + "%";
        }
      }
    } else if (p.type === "done") {
      if (ring) {
        ring.style.setProperty("--p", 100);
        ring.classList.add("is-done");
      }
      delete state.dlRunning[p.task];
      delete state.dlCopy[p.task];
      updateDlBadge();
      dropDlRow(p.task);
      setTimeout(() => resetDlBtn(btn, p.task), 1200);
      loadLocalDownloads();
    } else if (p.type === "canceled") {
      // 用户取消 dlcopy（文件夹/文件后台复制）：任务从列表移除，角标同步减少
      if (ring) { ring.classList.add("is-done"); }
      delete state.dlRunning[p.task];
      delete state.dlCopy[p.task];
      updateDlBadge();
      dropDlRow(p.task);
      setTimeout(() => resetDlBtn(btn, p.task), 300);
    } else if (p.type === "error") {
      resetDlBtn(btn, p.task);
      delete state.dlRunning[p.task];
      delete state.dlCopy[p.task];
      updateDlBadge();
      dropDlRow(p.task);
      toast("保存失败：请检查「高级设置 → 下载位置」", "error");
    }
  }

  function resetDlBtn(btn, task) {
    if (!btn || !task) return;
    if (btn.dataset.dlctask !== task) return;
    delete btn.dataset.dlctask;
    const restore = btn.dataset.dlRestore;
    delete btn.dataset.dlRestore;
    btn.classList.remove("is-busy");
    if (!restore) { btn.remove(); return; }  // 右键菜单的临时按钮（原本无内容）：完成后直接移除，不残留"下载"按钮
    btn.innerHTML = restore;
  }

  // 顶栏「下载中心」红色角标：实时显示正在下载的任务数
  function updateDlBadge() {
    const b = $("#dlBadge");
    if (!b) return;
    const n = Object.keys(state.dlRunning || {}).length;
    if (n > 0) {
      b.textContent = n > 99 ? "99+" : n;
      b.classList.add("show");
    } else {
      b.classList.remove("show");
    }
  }

  function fmtSpeed(bps) {
    if (!bps || bps <= 0) return "";
    if (bps >= 1048576) return (bps / 1048576).toFixed(1) + " MB/s";
    if (bps >= 1024) return (bps / 1024).toFixed(0) + " KB/s";
    return Math.round(bps) + " B/s";
  }

  // ---- Python 下载器（断点续传 + 传输队列）：本机文件下载走桌面端下载器 ----
  function pyDlEnabled() {
    return !!(window.native && window.native.startDownload &&
      state.config && state.config.download_dir);
  }

  function startPyDl(shareId, path, btn, isDir, sizeHint) {
    // 防重复点击：按钮已挂任务（下载中/暂停/复制中）时忽略，避免第二个任务写同一文件
    if (btn && (btn.dataset.dlpyid || btn.dataset.dlctask)) {
      toast("该文件已有下载任务（可到下载中心继续）", "ok");
      return;
    }
    const name = path.split("/").filter(Boolean).pop() || "文件";
    // Python 下载器(urllib)不认相对 URL，必须拼绝对地址
    const base = (location.origin && location.origin !== "null") ? location.origin :
      ("http://" + (location.hostname || "127.0.0.1") + ":" + (location.port || 8765));
    const url = base + (isDir ? "/api/zip" : "/api/download") + "?share=" +
      encodeURIComponent(shareId) + "&path=" + encodeURIComponent(path);
    const task = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    if (btn) {
      btn.dataset.dlctask = task;
      btn.dataset.dlRestore = btn.innerHTML;
      btn.classList.add("is-busy");
      btn.innerHTML = '<span class="dl-ring" style="--p:0"></span>';
    }
    window.native.startDownload(url, name, Number(sizeHint) || 0, function (res) {
      let d = {};
      try { d = JSON.parse(res || "{}"); } catch (e) { d = {}; }
      if (!d.ok) {
        resetDlBtn(btn, task);
        toast(d.error || "下载启动失败：请先设置下载位置", "error");
        return;
      }
      const jid = d.id;
      const done0 = Number(d.done) || 0, total0 = Number(d.total) || 0;
      state.dlRunning[jid] = {
        id: jid, name: d.name || name, dir: d.dir || "", size: total0,
        received: done0, total: total0, speed: 0, pyState: "running",
        error: "", ts: Date.now() / 1000,
      };
      // 按钮圆圈进度由轮询驱动（关联任务 id）；续传时先显示已下载部分的进度
      if (btn) { btn.dataset.dlpyid = jid; btn.dataset.dlctask = ""; }
      const ring = btn && btn.querySelector(".dl-ring");
      if (ring && total0 > 0) ring.style.setProperty("--p", safePct(done0, total0));
      updateDlBadge();
      if (state.view === "dlcenter" && state.dlTab === "running") renderDlCenter();
    });
  }

  // 已取消记录 → 继续下载：同一 URL 重新启动下载器，.part 在则自动断点续传
  function resumeFromRecord(url, name, btnEl, sizeHint) {
    if (!window.native || !window.native.startDownload) {
      toast("桌面下载器不可用", "error");
      return;
    }
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = "续传中…";
    }
    // 用记录里的总量做 sizeHint：续传立即显示真实进度（不用等轮询）
    window.native.startDownload(url, name, Number(sizeHint) || 0, function (res) {
      let d = {};
      try { d = JSON.parse(res || "{}"); } catch (e) { d = {}; }
      if (!d.ok) {
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = "继续"; }
        toast(d.error || "续传失败：请先设置下载位置", "error");
        return;
      }
      const jid = d.id;
      const done0 = Number(d.done) || 0, total0 = Number(d.total) || 0;
      state.dlRunning[jid] = {
        id: jid, name: d.name || name, dir: d.dir || "", size: total0,
        received: done0, total: total0, speed: 0, pyState: "running",
        error: "", ts: Date.now() / 1000,
      };
      updateDlBadge();
      if (state.view === "dlcenter" && state.dlTab === "running") renderDlCenter();
      else toast("已从中断处继续下载", "ok");
    });
  }

  // 传输队列轮询：Python 下载器状态同步（600ms，轻量 JSON）
  function resetPyBtn(jid) {
    const btn = document.querySelector('[data-dlpyid="' + jid + '"]');
    if (!btn) return;
    delete btn.dataset.dlpyid;
    const restore = btn.dataset.dlRestore;
    delete btn.dataset.dlRestore;
    btn.classList.remove("is-busy");
    if (!restore) { btn.remove(); return; }
    btn.innerHTML = restore;
  }

  let _pyDlTimer = null;
  function startPyDlPoll() {
    if (_pyDlTimer || !window.native || !window.native.getDownloads) return;
    _pyDlTimer = setInterval(() => {
      try {
        window.native.getDownloads(function (json) {
          let items = [];
          try { items = (JSON.parse(json || "{}").items) || []; } catch (e) {}
          applyPyDls(items);
        });
      } catch (e) { /* ignore */ }
    }, 600);
  }

  // 任务 done/canceled 后：仅移除对应行（不整表重渲染防跳动），空列表补 empty 文案、页签计数同步
  function dropDlRow(id) {
    if (state.view !== "dlcenter" || state.dlTab !== "running") return;
    const row = document.querySelector('.dlc-running[data-dlr="' + id + '"]');
    if (row) row.remove();
    const tab = document.querySelector('.dlc-tab[data-dlc="running"]');
    const n = Object.keys(state.dlRunning).length;
    if (tab) tab.textContent = "下载中（" + n + "）";
    const body = document.querySelector(".dlc-body");
    if (body && !body.querySelector(".dlc-row")) {
      body.innerHTML = '<div class="empty">没有正在下载的任务</div>';
    }
  }

  // 单行 patch：只更新进度/速度/状态文字，不重建整行整表（hover 不丢、布局不跳）。
  // 状态切换时按钮区也不重建节点——只改控制按钮的文案/委托标记/样式，
  // 避免点「暂停」瞬间按钮消失重建（悬停丢失、视觉抽动）。
  function patchDlRow(it, row, prevState) {
    if (!row) return;
    const bar = row.querySelector(".dlc-bar-fill");
    const pctEl = row.querySelector(".dlc-pct");
    const spEl = row.querySelector(".dlc-speed");
    const stEl = row.querySelector(".dlc-state");
    const actions = row.querySelector(".dlc-actions");
    const pct = safePct(it.received, it.total);
    if (bar) bar.style.width = pct + "%";
    if (pctEl) pctEl.textContent = it.total > 0 ? pct + "%" : "…";
    const paused = it.state === "paused";
    const errored = it.state === "error";
    if (spEl) spEl.textContent = paused ? "0 B/s" : fmtSpeed(it.speed || 0);
    if (stEl) {
      stEl.textContent = errored ? "失败" : (paused ? "已暂停" : "下载中");
      if (paused) stEl.style.setProperty("color", "var(--warn,#e6a23c)");
      else stEl.style.removeProperty("color");
    }
    if (actions && prevState !== it.state) {
      const ctl = actions.querySelector("[data-dl-pause],[data-dl-resume],[data-dl-retry]");
      if (ctl) {
        // 原地修改按钮（不重建节点、不改样式/宽度）：暂停↔继续↔重试
        // className 保持不变（统一 ghost + 固定 min-width），避免按钮变宽导致行布局抽动
        ctl.textContent = errored ? "重试" : (paused ? "继续" : "暂停");
        delete ctl.dataset.dlPause;
        delete ctl.dataset.dlResume;
        delete ctl.dataset.dlRetry;
        if (errored) ctl.dataset.dlRetry = it.id;
        else if (paused) ctl.dataset.dlResume = it.id;
        else ctl.dataset.dlPause = it.id;
      }
    }
  }

  function applyPyDls(items) {
    const seen = {};
    for (const it of items) {
      if (!it.id || String(it.id).indexOf("py") !== 0) continue;
      seen[it.id] = true;
      const cur = state.dlRunning[it.id];
      if (it.state === "done") {
        if (cur) { delete state.dlRunning[it.id]; updateDlBadge(); }
        resetPyBtn(it.id);
        dropDlRow(it.id);
        loadLocalDownloads(); // 完成 → 刷新历史
        continue;
      }
      if (it.state === "canceled") {
        if (cur) { delete state.dlRunning[it.id]; updateDlBadge(); }
        resetPyBtn(it.id);
        dropDlRow(it.id);
        continue;
      }
      const prevState = cur && cur.pyState;
      state.dlRunning[it.id] = {
        id: it.id, name: it.name, dir: it.dir, size: it.total || 0,
        received: it.done || 0, total: it.total || 0, speed: it.speed || 0,
        pyState: it.state, error: it.error || "", ts: it.ts || Date.now() / 1000,
      };
      // 按钮圆圈进度（暂停时保持加载圈不动，悬停提示防止误点重复下载）
      const btn = document.querySelector('[data-dlpyid="' + it.id + '"]');
      if (btn) {
        const ring = btn.querySelector(".dl-ring");
        if (ring) ring.style.setProperty("--p", it.pct || 0);
        btn.title = it.state === "paused" ? "已暂停 · 点击下载中心继续" : "正在下载";
      }
      // 行内更新：同一行始终 patch（不整表重渲染）；只有行不存在（新任务）才整表渲染
      if (state.view === "dlcenter" && state.dlTab === "running") {
        const row = document.querySelector('[data-dlr="' + it.id + '"]');
        if (row) {
          patchDlRow(it, row, prevState);
        } else {
          renderDlCenter();
        }
      }
    }
    // 清理已消失的 py 任务（取消/删除后角标同步减少）
    let removed = false;
    const goneKeys = [];
    for (const k of Object.keys(state.dlRunning)) {
      if (String(k).indexOf("py") === 0 && !seen[k]) {
        delete state.dlRunning[k];
        removed = true;
        goneKeys.push(k);
      }
    }
    if (removed) {
      updateDlBadge();
      if (state.view === "dlcenter" && state.dlTab === "running") {
        for (const k of goneKeys) dropDlRow(k);
      }
    }
  }

  function loadLocalDownloads() {
    if (!window.native) return;
    window.native.getLocalDownloads(function (json) {
      try {
        const list = JSON.parse(json || "[]");
        // 过滤 .part 临时文件残留（取消/中断的下载不算已完成）
        state.dlHistory = list.filter((it) => !String(it.name || "").toLowerCase().endsWith(".part"));
      } catch (e) { state.dlHistory = []; }
      if (state.view === "dlcenter") renderDlCenter();
    });
  }

  function renderDlCenter() {
    const el = $("#view");
    if (!el) return;
    const running = Object.values(state.dlRunning);
    const done = state.dlHistory || [];
    const active = state.dlTab === "running";
    let html = '<div class="section-head"><div><h2 class="section-title">下载中心</h2>' +
      '<div class="section-sub">本机下载进度与历史（已下载文件可点击打开所在文件夹）</div></div></div>' +
      '<div class="dlc-tabs"><button class="dlc-tab' + (active ? " is-active" : "") + '" data-dlc="running" type="button">下载中（' + running.length + '）</button>' +
      '<button class="dlc-tab' + (!active ? " is-active" : "") + '" data-dlc="done" type="button">下载记录（' + done.length + '）</button>' +
      (!active ? '<button class="btn btn-ghost btn-sm" type="button" id="dlcRefresh">⟳ 刷新</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" id="dlcClear">清空全部记录</button>' : "") + "</div>" +
      '<div class="dlc-body">' + (active ? dlcRunningHtml(running) : dlcDoneHtml(done)) + "</div>";

    // 固定容器高度 + 页签区独立渲染：切页签/清空只换列表体，头部与页签不跳动
    const head = el.querySelector(".section-head");
    const tabs = el.querySelector(".dlc-tabs");
    el.innerHTML = html;

    el.querySelectorAll("[data-dlc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (state.dlTab === btn.dataset.dlc) return;
        state.dlTab = btn.dataset.dlc;
        renderDlCenter();
      });
    });
    const refresh = $("#dlcRefresh");
    if (refresh) {
      refresh.addEventListener("click", () => {
        loadLocalDownloads();
        toast("已刷新", "ok");
      });
    }
    const clear = $("#dlcClear");
    if (clear) {
      clear.addEventListener("click", async () => {
        if (!confirm("确定清空全部下载记录？\n只清除这里的历史列表，不影响已下载的文件。")) return;
        try {
          await window.native.clearLocalDownloads(function (ok) {});
          loadLocalDownloads();
          toast("已清空下载记录", "ok");
        } catch (e) { toast("清空失败：" + e.message, "error"); }
      });
    }
    // 委托：单条清除 / 打开所在文件夹
    el.addEventListener("click", (ev) => {
      const rm = ev.target.closest("[data-dlr-rm]");
      if (rm) {
        ev.stopPropagation();
        const key = rm.dataset.dlrRm;
        window.native.removeLocalDownload(key, function (ok) {
          if (ok) loadLocalDownloads();
        });
        return;
      }
      const btn = ev.target.closest("[data-dlr-open]");
      if (btn && btn.dataset.dlrOpen) {
        ev.stopPropagation();
        window.native.openDownloadFolder(btn.dataset.dlrOpen, btn.dataset.dlrPath || "");
        return;
      }
      const row = ev.target.closest("[data-dlr-open]");
      if (row && row.dataset.dlrOpen) window.native.openDownloadFolder(row.dataset.dlrOpen);
      // 已取消记录里的「继续」：从中断处续传（已下载部分保留复用）
      const rr = ev.target.closest("[data-dl-resume-rec]");
      if (rr) {
        ev.stopPropagation();
        resumeFromRecord(rr.dataset.dlResumeRec, rr.dataset.dlResumeName || "", rr,
          Number(rr.dataset.dlResumeTotal) || 0);
        return;
      }
      // 传输队列操作：暂停 / 继续 / 重试 / 取消
      const pa = ev.target.closest("[data-dl-pause]");
      if (pa) { ev.stopPropagation(); window.native.pauseDownload(pa.dataset.dlPause); return; }
      const rs = ev.target.closest("[data-dl-resume]");
      if (rs) { ev.stopPropagation(); window.native.resumeDownload(rs.dataset.dlResume); return; }
      const rt = ev.target.closest("[data-dl-retry]");
      if (rt) { ev.stopPropagation(); window.native.retryDownload(rt.dataset.dlRetry); return; }
      const cc = ev.target.closest("[data-dl-cancel]");
      if (cc) {
        ev.stopPropagation();
        showDlCancelConfirm(cc.dataset.dlCancel);
        return;
      }
    });
  }

  // 自绘确认弹层：QtWebEngine 原生 confirm 有键盘焦点循环 bug（点 OK 后按钮仍聚焦，
  // Enter 会持续触发 click → 弹窗无限弹、取消失效），改用 DOM 弹层，点「确认取消」即移除+执行。
  let __dlConfirmEl = null;
  function showDlCancelConfirm(jid) {
    if (__dlConfirmEl) return; // 防重入
    const isPy = String(jid || "").indexOf("py") === 0;
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = '<div class="modal-card" style="max-width:360px">' +
      '<div class="modal-head"><h3 class="modal-title">取消下载</h3></div>' +
      '<p class="modal-desc">' + (isPy
        ? "确定取消该下载？已下载的部分会保留，重新下载可从中断处继续。"
        : "确定取消该下载？已复制的部分将被删除。") + "</p>" +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost btn-sm" data-dl-confirm-no>再想想</button>' +
      '<button type="button" class="btn btn-danger btn-sm" data-dl-confirm-yes>确认取消</button>' +
      "</div></div>";
    m.addEventListener("click", (e) => {
      if (e.target.closest("[data-dl-confirm-no]") || e.target === m) {
        __dlConfirmEl = null;
        m.remove();
      } else if (e.target.closest("[data-dl-confirm-yes]")) {
        __dlConfirmEl = null;
        m.remove(); // 先移除弹层，再执行取消（消除焦点/事件回流）
        try { window.native.cancelDownload(jid); } catch (err) { /* ignore */ }
      }
    });
    document.body.appendChild(m);
    __dlConfirmEl = m;
  }

  // 下载中心「下载中」行操作按钮区（py 下载器：暂停/继续/重试+取消；dlcopy 复制任务：取消）
  function dlcActionsHtml(it) {
    const st = it.state || it.pyState;
    const isPy = String(it.id || "").indexOf("py") === 0;
    const paused = st === "paused";
    const errored = st === "error";
    let inner;
    if (isPy) {
      inner = (errored
        ? '<button class="btn btn-primary btn-sm" type="button" data-dl-retry="' + esc(it.id) + '">重试</button>'
        : (paused
          ? '<button class="btn btn-primary btn-sm" type="button" data-dl-resume="' + esc(it.id) + '">继续</button>'
          : '<button class="btn btn-ghost btn-sm" type="button" data-dl-pause="' + esc(it.id) + '">暂停</button>')) +
        '<button class="btn btn-ghost btn-sm" type="button" data-dl-cancel="' + esc(it.id) + '" title="取消（保留已下载部分，重新下载可继续）">取消</button>';
    } else {
      inner = '<button class="btn btn-ghost btn-sm" type="button" data-dl-cancel="' + esc(it.id) + '" title="取消并删除已复制部分">取消</button>';
    }
    return '<div class="dlc-actions">' + inner + "</div>";
  }

  function dlcRunningHtml(running) {
    if (!running.length) return '<div class="empty">没有正在下载的任务</div>';
    let html = "";
    for (const it of running) {
      const pct = safePct(it.received, it.total);
      const isPy = String(it.id || "").indexOf("py") === 0;
      const paused = it.pyState === "paused";
      const errored = it.pyState === "error";
      html += '<div class="dlc-row dlc-running" data-dlr="' + esc(it.id) + '">' +
        '<span class="row-icon">' + I.download + "</span>" +
        '<div class="dlc-main"><div class="dlc-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div>" +
        '<div class="dlc-bar"><div class="dlc-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="dlc-sub">' +
        '<span class="dlc-pct">' + (it.total > 0 ? pct + "%" : "…") + "</span>" +
        (isPy && it.speed ? '<span class="dlc-speed">' + fmtSpeed(it.speed) + "</span>" : "") +
        '<span class="dlc-state"' + (paused ? ' style="color:var(--warn,#e6a23c)"' : "") + ">" +
        (errored ? "失败" : (paused ? "已暂停" : "下载中")) + "</span>" +
        (it.total > 0 ? '<span>' + fmtSize(it.received) + " / " + fmtSize(it.total) + "</span>" : "") +
        '<span class="dlc-dir" title="' + esc(it.dir) + '">' + esc(it.dir) + "</span></div>" +
        (errored && it.error ? '<div class="dlc-err" title="' + esc(it.error) + '">' + esc(it.error) + "</div>" : "") +
        "</div>" + dlcActionsHtml(it) + "</div>";
    }
    return html;
  }

  function dlcDoneHtml(done) {
    if (!done.length) return '<div class="empty">还没有下载记录</div>';
    let html = '<div class="dlc-row dlc-head"><span></span><span>文件</span><span>大小</span><span>时间</span><span>保存位置</span><span></span></div>';
    for (const it of done) {
      const st = it.status || "done";
      if (st === "canceled" || st === "error") {
        // 已取消 / 下载失败：状态分明，不当作下载完成显示
        const shown = st === "canceled" ? "已取消" : "下载失败";
        const sizeTxt = it.received
          ? (it.total > it.received
            ? "已下载 " + fmtSize(it.received) + " / " + fmtSize(it.total)
            : fmtSize(it.received))
          : "--";
        html += '<div class="dlc-row dlc-done dlc-st-' + st + '">' +
          '<span class="row-icon">' + fileIcon(it.name) + "</span>" +
          '<div class="dlc-main"><div class="dlc-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div>" +
          '<span class="dlc-badge dlc-badge-' + st + '">' + shown + "</span></div>" +
          '<span class="dlc-cell">' + sizeTxt + "</span>" +
          '<span class="dlc-cell">' + fmtTime(it.ts) + "</span>" +
          '<span class="dlc-cell dlc-cell-muted">—</span>' +
          '<span class="dlc-row-actions">' +
          (st === "canceled" && it.url
            ? '<button class="btn btn-primary btn-sm" type="button" data-dl-resume-rec="' + esc(it.url) + '" data-dl-resume-name="' + esc(it.name) + '" data-dl-resume-total="' + (it.total || 0) + '" title="从中断处继续下载（已下载的部分不用重下）">继续</button>'
            : "") +
          '<button class="btn btn-ghost btn-sm btn-dlr" type="button" data-dlr-rm="' + esc(it.key) + '" title="清除这条记录">' + I.trash + "</button>" +
          "</span></div>";
        continue;
      }
      // dir 有值 = 可跳转（软件窗口内下载：真实路径；外部浏览器下载：定位到的浏览器下载目录/文件）
      const hasLoc = !!it.dir;
      // 有路径但文件已被删除/移动 -> 显示「找不到」，置灰不可点
      const gone = hasLoc && it.exists === false;
      const locTitle = gone
        ? "文件已被删除或移动，找不到原文件"
        : (hasLoc
          ? (it.path ? "打开所在文件夹（已定位到文件）" : "打开浏览器下载目录")
          : "未能定位下载位置（浏览器下载目录不在默认位置，可在浏览器设置里查看）");
      html += '<div class="dlc-row dlc-done">' +
        '<span class="row-icon">' + fileIcon(it.name) + "</span>" +
        '<div class="dlc-main"><div class="dlc-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div></div>" +
        '<span class="dlc-cell">' + (it.size ? fmtSize(it.size) : "--") + "</span>" +
        '<span class="dlc-cell">' + fmtTime(it.ts) + "</span>" +
        '<span class="dlc-pos" title="' + locTitle + '">' +
        (gone
          ? '<span class="dlc-unknown dlc-gone" title="' + locTitle + '">找不到</span>'
          : (hasLoc
            ? '<button class="btn btn-ghost btn-sm btn-dloc" type="button" data-dlr-open="' + esc(it.dir) + '" data-dlr-path="' + esc(it.path || "") + '" title="' + locTitle + '">' + I.folder + "</button>"
            : '<span class="dlc-unknown">未定位</span>')) +
        "</span>" +
        '<button class="btn btn-ghost btn-sm btn-dlr" type="button" data-dlr-rm="' + esc(it.key) + '" title="清除这条记录">' + I.trash + "</button></div>";
    }
    return html;
  }

  function renderHeader(cfg) {
    $("#serverName").textContent = cfg.server_name;
    const addr = cfg.addresses && cfg.addresses[0]
      ? (location.protocol + "//" + cfg.addresses[0] + ":" + location.port + "/")
      : (location.protocol + "//" + location.host + "/");
    $("#addrText").textContent = addr;
    $("#localTag").hidden = !cfg.is_local;
    $("#adminTab").hidden = !cfg.is_local;
    // 下载中心仅桌面版（本机 Qt 壳）显示：依赖桌面桥的下载事件与本地历史
    $("#dlTab").hidden = !(cfg.is_local && window.native);
    $("#peerCount").textContent = state.peers.length ? String(state.peers.length) : "";
  }

  // 共享排序：置顶在前，置顶组内按 pin_at 倒序（后置顶/拖动后排前面的在前）
  function sortShares(arr) {
    return arr.slice().sort((a, b) => {
      const pa = a.pin ? 1 : 0, pb = b.pin ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (pa) return ((b.pin_at || 0) - (a.pin_at || 0)) || 0;
      return 0;
    });
  }

  function renderShares() {
    const cfg = state.config;
    // 置顶的共享排在最前
    const shares = sortShares(cfg.shares || []);
    let html = '<div class="section-head"><div><h2 class="section-title">共享文件夹</h2>' +
      '<div class="section-sub">在本机「管理」页添加共享；局域网设备已自动发现本机</div></div></div>';
    if (!shares.length) {
      html += '<div class="empty">' + I.empty + '<div>还没有共享文件夹' +
        (cfg.is_local ? '，切换到「管理」页添加一个</div>' : '，请让主机在本机添加共享</div>') + '</div>';
    } else {
      html += '<div class="card-grid">';
      for (const s of shares) {
        const badge = s.perm === "public"
          ? '<span class="badge badge-public">公开</span>'
          : s.perm === "password"
            ? '<span class="badge badge-password">' + I.lock + '密码</span>'
            : '<span class="badge badge-private">仅自己</span>';
        const writeBadge = s.writable ? '<span class="badge badge-write">可上传</span>' : "";
        const pathHtml = s.path ? '<div class="share-path" title="' + esc(s.path) + '">' + esc(s.path) + "</div>" : "";
        html += '<div class="share-card" data-share="' + esc(s.id) + '">' +
          '<div class="share-top"><span class="share-icon">' + I.folder + '</span>' +
          '<span class="share-name" title="' + esc(s.name) + '">' + esc(s.name) + "</span></div>" +
          pathHtml +
          '<div class="share-meta">' + badge + writeBadge + "</div>" +
          '<div class="share-actions">' +
          '<button class="btn btn-primary btn-sm" data-act="open">打开</button>' +
          '<button class="btn btn-ghost btn-sm" data-act="copy">' + I.copy + '复制链接</button>' +
          "</div></div>";
      }
      html += "</div>";
    }
    $("#view").innerHTML = html;
    // 恢复进入浏览前的滚动位置（防止返回时布局"看起来变了"）
    const st = state.sharesScroll || 0;
    if (st) $("#view").scrollTop = st;
  }

  function renderBrowse() {
    const s = state.share;
    if (!s) return renderShares();
    const segs = (state.path === "/" ? [] : state.path.split("/"));
    let crumb = '<button class="crumb" data-nav="/">' + esc(s.name) + "</button>";
    let acc = "";
    segs.forEach((seg, i) => {
      acc += "/" + seg;
      crumb += '<span class="crumb-sep">/</span>' +
        '<button class="crumb" data-nav="' + esc(acc) + '">' + esc(seg) + "</button>";
    });

    const canUpload = !!s.writable;
    const canDirect = dlCopyEnabled();
    let html = '<div class="browse-top">' +
      '<button class="btn btn-ghost btn-sm" id="btnHome">' + I.back + '返回共享列表</button>' +
      "</div>" +
      '<div class="breadcrumb">' + crumb + "</div>" +
      '<div class="section-head"><div class="section-sub" id="browseCount"></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      (state.path !== "/" ? '<button class="btn btn-ghost btn-sm" id="btnUp">' + I.back + '上级目录</button>' : "") +
      '<button class="btn btn-ghost btn-sm" id="btnZip">' +
      (canDirect ? I.download + '下载整个文件夹' : I.zip + '打包下载 ZIP') + "</button>" +
      (canUpload ? '<button class="btn btn-primary btn-sm" id="btnUpload">' + I.upload + '上传文件</button>' : "") +
      "</div></div>" +
      (canUpload ? '<div class="drop-hint">可上传：把文件拖进下方列表，或点「上传文件」</div>' : "") +
      "<div class='file-list' id='fileList'" + (canUpload ? " data-drop='1'" : "") + "></div>" +
      '<div class="upload-list" id="uploadList"></div>';

    $("#view").innerHTML = html;

    const home = $("#btnHome");
    if (home) {
      home.addEventListener("click", () => {
        state.share = null;
        state.path = "/";
        render();
      });
    }

    if (canUpload) {
      let fi = $("#fileInput");
      if (!fi) {
        fi = document.createElement("input");
        fi.type = "file";
        fi.id = "fileInput";
        fi.multiple = true;
        fi.hidden = true;
        document.body.appendChild(fi);
      }
      $("#btnUpload").addEventListener("click", () => fi.click());
      fi.onchange = () => {
        if (fi.files && fi.files.length) {
          uploadFiles(Array.from(fi.files));
          fi.value = "";
        }
      };
      const fl = $("#fileList");
      fl.addEventListener("dragover", (ev) => { ev.preventDefault(); fl.classList.add("is-over"); });
      fl.addEventListener("dragleave", () => fl.classList.remove("is-over"));
      fl.addEventListener("drop", (ev) => {
        ev.preventDefault();
        fl.classList.remove("is-over");
        const files = ev.dataTransfer && ev.dataTransfer.files ? Array.from(ev.dataTransfer.files) : [];
        if (files.length) uploadFiles(files);
      });
    }

    document.querySelectorAll(".crumb").forEach((el) => {
      el.addEventListener("click", () => navigate(s.id, el.dataset.nav));
    });
    const up = $("#btnUp");
    if (up) up.addEventListener("click", () => navigate(s.id, s.parent || "/"));
    const zip = $("#btnZip");
    if (zip) {
      zip.addEventListener("click", () => {
        if (dlCopyEnabled()) {
          startDlCopy(s.id, state.path, zip, true);
        } else {
          location.href = "/api/zip?share=" + encodeURIComponent(s.id) +
            "&path=" + encodeURIComponent(state.path);
        }
      });
    }

    loadListing();
  }

  async function loadListing() {
    const s = state.share;
    const listEl = $("#fileList");
    if (!listEl) return;
    listEl.innerHTML = '<div class="empty" style="padding:26px">读取中…</div>';
    try {
      const data = await api("/api/list?share=" + encodeURIComponent(s.id) +
        "&path=" + encodeURIComponent(state.path));
      state.share.parent = data.parent;
      const entries = data.entries || [];
      const dirs = entries.filter((e) => e.type === "dir");
      const files = entries.filter((e) => e.type === "file");
      $("#browseCount").textContent = dirs.length + " 个文件夹 · " + files.length + " 个文件";
      if (!entries.length) {
        listEl.innerHTML = '<div class="empty">' + I.empty + "<div>此文件夹是空的</div></div>";
        return;
      }
      let html = "";
      for (const e of entries) {
        const isDir = e.type === "dir";
        const icon = isDir ? I.folder : fileIcon(e.name);
        const sub = isDir ? "文件夹" : fmtSize(e.size) + " · " + fmtTime(e.mtime);
        const filePath = (state.path === "/" ? "" : state.path) + "/" + e.name;
        let actions = "";
        if (!isDir) {
          actions = '<div class="row-actions">' +
            '<button class="btn btn-ghost btn-sm" data-act="download" data-path="' + esc(filePath) + '">' + I.download + '<span class="btn-label">下载</span></button>' +
            (INLINE_EXT.has((e.name.split(".").pop() || "").toLowerCase())
              ? '<button class="btn btn-ghost btn-sm" data-act="preview" data-path="' + esc(filePath) + '">预览</button>'
              : "") +
            "</div>";
        }
        html += '<div class="file-row' + (isDir ? " is-dir" : "") + '" data-dir="' + (isDir ? "1" : "0") + '" data-path="' + esc(filePath) + '" data-size="' + (e.size || 0) + '">' +
          '<span class="row-icon">' + icon + "</span>" +
          '<div class="row-main"><div class="row-name" title="' + esc(e.name) + '">' + esc(e.name) + "</div>" +
          '<div class="row-sub">' + sub + "</div></div>" + actions + "</div>";
      }
      listEl.innerHTML = html;

      listEl.querySelectorAll(".file-row").forEach((row) => {
        const isDir = row.dataset.dir === "1";
        const path = row.dataset.path;
        if (isDir) {
          row.addEventListener("click", () => navigate(s.id, path));
          // 右键：下载整个文件夹（ZIP）。stopPropagation 防止 document 的关闭监听立刻收起菜单
          row.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            showCtxMenu(ev.clientX, ev.clientY, s.id, path, row);
          });
        } else {
          row.querySelectorAll("[data-act]").forEach((btn) => {
            btn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (btn.dataset.act === "download") {
                if (pyDlEnabled()) startPyDl(s.id, path, btn, false, Number(row.dataset.size) || 0);
                else if (dlCopyEnabled()) startDlCopy(s.id, path, btn, false);
                else location.href = "/api/download?share=" + encodeURIComponent(s.id) +
                  "&path=" + encodeURIComponent(path);
              } else if (btn.dataset.act === "preview") {
                openPreview(s.id, path);
              }
            });
          });
          row.addEventListener("click", () => {
            openPreview(s.id, path);
          });
        }
      });
    } catch (e) {
      if (e.status === 401) {
        showPwdModal(s.id);
        return;
      }
      listEl.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + "</div>";
    }
  }

  // 右键菜单：目前仅"下载整个文件夹（ZIP）"。浮层 fixed 定位，不占布局、不影响 UI 跳动。
  let _ctxMenu = null;
  function showCtxMenu(x, y, shareId, path, row) {
    closeCtxMenu();
    const direct = dlCopyEnabled();
    _ctxMenu = document.createElement("div");
    _ctxMenu.className = "ctx-menu";
    _ctxMenu.innerHTML =
      '<button type="button" class="ctx-item" data-act="dir">' +
      (direct ? I.download + "下载整个文件夹（到下载位置）" : I.zip + "下载整个文件夹（ZIP）") + "</button>";
    _ctxMenu.style.left = Math.min(x, window.innerWidth - 260) + "px";
    _ctxMenu.style.top = Math.min(y, window.innerHeight - 70) + "px";
    document.body.appendChild(_ctxMenu);
    _ctxMenu.querySelector("[data-act]").addEventListener("click", () => {
      if (direct) {
        // 在文件夹行尾部显示圆圈进度（右键场景也可见）
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn btn-ghost btn-sm";
        btn.style.alignSelf = "center";
        if (row && row.appendChild) row.appendChild(btn);
        startDlCopy(shareId, path, btn, true);
      } else {
        location.href = "/api/zip?share=" + encodeURIComponent(shareId) +
          "&path=" + encodeURIComponent(path);
      }
      closeCtxMenu();
    });
  }
  function closeCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }

  function renderPeers() {
    const isDesktop = !!(window.native);
    let html = '<div class="section-head"><div><h2 class="section-title">局域网设备</h2>' +
      '<div class="section-sub">同一局域网内运行本程序的主机自动实时出现，无需配置</div></div></div>';
    if (!state.peers.length) {
      html += '<div class="empty">' + I.device + "<div>尚未发现其他设备<br>确保对方也启动了「局域网快传」且在同一网络</div></div>";
    } else {
      html += '<div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">';
      for (const p of state.peers) {
        const addr = p.host + ":" + p.port;
        html += '<div class="peer-card">' +
          '<span class="live-dot"></span>' +
          '<span class="peer-icon">' + I.device + "</span>" +
          '<div class="peer-main"><div class="peer-name">' + esc(p.name) + "</div>" +
          '<div class="peer-sub">' + esc(addr) + " · " + p.shares + " 个共享</div></div>" +
          (isDesktop
            ? '<div class="row-actions"><button class="btn btn-primary btn-sm" data-wopen="' + esc(addr) + '">窗口打开</button>' +
              '<button class="btn btn-ghost btn-sm" data-bopen="' + esc(addr) + '">浏览器</button></div>'
            : '<button class="btn btn-primary btn-sm" data-bopen="' + esc(addr) + '">打开</button>') +
          "</div>";
      }
      html += "</div>";
    }
    $("#view").innerHTML = html;
    document.querySelectorAll("[data-bopen]").forEach((el) => {
      el.addEventListener("click", () => {
        window.open("http://" + el.dataset.bopen + "/", "_blank", "noopener");
      });
    });
    document.querySelectorAll("[data-wopen]").forEach((el) => {
      el.addEventListener("click", () => {
        window.native.openPeer(el.dataset.wopen);
      });
    });
  }

  function renderAdmin() {
    if (!state.config || !state.config.is_local) {
      $("#view").innerHTML = '<div class="empty">管理功能仅在本机（localhost）可用</div>';
      return;
    }
    const cfg = state.config;
    let html = '<div class="section-head"><div><h2 class="section-title">管理</h2>' +
      '<div class="section-sub">仅本机可见 · 局域网其他设备无法进入此页面</div></div></div>';

    html += '<form class="admin-form" id="nameForm">' +
      '<div class="form-grid"><div class="field">' +
      '<label for="serverNameInput">设备名称（显示给局域网其他用户）</label>' +
      '<div class="path-row"><input class="input" id="serverNameInput" maxlength="40" value="' + esc(cfg.server_name) + '">' +
      '<button class="btn btn-ghost" type="submit">保存名称</button></div></div></div>' +
      "</form>";

    // 添加共享：折叠卡片（点击展开表单；展开状态跨重渲染保持）
    html += '<div class="admin-form ac-card" id="addShareCard">' +
      '<div class="ac-head" data-toggle role="button" tabindex="0">' +
      '<span class="share-icon">' + I.folder + "</span>" +
      '<div class="ac-main"><div class="ac-name">添加共享文件夹</div>' +
      '<div class="ac-sub">填写名称、选择文件夹、设置权限，即可共享给局域网</div></div>' +
      '<span class="ac-arrow">' + I.back + "</span></div>" +
      '<div class="ac-body"' + (state.addOpen ? "" : " hidden") + '>' +
      '<div class="desktop-only" id="desktopSettings" hidden>' +
      '<div class="dropzone" id="dropZone">' +
      '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M12 11v5"/><path d="M9.5 13.5 12 11l2.5 2.5"/></svg>' +
      '<div><strong>把文件夹拖到窗口任意位置</strong>，自动填入下方路径；确认设置后点「保存共享」才生效</div>' +
      "</div>" +
      '<div class="form-grid" style="margin-top:14px">' +
      '<div class="field"><label for="fLimit">总限速（KB/s，0 = 不限速）</label>' +
      '<div class="path-row"><input class="input" id="fLimit" type="number" min="0" step="100" placeholder="0">' +
      '<button class="btn btn-ghost" type="button" id="btnLimit">保存</button></div></div>' +
      "</div></div>" +
      '<form class="form-grid" id="shareForm">' +
      '<div class="field"><label for="fName">共享名称</label>' +
      '<input class="input" id="fName" placeholder="例如：设计素材" required></div>' +
      '<div class="field"><label for="fPath">文件夹路径</label>' +
      '<div class="path-row"><input class="input" id="fPath" placeholder="例如 D:\\素材\\照片" required>' +
      '<button class="btn btn-ghost" type="button" id="btnPick">选择…</button></div></div>' +
      '<div class="field"><label for="fPerm">访问权限</label>' +
      '<select class="select" id="fPerm">' +
      '<option value="public">公开 — 所有人可浏览下载</option>' +
      '<option value="password">密码保护 — 需要密码才能访问</option>' +
      '<option value="private">仅自己可见 — 不在局域网列表显示</option>' +
      "</select></div>" +
      '<div class="field" id="fPwdField" hidden><label for="fPwd">访问密码（至少 4 位）</label>' +
      '<input class="input" id="fPwd" autocomplete="new-password" placeholder="设置访问密码"></div>' +
      '<div class="field field-full"><label class="check-line">' +
      '<input type="checkbox" id="fWritable"> 允许局域网用户上传文件到该共享（读写模式）</label>' +
      '<div class="field-hint">开启后，局域网用户可往共享夹里传文件；重名文件自动改名，不会覆盖</div></div>' +
      '<div class="modal-actions" style="grid-column:1/-1;margin-top:4px">' +
      '<button class="btn btn-ghost" type="button" id="btnReset" hidden>取消编辑</button>' +
      '<button class="btn btn-primary" type="submit" id="btnSave">保存共享</button>' +
      "</div></form></div></div>";

    html += '<div class="section-head" style="margin-top:6px"><div><h2 class="section-title" style="font-size:15px">已配置的共享</h2>' +
      '<div class="section-sub">点击「编辑」展开修改设置</div></div>' +
      '<input class="input input-search" id="shareSearch" type="text" placeholder="搜索共享…" value="' +
      esc(state.shareSearch || "") + '"></div>' +
      '<div class="admin-list" id="adminList"></div>';

    // 高级设置：开机自启 / 服务端口 / 数据位置 / 清空下载记录（展开状态跨重渲染保持）
    html += '<div class="admin-form ac-card" id="advCard" style="margin-top:6px">' +
      '<div class="ac-head" data-adv-toggle role="button" tabindex="0">' +
      '<span class="share-icon">' + I.settings + "</span>" +
      '<div class="ac-main"><div class="ac-name">高级设置</div>' +
      '<div class="ac-sub">开机自启 · 服务端口 · 下载位置 · 清空下载记录</div></div>' +
      '<span class="ac-arrow">' + I.back + "</span></div>" +
      '<div class="ac-body"' + (state.advOpen ? "" : " hidden") + '>' +
      '<div class="form-grid">' +
      '<div class="field"><label class="check-line"><input type="checkbox" id="advAutostart"' +
      (window.native ? "" : " disabled") + '> 开机自启（开机自动运行，关闭窗口时最小化到托盘）</label></div>' +
      '<div class="field"><label>服务端口</label><input class="input" value="' + esc(cfg.port || "") + '" readonly></div>' +
      '<div class="field"><label>数据目录（配置与下载记录存放处）</label>' +
      '<input class="input" value="' + esc(cfg.data_dir || "") + '" readonly></div>' +
      '<div class="field field-full"><label>下载位置（本机下载的文件保存到哪）</label>' +
      '<div class="path-row"><input class="input" id="dlDirVal" value="' + esc(cfg.download_dir || "") + '"' +
      ' placeholder="未设置——下载时会提醒你先选位置">' +
      '<button class="btn btn-ghost" type="button" id="btnSaveDlDir">保存</button>' +
      '<button class="btn btn-ghost" type="button" id="btnPickDlDir">选择…</button>' +
      '<button class="btn btn-ghost" type="button" id="btnClearDlDir"' + (cfg.download_dir ? "" : " disabled") + '>清除</button></div>' +
      '<div class="field-hint">本机在「软件窗口内」下载的文件会存到这里；用外部浏览器下载时路径由浏览器决定（显示"浏览器下载目录"）。可直接粘贴路径，或点「选择…」</div></div>' +
      '<div class="field field-full"><label class="check-line">下载记录已保留（共 ' +
      '<span id="dlCountHint" style="font-weight:600">—</span> 条）</label></div>' +
      "</div></div></div>";

    html += '<div class="section-head" style="margin-top:6px"><div><h2 class="section-title" style="font-size:15px">下载记录（谁下载过、几次、何时）</h2>' +
      '<div class="section-sub">防止误删还没被下载过的文件 · 有下载记录 = 已被别人拉走</div></div></div>' +
      '<div class="admin-list" id="dlList"></div>';

    $("#view").innerHTML = html;

    // 添加共享折叠卡：点击展开/收起（记录状态，重渲染后保持）
    const addCard = $("#addShareCard");
    if (addCard) {
      const arrow = addCard.querySelector(".ac-arrow");
      if (arrow && state.addOpen) arrow.style.transform = "rotate(90deg)";
      addCard.querySelector("[data-toggle]").addEventListener("click", () => {
        const body = addCard.querySelector(".ac-body");
        body.hidden = !body.hidden;
        state.addOpen = !body.hidden;
        const ar = addCard.querySelector(".ac-arrow");
        if (ar) ar.style.transform = body.hidden ? "" : "rotate(90deg)";
      });
    }

    // 高级设置折叠卡：点击展开/收起（记录状态，重渲染后保持）
    const advCard = $("#advCard");
    if (advCard) {
      const arrow = advCard.querySelector(".ac-arrow");
      if (arrow && state.advOpen) arrow.style.transform = "rotate(90deg)";
      advCard.querySelector("[data-adv-toggle]").addEventListener("click", () => {
        const body = advCard.querySelector(".ac-body");
        body.hidden = !body.hidden;
        state.advOpen = !body.hidden;
        const ar = advCard.querySelector(".ac-arrow");
        if (ar) ar.style.transform = body.hidden ? "" : "rotate(90deg)";
      });
    }

    // 下载位置：保存粘贴路径 / 选择 / 清除（仅本机管理页可见）
    const btnSaveDl = $("#btnSaveDlDir");
    if (btnSaveDl) {
      const saveDlDir = async (dir) => {
        if (!dir) { toast("请先填写下载位置", "error"); return; }
        try {
          const r = await api("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_dir: dir }),
          });
          if (r && r.ok) {
            toast("下载位置已保存：" + dir, "ok");
          } else toast((r && r.error) || "保存失败", "error");
        } catch (e) {
          toast("保存失败：" + e.message, "error");
        }
      };
      btnSaveDl.addEventListener("click", () => saveDlDir($("#dlDirVal").value.trim()));
      $("#dlDirVal").addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); saveDlDir($("#dlDirVal").value.trim()); }
      });
    }
    const btnPickDl = $("#btnPickDlDir");
    if (btnPickDl) {
      btnPickDl.addEventListener("click", async () => {
        if (!window.native || typeof window.native.pickDownloadDir !== "function") {
          toast("仅桌面版可设置下载位置", "error");
          return;
        }
        const dir = await window.native.pickDownloadDir();
        if (!dir) return;
        try {
          const r = await api("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_dir: dir }),
          });
          if (r && r.ok) {
            const val = $("#dlDirVal");
            if (val) val.value = dir;
            const clr = $("#btnClearDlDir");
            if (clr) clr.disabled = false;
            toast("下载位置已设置：" + dir, "ok");
          } else toast((r && r.error) || "保存失败", "error");
        } catch (e) {
          toast("保存失败：" + e.message, "error");
        }
      });
    }
    const btnClearDl = $("#btnClearDlDir");
    if (btnClearDl) {
      btnClearDl.addEventListener("click", async () => {
        if (!confirm("确定清除下载位置？之后下载会再次提醒你选择。")) return;
        try {
          const r = await api("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ download_dir: "" }),
          });
          if (r && r.ok) {
            const val = $("#dlDirVal");
            if (val) val.value = "";
            btnClearDl.disabled = true;
            toast("已清除，下载时将再次提醒选择位置", "ok");
          } else toast((r && r.error) || "保存失败", "error");
        } catch (e) {
          toast("保存失败：" + e.message, "error");
        }
      });
    }

    $("#nameForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server_name: $("#serverNameInput").value.trim() }),
        });
        toast("设备名称已保存", "ok");
        refreshConfig();
      } catch (e) { toast(e.message, "error"); }
    });

    $("#fPerm").addEventListener("change", () => {
      $("#fPwdField").hidden = $("#fPerm").value !== "password";
    });

    $("#btnPick").addEventListener("click", () => {
      if (window.native) {
        window.native.pickFolder((p) => { if (p) $("#fPath").value = p; });
      } else {
        openPicker();
      }
    });
    $("#btnReset").addEventListener("click", () => { state.editing = null; renderAdmin(); });

    // 桌面版专属：拖拽区 / 限速 / 开机自启（开机自启已移入「高级设置」）
    const desk = $("#desktopSettings");
    if (desk && window.native) {
      desk.hidden = false;
      $("#fLimit").value = state.config.speed_limit_kb || 0;
      $("#btnLimit").addEventListener("click", async () => {
        const kb = Math.max(0, parseInt($("#fLimit").value, 10) || 0);
        try {
          await api("/api/limits", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ speed_limit_kb: kb }),
          });
          toast("限速已保存" + (kb ? "（" + kb + " KB/s）" : "（不限速）"), "ok");
        } catch (e) { toast(e.message, "error"); }
      });
      const dz = $("#dropZone");
      if (dz) {
        dz.addEventListener("dragover", (ev) => { ev.preventDefault(); dz.classList.add("is-over"); });
        dz.addEventListener("dragleave", () => dz.classList.remove("is-over"));
        dz.addEventListener("drop", (ev) => {
          ev.preventDefault();
          dz.classList.remove("is-over");
          if (!ev.dataTransfer || !ev.dataTransfer.items) return;
          let hasDir = false;
          for (const it of ev.dataTransfer.items) {
            if (it.kind === "file" && it.webkitGetAsEntry && it.webkitGetAsEntry().isDirectory) hasDir = true;
          }
          if (!hasDir) toast("这里是添加共享文件夹的区域，上传文件请进入共享夹内操作", "error");
          // 目录的真实路径由桌面端 Qt 层解析并填入表单，此处仅提示
        });
      }
    }

    // 高级设置：开机自启（仅桌面版）
    const advAuto = $("#advAutostart");
    if (advAuto && window.native) {
      window.native.getAutostart(function (on) { advAuto.checked = !!on; });
      advAuto.addEventListener("change", () => {
        window.native.setAutostart(advAuto.checked);
        toast(advAuto.checked ? "已开启开机自启" : "已关闭开机自启", "ok");
      });
    }

    $("#shareForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = {
        id: state.editing || undefined,
        name: $("#fName").value.trim(),
        path: $("#fPath").value.trim(),
        perm: $("#fPerm").value,
        password: $("#fPwd").value,
        writable: $("#fWritable") ? $("#fWritable").checked : false,
      };
      try {
        await api("/api/shares", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        toast("共享已保存", "ok");
        state.editing = null;
        $("#shareForm").reset();
        $("#fPwdField").hidden = true;
        renderAdmin();
        refreshConfig();
      } catch (e) { toast(e.message, "error"); }
    });

    renderAdminList();
    renderDlList();
  }

  async function renderDlList() {
    const el = $("#dlList");
    if (!el) return;
    try {
      const data = await api("/api/downloads");
      const items = data.list || [];
      const hint = $("#dlCountHint");
      if (hint) hint.textContent = items.length;
      if (!items.length) {
        el.innerHTML = '<div class="empty" style="padding:24px">暂无下载记录 — 文件还没被别人下载过</div>';
        return;
      }
      // 按「设备名（IP）」分组统计：组头显示下载文件数/次数/最近时间，明细可折叠
      const groups = {};
      for (const d of items) {
        const gk = (d.peer && d.peer !== d.ip) ? d.peer : "未知设备";
        const key = gk + "|" + d.ip;
        if (!groups[key]) groups[key] = { peer: gk, ip: d.ip, rows: [] };
        groups[key].rows.push(d);
      }
      const gArr = Object.values(groups).map((g) => {
        g.last = Math.max.apply(null, g.rows.map((r) => r.last_ts));
        g.total = g.rows.reduce((s, r) => s + r.count, 0);
        g.rows.sort((a, b) => b.last_ts - a.last_ts);
        return g;
      }).sort((a, b) => b.last - a.last);
      const opened = state.dlGrpOpen || (state.dlGrpOpen = {});
      let html = "";
      gArr.forEach((g, gi) => {
        const key = g.peer + "|" + g.ip;
        const isOpen = opened[key] !== undefined ? opened[key] : gi === 0;
        html += '<div class="dl-grp' + (isOpen ? " is-open" : "") + '" data-dlgrp="' + esc(key) + '">' +
          '<button type="button" class="dl-grp-head" data-dlgrp-toggle="' + esc(key) + '">' +
          '<span class="dl-grp-arrow">▸</span>' +
          '<span class="dl-grp-peer">' + esc(g.peer) + '<span class="dl-ip">（' + esc(g.ip) + '）</span></span>' +
          '<span class="dl-grp-stat">下载 ' + g.rows.length + ' 个文件 · ' + g.total + ' 次 · 最近 ' + fmtTime(g.last) + "</span>" +
          "</button>";
        if (isOpen) {
          html += '<div class="dl-grp-body">' +
            '<div class="dl-row dl-head"><span class="dl-name">文件</span><span>共享</span><span>次数</span><span>最近下载</span></div>';
          for (const d of g.rows) {
            html += '<div class="dl-row">' +
              '<span class="dl-name" title="' + esc(d.path) + '">' + esc(d.name) + "</span>" +
              '<span>' + esc(d.share_name) + "</span>" +
              '<span>' + d.count + "</span>" +
              '<span>' + fmtTime(d.last_ts) + "</span></div>";
          }
          html += "</div>";
        }
        html += "</div>";
      });
      html += '<div class="dl-foot"><span class="dl-grp-tip">共 ' + items.length + " 条记录 · " + gArr.length + " 台设备 · 点击设备可展开/折叠</span>" +
        '<button class="btn btn-danger btn-sm" type="button" data-dl-clear>清空记录</button></div>';
      el.innerHTML = html;
      el.querySelectorAll("[data-dlgrp-toggle]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.dlgrpToggle;
          const grp = el.querySelector('[data-dlgrp="' + CSS.escape(key) + '"]');
          const nowOpen = grp && grp.classList.contains("is-open");
          opened[key] = !nowOpen;
          renderDlList();
        });
      });
      const clear = el.querySelector("[data-dl-clear]");
      if (clear) clear.addEventListener("click", async () => {
        if (!confirm("确定清空全部下载记录？\n只影响这里的统计，不影响已下载的文件。")) return;
        try {
          await api("/api/downloads", { method: "POST" });
          toast("下载记录已清空", "ok");
          renderDlList();
        } catch (e) { toast(e.message, "error"); }
      });
    } catch (e) {
      el.innerHTML = '<div class="empty">' + esc(e.message) + "</div>";
    }
  }

  async function renderAdminList() {
    const listEl = $("#adminList");
    if (!listEl) return;
    const all = state.config.shares || [];
    if (!all.length) {
      listEl.innerHTML = '<div class="empty" style="padding:24px">尚未配置共享 — 点上方「添加共享文件夹」</div>';
      return;
    }
    // 搜索过滤（名称/路径）+ 数量约束：默认只显示前 6 个，可展开全部
    const kw = (state.shareSearch || "").trim().toLowerCase();
    let shares = kw
      ? all.filter((s) => (s.name || "").toLowerCase().includes(kw) ||
          (s.path || "").toLowerCase().includes(kw))
      : all;
    // 置顶的共享排在最前（置顶组内按 pin_at 倒序）
    shares = sortShares(shares);
    const LIMIT = 6;
    const showAll = !!state.acShowAll;
    const shown = showAll ? shares : shares.slice(0, LIMIT);
    let html = "";
    for (const s of shown) {
      const badge = s.perm === "public"
        ? '<span class="badge badge-public">公开</span>'
        : s.perm === "password"
          ? '<span class="badge badge-password">' + I.lock + '密码</span>'
          : '<span class="badge badge-private">仅自己</span>';
      const writeBadge = s.writable ? '<span class="badge badge-write">可上传</span>' : "";
      html += '<div class="ac-card" data-id="' + esc(s.id) + '"' + (s.pin ? ' data-pinned="1"' : "") + '>' +
        '<div class="ac-head" data-toggle role="button" tabindex="0"' +
        (s.pin ? ' data-pin-card title="长按拖动可调整置顶顺序"' : "") + '>' +
        '<span class="share-icon">' + I.folder + "</span>" +
        '<div class="ac-main"><div class="ac-name">' + esc(s.name) + " " + badge + writeBadge + "</div>" +
        '<div class="ac-sub">' + esc(s.path || "") + "</div></div>" +
        '<button class="btn btn-ghost btn-sm" type="button" data-ac-pin title="置顶后排在共享列表最前">' +
        (s.pin ? "取消置顶" : "置顶") + "</button>" +
        '<button class="btn btn-ghost btn-sm" type="button" data-ac-toggle>' + I.copy + '编辑</button>' +
        '<button class="btn btn-danger btn-sm" type="button" data-ac-del>删除</button>' +
        "</div>" +
        '<div class="ac-body"' + (state.openShares && state.openShares[s.id] ? "" : " hidden") + '>' +
        '<div class="form-grid">' +
        '<div class="field"><label>共享名称</label>' +
        '<input class="input" data-f="name" value="' + esc(s.name) + '" required></div>' +
        '<div class="field"><label>文件夹路径</label>' +
        '<div class="path-row"><input class="input" id="path-' + esc(s.id) + '" data-f="path" value="' + esc(s.path || "") + '" required>' +
        '<button class="btn btn-ghost" type="button" data-f="pick">选择…</button></div></div>' +
        '<div class="field"><label>访问权限</label>' +
        '<select class="select" data-f="perm">' +
        '<option value="public"' + (s.perm === "public" ? " selected" : "") + '>公开 — 所有人可浏览下载</option>' +
        '<option value="password"' + (s.perm === "password" ? " selected" : "") + '>密码保护 — 需要密码才能访问</option>' +
        '<option value="private"' + (s.perm === "private" ? " selected" : "") + '>仅自己可见 — 不在局域网列表显示</option>' +
        "</select></div>" +
        '<div class="field" data-f="pwdWrap"' + (s.perm === "password" ? "" : " hidden") + ">" +
        '<label>访问密码（至少 4 位）</label>' +
        '<input class="input" data-f="pwd" value="' + esc(s.pwd || "") + '" placeholder="' +
        (s.perm === "password" ? "已设置密码，修改请直接输入" : "") + '"></div>' +
        '<div class="field field-full"><label class="check-line">' +
        '<input type="checkbox" data-f="writable"' + (s.writable ? " checked" : "") + '> 允许局域网用户上传文件到该共享</label></div>' +
        "</div>" +
        '<div class="modal-actions"><button class="btn btn-primary btn-sm" type="button" data-ac-save>保存</button>' +
        '<button class="btn btn-ghost btn-sm" type="button" data-ac-cancel>收起</button></div>' +
        "</div></div>";
    }
    if (shares.length > LIMIT) {
      html += '<div class="dl-foot"><span class="dl-grp-tip">共 ' + shares.length + " 个共享</span>" +
        '<button class="btn btn-ghost btn-sm" type="button" data-ac-more>' +
        (showAll ? "收起" : "显示全部") + "</button></div>";
    }
    listEl.innerHTML = html;

    // 搜索框（只绑一次，重渲染不重复挂监听）
    const sea = $("#shareSearch");
    if (sea && !sea.dataset.bound) {
      sea.dataset.bound = "1";
      sea.addEventListener("input", () => {
        state.shareSearch = sea.value;
        renderAdminList();
      });
    }
    const more = listEl.querySelector("[data-ac-more]");
    if (more) more.addEventListener("click", () => {
      state.acShowAll = !state.acShowAll;
      renderAdminList();
    });

    // 展开/收起 + 删除 + 保存 + 置顶 + 长按拖动排序（事件委托，只绑一次防累积）
    if (!listEl.dataset.bound) {
      listEl.dataset.bound = "1";
      // ---- 长按拖动：仅置顶卡片（data-pin-card），长按 400ms 激活，与点击展开区分 ----
      let pinPressTimer = null, pinDragId = null, pinPressStart = null;
      const pinClear = () => {
        clearTimeout(pinPressTimer);
        pinPressTimer = null; pinPressStart = null;
        const cs = listEl.querySelectorAll(".ac-card");
        cs.forEach((c) => { c.classList.remove("pin-drag-src", "pin-drag-over"); c.removeAttribute("draggable"); });
      };
      listEl.addEventListener("mousedown", (ev) => {
        const head = ev.target.closest("[data-pin-card]");
        if (!head || ev.button !== 0) return;
        const card = head.closest(".ac-card");
        pinPressStart = { x: ev.clientX, y: ev.clientY };
        pinPressTimer = setTimeout(() => {
          pinPressTimer = null;
          pinDragId = card.dataset.id;
          card.classList.add("pin-drag-src");
          card.setAttribute("draggable", "true");
        }, 400);
      });
      listEl.addEventListener("mousemove", (ev) => {
        if (!pinPressTimer || !pinPressStart) return;
        const dx = Math.abs(ev.clientX - pinPressStart.x) + Math.abs(ev.clientY - pinPressStart.y);
        if (dx > 10) { clearTimeout(pinPressTimer); pinPressTimer = null; }
      });
      listEl.addEventListener("mouseup", () => pinClear());
      listEl.addEventListener("dragstart", (ev) => {
        if (!pinDragId) return;
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setData("text/plain", pinDragId); } catch (e) { /* ignore */ }
      });
      listEl.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        const card = ev.target.closest(".ac-card");
        if (card && pinDragId) card.classList.add("pin-drag-over");
      });
      listEl.addEventListener("dragleave", (ev) => {
        const card = ev.target.closest(".ac-card");
        if (card) card.classList.remove("pin-drag-over");
      });
      listEl.addEventListener("dragend", () => pinClear());
      listEl.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        const target = ev.target.closest(".ac-card");
        const srcId = pinDragId;
        pinClear();
        if (!target || !srcId || target.dataset.id === srcId) return;
        const ids = Array.from(listEl.querySelectorAll('.ac-card[data-pinned="1"]'))
          .map((c) => c.dataset.id);
        const from = ids.indexOf(srcId), to = ids.indexOf(target.dataset.id);
        if (from < 0 || to < 0) return;
        ids.splice(from, 1);
        ids.splice(to, 0, srcId);
        try {
          await api("/api/shares/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ order: ids }),
          });
          toast("置顶顺序已保存", "ok");
          refreshConfig();
        } catch (e) { toast(e.message, "error"); }
      });
      // ---- 常规操作（点击） ----
      listEl.addEventListener("click", async (ev) => {
      const card = ev.target.closest(".ac-card");
      if (!card) return;
      const body = card.querySelector(".ac-body");
      const head = card.querySelector(".ac-head");
      if (ev.target.closest("[data-ac-del]")) {
        if (!window.confirm("确定删除该共享？局域网用户将立即无法访问。")) return;
        try {
          await api("/api/shares/" + card.dataset.id, { method: "POST" });
          toast("已删除", "ok");
          refreshConfig();
          renderAdmin();
        } catch (e) { toast(e.message, "error"); }
        return;
      }
      if (ev.target.closest("[data-ac-pin]")) {
        const s = (state.config.shares || []).find((x) => x.id === card.dataset.id);
        if (!s) return;
        const pin = !s.pin;
        try {
          await api("/api/shares", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: s.id, name: s.name, path: s.path,
              perm: s.perm, password: s.perm === "password" ? (s.pwd || "") : "",
              writable: !!s.writable, pin: pin,
            }),
          });
          toast(pin ? "已置顶，排在共享列表最前" : "已取消置顶", "ok");
          refreshConfig();
        } catch (e) { toast(e.message, "error"); }
        return;
      }
      if (ev.target.closest("[data-ac-toggle]") || ev.target === head ||
          ev.target.closest("[data-toggle]")) {
        body.hidden = !body.hidden;
        state.openShares = state.openShares || {};
        state.openShares[card.dataset.id] = !body.hidden;
        ev.stopPropagation();
        return;
      }
      if (ev.target.closest("[data-ac-cancel]")) {
        body.hidden = true;
        state.openShares = state.openShares || {};
        state.openShares[card.dataset.id] = false;
        return;
      }
      if (ev.target.closest("[data-f=pick]")) {
        const input = card.querySelector('[data-f="path"]');
        if (window.native) {
          window.native.pickFolder((p) => { if (p && input) input.value = p; });
        } else {
          openPicker("path-" + card.dataset.id);
        }
        return;
      }
      const permSel = card.querySelector('[data-f="perm"]');
      if (ev.target.closest('[data-f="perm"]')) {
        const wrap = card.querySelector('[data-f="pwdWrap"]');
        if (wrap) wrap.hidden = permSel.value !== "password";
        return;
      }
      if (ev.target.closest("[data-ac-save]")) {
        const get = (k) => (card.querySelector('[data-f="' + k + '"]') || {}).value || "";
        const chk = (k) => card.querySelector('[data-f="' + k + '"]').checked;
        try {
          await api("/api/shares", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: card.dataset.id,
              name: get("name").trim(),
              path: get("path").trim(),
              perm: permSel.value,
              password: get("pwd"),
              writable: chk("writable"),
            }),
          });
          toast("共享已保存", "ok");
          refreshConfig();
          renderAdmin();
        } catch (e) { toast(e.message, "error"); }
      }
      });
    }
  }

  /* ---------------- 上传 ---------------- */

  function uploadFiles(files) {
    const s = state.share;
    if (!s) return;
    const listEl = $("#uploadList");
    files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "upload-item";
      row.innerHTML = '<div class="upload-name">' + esc(file.name) + "</div>" +
        '<div class="upload-bar"><div class="upload-fill"></div></div>' +
        '<div class="upload-info">等待…</div>';
      listEl.prepend(row);
      const fill = row.querySelector(".upload-fill");
      const info = row.querySelector(".upload-info");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload?share=" + encodeURIComponent(s.id) +
        "&path=" + encodeURIComponent(state.path) + "&name=" + encodeURIComponent(file.name));
      let lastLoaded = 0;
      let lastTs = Date.now();
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        const pct = Math.round((ev.loaded / ev.total) * 100);
        fill.style.width = pct + "%";
        const now = Date.now();
        const dt = Math.max((now - lastTs) / 1000, 0.05);
        const speed = (ev.loaded - lastLoaded) / dt;
        lastLoaded = ev.loaded;
        lastTs = now;
        info.textContent = pct + "% · " + fmtSize(speed) + "/s";
      };
      xhr.onload = () => {
        if (xhr.status === 200) {
          fill.style.width = "100%";
          info.textContent = "完成 ✓";
          row.classList.add("is-ok");
          Bus.emit("listing:refresh");
        } else {
          let msg = "上传失败";
          try { msg = (JSON.parse(xhr.responseText) || {}).error || msg; } catch (e) { /* 忽略 */ }
          info.textContent = msg;
          row.classList.add("is-err");
        }
        setTimeout(() => row.remove(), 3000);
      };
      xhr.onerror = () => {
        info.textContent = "网络错误，上传中断";
        row.classList.add("is-err");
        setTimeout(() => row.remove(), 3000);
      };
      const fd = new FormData();
      fd.append("file", file, file.name);
      xhr.send(fd);
    });
  }

  /* ---------------- 浏览与权限 ---------------- */

  function getShare(id) {
    return (state.config.shares || []).find((s) => s.id === id) || null;
  }

  async function openShare(shareId) {
    try {
      // 记录共享列表当前滚动位置：打开浏览后返回时不跳回顶部
      state.sharesScroll = $("#view").scrollTop || 0;
      await api("/api/list?share=" + encodeURIComponent(shareId) + "&path=/");
      state.share = getShare(shareId) || { id: shareId };
      state.path = "/";
      state.view = "shares";
      renderBrowse();
    } catch (e) {
      if (e.status === 401) {
        showPwdModal(shareId);
      } else {
        toast(e.message, "error");
      }
    }
  }

  async function navigate(shareId, path) {
    state.share = getShare(shareId) || { id: shareId };
    state.path = path || "/";
    renderBrowse();
  }

  /* ---------------- 密码弹窗 ---------------- */

  function showPwdModal(shareId) {
    state.pendingShare = shareId;
    const share = (state.config.shares || []).find((s) => s.id === shareId);
    $("#pwdDesc").textContent = share ? "共享「" + share.name + "」需要密码" : "该共享需要密码";
    $("#pwdInput").value = "";
    $("#pwdModal").hidden = false;
    setTimeout(() => $("#pwdInput").focus(), 30);
  }

  /* ---------------- 预览 ---------------- */

  function openPreview(shareId, path) {
    const name = path.split("/").pop();
    const ext = (name.split(".").pop() || "").toLowerCase();
    const src = "/api/raw?share=" + encodeURIComponent(shareId) + "&path=" + encodeURIComponent(path);
    $("#previewTitle").textContent = name;
    let inner = "";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"].includes(ext)) {
      inner = '<img src="' + src + '" alt="' + esc(name) + '">';
    } else if (["mp4", "webm", "mov", "mkv", "avi"].includes(ext)) {
      inner = '<video src="' + src + '" controls autoplay playsinline></video>';
    } else if (["mp3", "wav", "flac", "aac", "m4a", "ogg"].includes(ext)) {
      inner = '<audio src="' + src + '" controls autoplay></audio>';
    } else if (ext === "pdf") {
      inner = '<iframe src="' + src + '" style="width:100%;height:62vh;border:0;background:#fff"></iframe>';
    } else if (ext === "md" && window.marked) {
      // Markdown：渲染视图 / 原格式视图 切换（页签固定，切换只换内容不跳布局）
      inner = '<div class="pv-tabs">' +
        '<button class="pv-tab is-active" type="button" data-pv="render">渲染视图</button>' +
        '<button class="pv-tab" type="button" data-pv="raw">原格式</button></div>' +
        '<div id="pvBox" class="pv-box"></div>';
      const xhr = new XMLHttpRequest();
      xhr.open("GET", src);
      let pvMode = "render";
      const applyPv = () => {
        const box = $("#pvBox");
        const raw = (xhr.responseText || "").replace(/\r\n/g, "\n");
        if (!box) return;
        if (pvMode === "render") {
          let html = raw;
          try { html = window.marked.parse(raw); } catch (e) { html = esc(raw); }
          html = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                     .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
                     .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
                     .replace(/javascript:/gi, "");
          box.className = "pv-box pv-md";
          box.innerHTML = html;
        } else {
          box.className = "pv-box";
          box.textContent = raw;
        }
      };
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 2) {
          const len = parseInt(xhr.getResponseHeader("Content-Length") || "0", 10);
          if (len > 2 * 1024 * 1024) {
            xhr.abort();
            const box = $("#pvBox");
            if (box) box.textContent = "文件较大（" + fmtSize(len) + "），已停止渲染，请下载后查看。";
          }
        }
      };
      xhr.onload = () => {
        applyPv();
        // 页签在 #pvBox 外层（兄弟元素），监听必须挂在页签容器上，否则点击无效
        const box = $("#pvBox");
        const tabsEl = (box && box.previousElementSibling) || document.querySelector(".pv-tabs");
        if (tabsEl) {
          tabsEl.addEventListener("click", (ev) => {
            const btn = ev.target.closest("[data-pv]");
            if (!btn) return;
            pvMode = btn.dataset.pv;
            tabsEl.querySelectorAll(".pv-tab").forEach(b => b.classList.toggle("is-active", b === btn));
            applyPv();
          });
        }
      };
      xhr.onerror = () => {
        const box = $("#pvBox");
        if (box) box.textContent = "加载失败，请下载后查看。";
      };
      xhr.send();
    } else {
      // 文本类（txt/log/…）：异步加载内容，超大文件自动停止
      inner = '<pre id="txtView" style="max-width:100%;max-height:62vh;overflow:auto;padding:14px;white-space:pre-wrap;font:12px/1.5 var(--mono)">加载中…</pre>';
      const xhr = new XMLHttpRequest();
      xhr.open("GET", src);
      xhr.onreadystatechange = () => {
        if (xhr.readyState === 2) {
          const len = parseInt(xhr.getResponseHeader("Content-Length") || "0", 10);
          if (len > 2 * 1024 * 1024) {
            xhr.abort();
            const t = $("#txtView");
            if (t) t.textContent = "文件较大（" + fmtSize(len) + "），已停止加载，请下载后查看。";
          }
        }
      };
      xhr.onload = () => {
        const t = $("#txtView");
        if (t) t.textContent = xhr.responseText || "";
      };
      xhr.onerror = () => {
        const t = $("#txtView");
        if (t) t.textContent = "加载失败，请下载后查看。";
      };
      xhr.send();
    }
    $("#previewBody").innerHTML = inner;
    $("#previewModal").hidden = false;
  }

  /* ---------------- 文件夹选择器 ---------------- */

  async function openPicker(targetId) {
    state.pickTarget = targetId || "fPath";
    state.pickPath = "";
    $("#pickModal").hidden = false;
    await loadPicker("");
  }

  async function loadPicker(path) {
    state.pickPath = path || "";
    $("#pickPath").textContent = path || "（磁盘根目录）";
    try {
      const data = await api("/api/browse?path=" + encodeURIComponent(path || ""));
      let html = "";
      if (data.parent && data.parent !== data.current) {
        html += '<div class="pick-item" data-path="' + esc(data.parent) + '">' + I.up + "<span>返回上级</span></div>";
      }
      for (const e of data.entries) {
        html += '<div class="pick-item" data-path="' + esc(e.path) + '">' + I.drive + "<span>" + esc(e.name) + "</span></div>";
      }
      $("#pickList").innerHTML = html || '<div class="empty" style="padding:20px">无子文件夹</div>';
      const use = $("#pickUse");
      use.disabled = !path;
      use.onclick = () => {
        const t = $("#" + state.pickTarget);
        if (t) t.value = state.pickPath;
        $("#pickModal").hidden = true;
      };
      document.querySelectorAll("#pickList .pick-item").forEach((el) => {
        el.addEventListener("click", () => loadPicker(el.dataset.path));
      });
    } catch (e) {
      $("#pickList").innerHTML = '<div class="empty" style="padding:20px">' + esc(e.message) + "</div>";
    }
  }

  /* ---------------- 二维码 ---------------- */

  function openQR() {
    const host = location.protocol + "//" + location.host + "/";
    $("#qrHint").textContent = host;
    const box = $("#qrCanvas");
    box.innerHTML = "";
    if (window.QRCode) {
      try {
        new QRCode(box, { text: host, width: 240, height: 240, correctLevel: QRCode.CorrectLevel.M });
      } catch (e) {
        box.innerHTML = '<div style="color:#333;padding:8px;font-size:13px">二维码生成失败</div>';
      }
    } else {
      box.innerHTML = '<div style="color:#333;padding:8px;font-size:13px">请手动输入地址：' + esc(host) + "</div>";
    }
    $("#qrModal").hidden = false;
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindUI() {
    // 标签页切换
    $("#tabs").addEventListener("click", (ev) => {
      const tab = ev.target.closest(".tab");
      if (!tab) return;
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      const prev = state.view;
      state.view = tab.dataset.view;
      if (state.view === "shares") {
        // 从「共享浏览页」再点「共享文件夹」→ 回共享列表；从其他页切回 → 保持浏览位置
        if (prev === "shares" && state.share) {
          state.share = null;
          state.path = "/";
        }
      } else if (state.view === "peers") {
        refreshPeers();
      } else if (state.view === "dlcenter") {
        loadLocalDownloads();
      }
      render();
      updateDlBadge();
    });

    // 共享卡片动作（事件委托）
    $("#view").addEventListener("click", (ev) => {
      const card = ev.target.closest("[data-share]");
      if (!card) return;
      const act = ev.target.closest("[data-act]");
      if (!act) return;
      const id = card.dataset.share;
      if (act.dataset.act === "open") {
        openShare(id);
      } else if (act.dataset.act === "copy") {
        const url = location.origin + "/?share=" + encodeURIComponent(id);
        copyTextToClipboard(url).then(
          () => toast("链接已复制", "ok"),
          () => toast("复制失败，请手动复制地址栏", "error"));
      }
    });

    // 二维码
    $("#qrBtn").addEventListener("click", openQR);

    // 弹窗关闭（委托）
    document.querySelectorAll(".modal").forEach((m) => {
      m.addEventListener("click", (ev) => {
        if (ev.target === m || ev.target.closest("[data-close]")) {
          m.hidden = true;
          if (m.id === "previewModal") $("#previewBody").innerHTML = "";
        }
      });
    });

    // 密码表单
    $("#pwdForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = state.pendingShare;
      const pwd = $("#pwdInput").value;
      const btn = ev.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await api("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ share_id: id, password: pwd }),
        });
        state.authed.add(id);
        $("#pwdModal").hidden = true;
        toast("已解锁", "ok");
        openShare(id);
      } catch (e) {
        toast(e.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  /* ---------------- 深链接 ---------------- */

  function handleDeepLink() {
    const q = new URLSearchParams(location.search);
    const share = q.get("share");
    const path = q.get("path") || "/";
    if (share) {
      Bus.once("config:loaded", () => {
        const s = (state.config.shares || []).find((x) => x.id === share);
        if (s) {
          state.view = "shares";
          openShare(share).then(() => {
            if (path !== "/") navigate(share, path);
          });
        }
      });
    }
  }

  /* ---------------- 桌面版桥接 ---------------- */

  function initDesktopBridge() {
    if (!window.LANSHARE_DESKTOP || !window.QWebChannel || !qt || !qt.webChannelTransport) return;
    try {
      new QWebChannel(qt.webChannelTransport, (channel) => {
        window.native = channel.objects.bridge;
        Bus.emit("native:ready");
        startPyDlPoll();   // 传输队列轮询（断点续传/暂停/继续/重试）
        updateBackHome();
      });
    } catch (e) {
      console.error("桌面桥初始化失败", e);
    }
  }

  function updateBackHome() {
    let chip = $("#backHome");
    if (!chip) {
      chip = document.createElement("button");
      chip.id = "backHome";
      chip.className = "back-home btn btn-primary";
      chip.innerHTML = I.back + "返回本机";
      chip.addEventListener("click", () => { if (window.native) window.native.goHome(); });
      document.body.appendChild(chip);
    }
    const local = window.LANSHARE_LOCAL_ORIGIN ? window.LANSHARE_LOCAL_ORIGIN : null;
    const away = window.native && local && location.origin !== new URL(local).origin;
    chip.hidden = !away;
  }

  /* ---------------- 启动 ---------------- */

  Bus.on("config:loaded", (cfg) => {
    renderHeader(cfg);
    renderNetStatus();
    // 若当前浏览的共享已被删除，退回共享列表
    if (state.share && cfg.shares && !cfg.shares.some((s) => s.id === state.share.id)) {
      state.share = null;
      state.path = "/";
    }
    render();
  });
  Bus.on("peers:loaded", (peers) => {
    $("#peerCount").textContent = peers.length ? String(peers.length) : "";
    renderNetStatus();
    if (state.view === "peers") renderPeers();
  });
  Bus.on("listing:refresh", () => {
    if (state.view === "shares" && state.share) loadListing();
  });
  Bus.on("native:toast", (msg) => {
    if (msg) toast(msg, "ok");
  });

  /* ---------------- 网络状态自检 ---------------- */

  function _isLanIp(ip) {
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
    const a = ip.split(".").map(Number);
    if (a[0] === 10) return true;                                   // 10.0.0.0/8
    if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;      // 172.16-31/12
    if (a[0] === 192 && a[1] === 168) return true;                  // 192.168/16
    return false;
  }

  function computeNetStatus() {
    const cfg = state.config;
    const ips = (cfg && cfg.addresses) || [];
    const v4 = ips.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    const lan = v4.filter(_isLanIp);
    const apipa = v4.filter((ip) => ip.indexOf("169.254.") === 0);
    const peers = (state.peers || []).length;
    let level = "ok", text = "";
    if (!v4.length || (v4.length > 0 && v4.length === apipa.length)) {
      level = "bad"; text = "网络未连接";
    } else if (peers > 0) {
      level = "ok"; text = "正常 · " + peers + " 台设备";
    } else if (lan.length > 0) {
      level = "warn"; text = "未发现设备";
    } else {
      level = "warn"; text = "非局域网 IP";
    }
    return { level: level, text: text, v4: v4, lan: lan, apipa: apipa, peers: peers };
  }

  function renderNetStatus() {
    const btn = $("#netStatusBtn");
    if (!btn) return;
    const st = computeNetStatus();
    btn.hidden = false;
    btn.innerHTML = '<span class="net-dot ' + st.level + '"></span><span class="net-text">' + esc(st.text) + "</span>";
    btn.title = "网络状态：" + st.text + "，点击查看排查指引";
  }

  function openNetPanel() {
    const st = computeNetStatus();
    const items = [];
    if (!st.v4.length) {
      items.push({ ok: false, title: "本机未获取到 IP 地址", tip: "请检查网线是否插好、WiFi 是否已连接。连上后状态会自动更新。" });
    } else if (st.apipa.length && st.v4.length === st.apipa.length) {
      items.push({ ok: false, title: "IP 为 169.254.x（未分配到有效地址）", tip: "说明路由器没有给电脑分配 IP。重启路由器或重连网络，状态会自动更新。" });
    } else {
      items.push({ ok: true, title: "本机 IP 是局域网地址", tip: "同一网段内的设备可直接互访。" });
      if (!st.lan.length) {
        items.push({ ok: false, title: "没有局域网 IP（192.168.x / 10.x / 172.16-31.x）", tip: "当前 IP 可能来自 VPN、手机热点或公网。若两台电脑网段不一致（如一台 192.168.1.x、一台 10.x），先让它们连同一个路由器 / WiFi。" });
      }
    }
    if (st.peers > 0) {
      items.push({ ok: true, title: "已发现 " + st.peers + " 台设备", tip: "网络正常，可直接共享与下载。" });
    } else {
      items.push({ ok: false, title: "没有发现任何设备", tip: "依次确认：① 对方也开着本软件；② 两台电脑连同一个 WiFi / 路由器；③ Windows 防火墙已放行（设置→网络和 Internet→当前网络设为「专用」；Windows 安全中心→防火墙→允许应用通过防火墙→勾选「局域网快传」的专用+公用）；④ 若是公司网络，可能被隔离——用手机热点或家用路由器验证。" });
    }
    let html = '<div class="net-summary">当前状态：<span class="net-dot ' + st.level + '"></span>' + esc(st.text) + "</div>";
    html += '<div class="net-ips"><div class="net-ips-title">本机 IP（与对方比对是否同网段）</div><div class="net-ips-list">' +
      (st.v4.length ? st.v4.map((ip) => "<code>" + esc(ip) + "</code>").join("") : '<span class="dim">无</span>') +
      "</div></div>";
    html += '<div class="net-items">';
    for (const it of items) {
      html += '<div class="net-item"><span class="net-ok">' + (it.ok ? "ok" : "bad") + "</span>" +
        '<div class="net-item-main"><div class="net-item-title">' + esc(it.title) + "</div>" +
        '<div class="net-item-tip">' + esc(it.tip) + "</div></div></div>";
    }
    html += "</div>";
    $("#netBody").innerHTML = html;
    $("#netModal").hidden = false;
  }

  function bindNetStatus() {
    const btn = $("#netStatusBtn");
    if (!btn) return;
    btn.addEventListener("click", openNetPanel);
    renderNetStatus();
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === "light") {
      root.dataset.theme = "light";
      const sun = document.querySelector(".icon-sun");
      const moon = document.querySelector(".icon-moon");
      if (sun) sun.hidden = false;
      if (moon) moon.hidden = true;
    } else {
      delete root.dataset.theme;
      const sun = document.querySelector(".icon-sun");
      const moon = document.querySelector(".icon-moon");
      if (sun) sun.hidden = true;
      if (moon) moon.hidden = false;
    }
  }

  function bindTheme() {
    const btn = $("#themeBtn");
    if (!btn) return;
    // 先按 localStorage 快速应用（避免闪默认色）；config 加载后以 config.json 为准（持久化，跟随文件夹迁移）
    let cur = localStorage.getItem("lanshare_theme") || "dark";
    applyTheme(cur);
    Bus.on("config:loaded", (cfg) => {
      if (cfg && cfg.theme && cfg.theme !== cur) {
        cur = cfg.theme;
        localStorage.setItem("lanshare_theme", cur);
        applyTheme(cur);
      }
    });
    btn.addEventListener("click", () => {
      cur = cur === "dark" ? "light" : "dark";
      localStorage.setItem("lanshare_theme", cur);
      applyTheme(cur);
      try {
        api("/api/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theme: cur }),
        });
      } catch (e) { /* 保存失败不影响本次切换 */ }
    });
  }

  function init() {
    bindTheme();
    bindNetStatus();
    bindUI();
    connectSSE();
    initDesktopBridge();
    handleDeepLink();
    refreshConfig();
    refreshPeers();
    // 右键菜单全局关闭：点击/右键/滚动在菜单外时收起（菜单内事件不关，避免连点不弹）
    document.addEventListener("click", (ev) => {
      if (_ctxMenu && !_ctxMenu.contains(ev.target)) closeCtxMenu();
    });
    document.addEventListener("contextmenu", (ev) => {
      if (_ctxMenu && !_ctxMenu.contains(ev.target)) closeCtxMenu();
    });
    document.addEventListener("scroll", () => closeCtxMenu(), true);
  }

  document.addEventListener("DOMContentLoaded", init);
})();

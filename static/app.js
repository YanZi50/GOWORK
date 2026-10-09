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
        if (bar && cur.total > 0) {
          bar.style.width = Math.min(100, Math.round(cur.received / cur.total * 100)) + "%";
          if (pct) pct.textContent = Math.round(cur.received / cur.total * 100) + "%";
        }
      }
    } else if (p.type === "done") {
      delete state.dlRunning[p.id];
      loadLocalDownloads();   // 从桌面端拉最新历史（已完成列表刷新）
    }
    updateDlBadge();
  };

  // ---- 本机下载接管：/api/dlcopy 后台复制 + SSE 进度 -> 按钮圆圈进度条 ----
  function dlCopyEnabled() {
    return !!(state.config && state.config.is_local &&
      state.config.download_dir && window.native);
  }

  function startDlCopy(shareId, path, btn, isDir) {
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
      setTimeout(() => resetDlBtn(btn, p.task), 1200);
      loadLocalDownloads();
    } else if (p.type === "error") {
      resetDlBtn(btn, p.task);
      delete state.dlRunning[p.task];
      delete state.dlCopy[p.task];
      updateDlBadge();
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
    btn.innerHTML = restore || (I.download + '<span class="btn-label">下载</span>');
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

  function loadLocalDownloads() {
    if (!window.native) return;
    window.native.getLocalDownloads(function (json) {
      try {
        state.dlHistory = JSON.parse(json || "[]");
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
      '<button class="dlc-tab' + (!active ? " is-active" : "") + '" data-dlc="done" type="button">已完成（' + done.length + '）</button>' +
      (!active ? '<button class="btn btn-ghost btn-sm" type="button" id="dlcClear">清空全部记录</button>' : "") + "</div>" +
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
    });
  }

  function dlcRunningHtml(running) {
    if (!running.length) return '<div class="empty">没有正在下载的任务</div>';
    let html = "";
    for (const it of running) {
      const pct = it.total > 0 ? Math.round(it.received / it.total * 100) : 0;
      html += '<div class="dlc-row dlc-running" data-dlr="' + esc(it.id) + '">' +
        '<span class="row-icon">' + I.download + "</span>" +
        '<div class="dlc-main"><div class="dlc-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div>" +
        '<div class="dlc-bar"><div class="dlc-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="dlc-sub"><span class="dlc-pct">' + pct + "%</span>" +
        (it.total > 0 ? '<span>' + fmtSize(it.received) + " / " + fmtSize(it.total) + "</span>" : "") +
        '<span class="dlc-dir" title="' + esc(it.dir) + '">' + esc(it.dir) + "</span></div></div></div>";
    }
    return html;
  }

  function dlcDoneHtml(done) {
    if (!done.length) return '<div class="empty">还没有下载完成记录</div>';
    let html = '<div class="dlc-row dlc-head"><span></span><span>文件</span><span>大小</span><span>完成时间</span><span>保存位置</span><span></span></div>';
    for (const it of done) {
      // dir 有值 = 可跳转（软件窗口内下载：真实路径；外部浏览器下载：定位到的浏览器下载目录/文件）
      const hasLoc = !!it.dir;
      const locTitle = hasLoc
        ? (it.path ? "打开所在文件夹（已定位到文件）" : "打开浏览器下载目录")
        : "未能定位下载位置（浏览器下载目录不在默认位置，可在浏览器设置里查看）";
      html += '<div class="dlc-row dlc-done">' +
        '<span class="row-icon">' + fileIcon(it.name) + "</span>" +
        '<div class="dlc-main"><div class="dlc-name" title="' + esc(it.name) + '">' + esc(it.name) + "</div></div>" +
        '<span class="dlc-cell">' + (it.size ? fmtSize(it.size) : "--") + "</span>" +
        '<span class="dlc-cell">' + fmtTime(it.ts) + "</span>" +
        '<span class="dlc-pos" title="' + locTitle + '">' +
        (hasLoc
          ? '<button class="btn btn-ghost btn-sm btn-dloc" type="button" data-dlr-open="' + esc(it.dir) + '" data-dlr-path="' + esc(it.path || "") + '" title="' + locTitle + '">' + I.folder + "</button>"
          : '<span class="dlc-unknown">未定位</span>') +
        "</span>" +
        '<button class="btn btn-ghost btn-sm" type="button" data-dlr-rm="' + esc(it.key) + '" title="清除这条记录">' + I.trash + "</button></div>";
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

  function renderShares() {
    const cfg = state.config;
    const shares = cfg.shares || [];
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
        html += '<div class="file-row' + (isDir ? " is-dir" : "") + '" data-dir="' + (isDir ? "1" : "0") + '" data-path="' + esc(filePath) + '">' +
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
                if (dlCopyEnabled()) startDlCopy(s.id, path, btn, false);
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
      '<div class="section-sub">点击「编辑」展开修改设置</div></div></div>' +
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
      const limit = 20;
      const showAll = !!state.dlShowAll;
      const shown = showAll ? items : items.slice(0, limit);
      let html = '<div class="dl-row dl-head"><span class="dl-name">文件</span><span>共享</span><span>下载者</span><span>次数</span><span>最近下载</span></div>';
      for (const d of shown) {
        const peerName = d.peer && d.peer !== d.ip ? d.peer : "未知设备";
        html += '<div class="dl-row">' +
          '<span class="dl-name" title="' + esc(d.path) + '">' + esc(d.name) + "</span>" +
          '<span>' + esc(d.share_name) + "</span>" +
          '<span>' + esc(peerName) + '<span class="dl-ip">（' + esc(d.ip) + '）</span></span>' +
          '<span>' + d.count + "</span>" +
          '<span>' + fmtTime(d.last_ts) + "</span></div>";
      }
      html += '<div class="dl-foot">';
      if (items.length > limit) {
        html += '<button class="btn btn-ghost btn-sm" type="button" data-dl-more>' +
          (showAll ? "收起" : "显示全部（共 " + items.length + " 条）") + "</button>";
      }
      html += '<button class="btn btn-danger btn-sm" type="button" data-dl-clear>清空记录</button></div>';
      el.innerHTML = html;
      const more = el.querySelector("[data-dl-more]");
      if (more) more.addEventListener("click", () => {
        state.dlShowAll = !state.dlShowAll;
        renderDlList();
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
    const shares = state.config.shares || [];
    if (!shares.length) {
      listEl.innerHTML = '<div class="empty" style="padding:24px">尚未配置共享 — 点上方「添加共享文件夹」</div>';
      return;
    }
    let html = "";
    for (const s of shares) {
      const badge = s.perm === "public"
        ? '<span class="badge badge-public">公开</span>'
        : s.perm === "password"
          ? '<span class="badge badge-password">' + I.lock + '密码</span>'
          : '<span class="badge badge-private">仅自己</span>';
      const writeBadge = s.writable ? '<span class="badge badge-write">可上传</span>' : "";
      html += '<div class="ac-card" data-id="' + esc(s.id) + '">' +
        '<div class="ac-head" data-toggle role="button" tabindex="0">' +
        '<span class="share-icon">' + I.folder + "</span>" +
        '<div class="ac-main"><div class="ac-name">' + esc(s.name) + " " + badge + writeBadge + "</div>" +
        '<div class="ac-sub">' + esc(s.path || "") + "</div></div>" +
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
    listEl.innerHTML = html;

    // 展开/收起 + 删除 + 保存（事件委托）
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
        const box = $("#pvBox");
        if (box) box.addEventListener("click", (ev) => {
          const btn = ev.target.closest("[data-pv]");
          if (!btn || !box) return;
          pvMode = btn.dataset.pv;
          document.querySelectorAll("#pvBox + .pv-tabs .pv-tab, .pv-tabs .pv-tab").forEach(b => b.classList.toggle("is-active", b === btn));
          applyPv();
        });
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
    // 若当前浏览的共享已被删除，退回共享列表
    if (state.share && cfg.shares && !cfg.shares.some((s) => s.id === state.share.id)) {
      state.share = null;
      state.path = "/";
    }
    render();
  });
  Bus.on("peers:loaded", (peers) => {
    $("#peerCount").textContent = peers.length ? String(peers.length) : "";
    if (state.view === "peers") renderPeers();
  });
  Bus.on("listing:refresh", () => {
    if (state.view === "shares" && state.share) loadListing();
  });
  Bus.on("native:toast", (msg) => {
    if (msg) toast(msg, "ok");
  });

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
    let cur = localStorage.getItem("lanshare_theme") || "dark";
    applyTheme(cur);
    btn.addEventListener("click", () => {
      cur = cur === "dark" ? "light" : "dark";
      localStorage.setItem("lanshare_theme", cur);
      applyTheme(cur);
    });
  }

  function init() {
    bindTheme();
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

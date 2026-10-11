// ==UserScript==
// @name         HH3D | Auto Câu Cá Tiên Giới
// @namespace    hh3d-tien-gioi-fishing
// @version      0.4.3
// @description  Tự ném, giật, cân cá và bán cá ★1–2. Chạy được trên Violentmonkey/Tampermonkey (Firefox/Chrome, PC & Android).
// @author       HH3D Tool
// @match        *://hoathinh3d.you/game*
// @match        *://hoathinh3d.de/game*
// @include      *://hoathinh3d.*/game*
// @include      *://*.hoathinh3d.*/game*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function hh3dBoot() {
  // main() PHẢI chạy trong realm của trang thì mới hook được addEventListener của game.
  // Phần "bootstrap" ở cuối file tự nạp main() vào trang nếu Violentmonkey/Firefox
  // đang chạy script trong sandbox content-script (Xray).
  function main(isInjected, how) {
  'use strict';

  const PAGE = window;
  const DOC = PAGE.document;
  const VERSION = '0.4.3';
  const HOW = how || 'direct';
  let WRAPPED;
  try { WRAPPED = window.wrappedJSObject; } catch (_) {}
  const INSTALL = { t: Math.round(performance.now()), rs: DOC.readyState };

  // Chống nạp trùng (SPA có thể inject lại script).
  if (PAGE.__HH3D_FISH_ACTIVE__) return;
  try {
    Object.defineProperty(PAGE, '__HH3D_FISH_ACTIVE__', { value: VERSION, configurable: true });
  } catch (_) { PAGE.__HH3D_FISH_ACTIVE__ = VERSION; }

  const ROOT_ID = 'hh3d-fishing-tool-root';
  const STORE_KEY = 'hh3d_fish_cfg_v043';
  const SYNTH_BASE = 1000000; // pointerId giả luôn >= số này để không đụng pointer thật

  const TRACKED = new Set([
    'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'pointerleave',
    'touchstart', 'touchmove', 'touchend', 'mousedown', 'mouseup', 'click'
  ]);

  /* ------------------------------------------------------------------ *
   * 1) Hook trang: ghi lại listener pointer của game + shim pointer-capture
   *    - Realm "page": gán thẳng lên prototype.
   *    - Firefox content-script (Violentmonkey/Android): dùng wrappedJSObject + exportFunction,
   *      nên KHÔNG cần chèn <script> và không bị CSP của trang chặn.
   * ------------------------------------------------------------------ */
  const CONTENT = !!WRAPPED && !isInjected;
  const W = CONTENT ? WRAPPED : window;            // "window của trang" để patch
  const CAN_EXPORT = CONTENT && typeof exportFunction === 'function' && typeof cloneInto === 'function';
  const HOOKABLE = !CONTENT || CAN_EXPORT;
  const REALM = isInjected ? 'page (tự nạp vào trang)'
    : (CONTENT ? (CAN_EXPORT ? 'content-script + exportFunction' : 'content-script (KHÔNG hook được)') : 'page');

  function patchMethod(proto, name, makeWrapper) {
    try {
      const orig = proto[name];
      if (typeof orig !== 'function') return null;
      const wrapper = makeWrapper(orig);
      proto[name] = CONTENT ? exportFunction(wrapper, W) : wrapper;
      return orig;
    } catch (_) { return null; }
  }
  function restoreMethod(proto, name, orig) {
    try { if (orig) proto[name] = orig; } catch (_) {}
  }

  const STORE = new WeakMap();   // target -> { type: [entry] }
  const ALL = [];                // dự phòng khi identity của wrapper (Xray) không khớp
  const bridge = {
    ok: false, reason: '', total: 0, seen: Object.create(null),
    mode: CONTENT ? (CAN_EXPORT ? 'content+exportFunction' : 'content (không export được)') : 'page'
  };

  const isCaptureOpt = (o) => (typeof o === 'boolean' ? o : !!(o && o.capture));

  function recordListener(target, type, listener, options) {
    if (!target || (typeof target !== 'object' && typeof target !== 'function')) return;
    let store = STORE.get(target);
    if (!store) { store = Object.create(null); STORE.set(target, store); }
    const arr = store[type] || (store[type] = []);
    const capture = isCaptureOpt(options);
    if (arr.some(x => x.listener === listener && x.capture === capture)) return;
    const entry = { listener, options, capture, once: !!(options && typeof options === 'object' && options.once) };
    arr.push(entry);
    if (CONTENT && ALL.length < 4000) {
      let isWin = false, isDoc = false, isNode = false;
      try { isWin = target.window === target; isDoc = target.nodeType === 9; isNode = target.nodeType === 1; } catch (_) {}
      ALL.push({ target, type, entry, isWin, isDoc, isNode });
    }
  }

  function forgetListener(target, type, listener, options) {
    const store = STORE.get(target);
    const arr = store && store[type];
    if (!arr) return;
    const capture = isCaptureOpt(options);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].listener === listener && arr[i].capture === capture) arr.splice(i, 1);
    }
  }

  function installInputBridge() {
    if (!HOOKABLE) { bridge.reason = 'Firefox content-script không có exportFunction/cloneInto'; return bridge; }
    const proto = W.EventTarget && W.EventTarget.prototype;
    if (!proto) { bridge.reason = 'không có EventTarget'; return bridge; }

    const added = patchMethod(proto, 'addEventListener', (orig) => function (type, listener, options) {
      if (listener && TRACKED.has(type)) {
        try {
          const own = this && this.nodeType === 1 && typeof this.closest === 'function' && this.closest('#' + ROOT_ID);
          if (!own) { bridge.total++; bridge.seen[type] = (bridge.seen[type] || 0) + 1; }
        } catch (_) {}
        try { recordListener(this, type, listener, options); } catch (_) {}
      }
      return Reflect.apply(orig, this, arguments);
    });
    patchMethod(proto, 'removeEventListener', (orig) => function (type, listener, options) {
      if (listener && TRACKED.has(type)) { try { forgetListener(this, type, listener, options); } catch (_) {} }
      return Reflect.apply(orig, this, arguments);
    });
    bridge.ok = !!added;
    if (!added) bridge.reason = 'không patch được addEventListener';
    return bridge;
  }

  // pointerId giả làm setPointerCapture() ném NotFoundError → nuốt lỗi đó (chỉ với id giả).
  function installCaptureShim() {
    if (!HOOKABLE) return false;
    const proto = W.Element && W.Element.prototype;
    if (!proto) return false;
    for (const name of ['setPointerCapture', 'releasePointerCapture']) {
      patchMethod(proto, name, (orig) => function (id) {
        try { return Reflect.apply(orig, this, arguments); } catch (e) {
          if (typeof id === 'number' && id >= SYNTH_BASE) return undefined;
          throw e;
        }
      });
    }
    return true;
  }

  const INPUT_BRIDGE = installInputBridge();
  installCaptureShim();

  /* ------------------------------------------------------------------ *
   * 2) Probe Canvas2D: đọc vị trí cá / vùng cam khi game vẽ thanh kéo cá.
   *    Chỉ được gắn vào prototype trong lúc kéo cá (setProbeActive) để không làm chậm game.
   * ------------------------------------------------------------------ */
  const DRAW_PROBE = { supported: false, installed: false, active: false, last: null, zone: null, fish: null };
  const drawOrig = {};
  const drawPaths = new WeakMap();
  let drawProto = null;
  try { drawProto = (HOOKABLE && W.CanvasRenderingContext2D) ? W.CanvasRenderingContext2D.prototype : null; } catch (_) {}
  DRAW_PROBE.supported = !!drawProto;

  function drawAdd(ctx, x, y) {
    const path = drawPaths.get(ctx);
    if (!path) return;
    const m = ctx.getTransform();
    const px = m.a * x + m.c * y + m.e;
    const py = m.b * x + m.d * y + m.f;
    if (Number.isFinite(px) && Number.isFinite(py)) {
      path.minX = Math.min(path.minX, px); path.maxX = Math.max(path.maxX, px);
      path.minY = Math.min(path.minY, py); path.maxY = Math.max(path.maxY, py);
    }
  }

  function patchDraw() {
    if (!drawProto || DRAW_PROBE.installed) return;
    const probe = DRAW_PROBE;
    const wrappers = {
      beginPath: (orig) => function () {
        drawPaths.set(this, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, fish: null });
        return Reflect.apply(orig, this, arguments);
      },
      moveTo: (orig) => function (x, y) {
        try { drawAdd(this, x, y); } catch (_) {}
        return Reflect.apply(orig, this, arguments);
      },
      arcTo: (orig) => function (x1, y1, x2, y2) {
        try { drawAdd(this, x1, y1); drawAdd(this, x2, y2); } catch (_) {}
        return Reflect.apply(orig, this, arguments);
      },
      ellipse: (orig) => function (x, y, rx, ry) {
        // Dấu vân tay icon cá trong mã nguồn game: ellipse(-2, 0, 8.5, 5.2)
        try {
          if (Math.abs(x + 2) < .01 && Math.abs(y) < .01 && Math.abs(rx - 8.5) < .01 && Math.abs(ry - 5.2) < .01) {
            const m = this.getTransform();
            const path = drawPaths.get(this);
            if (path) path.fish = { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
          }
        } catch (_) {}
        return Reflect.apply(orig, this, arguments);
      },
      fill: (orig) => function () {
        try {
          const path = drawPaths.get(this);
          if (path) {
            const color = typeof this.fillStyle === 'string' ? this.fillStyle.toLowerCase() : '';
            const now = performance.now();
            const h = path.maxY - path.minY, w = path.maxX - path.minX;
            if ((color === '#f2b04a' || color === '#78ffc8') && h >= 8 && h < 550 && w >= 8 && w < 120) {
              probe.zone = { x: (path.minX + path.maxX) / 2, y: (path.minY + path.maxY) / 2, height: h, at: now, canvas: this.canvas };
            }
            if (path.fish && (color === '#fff' || color === '#ffffff' || color === 'white')) {
              probe.fish = { x: path.fish.x, y: path.fish.y, at: now, canvas: this.canvas };
            }
            if (probe.zone && probe.fish && probe.zone.canvas === probe.fish.canvas &&
                Math.abs(probe.zone.at - probe.fish.at) < 75 && Math.abs(probe.zone.x - probe.fish.x) < 45) {
              probe.last = { fishY: probe.fish.y, zoneY: probe.zone.y, zoneHeight: probe.zone.height, at: now };
            }
          }
        } catch (_) {}
        return Reflect.apply(orig, this, arguments);
      }
    };
    for (const name of Object.keys(wrappers)) {
      const orig = patchMethod(drawProto, name, wrappers[name]);
      if (orig) drawOrig[name] = orig;
    }
    DRAW_PROBE.installed = true;
  }

  function unpatchDraw() {
    if (!drawProto || !DRAW_PROBE.installed) return;
    for (const name of Object.keys(drawOrig)) restoreMethod(drawProto, name, drawOrig[name]);
    DRAW_PROBE.installed = false;
  }

  function setProbeActive(on) {
    on = !!on;
    if (DRAW_PROBE.active === on) return;
    DRAW_PROBE.active = on;
    if (on) patchDraw(); else unpatchDraw();
  }

  /* ------------------------------------------------------------------ *
   * 3) Cấu hình + trạng thái
   * ------------------------------------------------------------------ */
  const CFG = {
    capacity: 24,
    sellMargin: 2,              // bán khi giỏ còn <= 2 chỗ trống (22/24)
    pollMs: 90,
    actionCooldownMs: 1100,
    afterCatchCooldownMs: 2800,
    waitBiteTimeoutMs: 120000,
    reelTimeoutMs: 60000,
    tapXPercent: 50,            // mặc định: giữa hồ (có thể chỉnh / bấm 🎯 Chọn điểm)
    tapYPercent: 56,
    castHoldDurationMs: 180,
    castMoveSteps: 6,
    castVerifyMs: 4500,         // sau khi ném, game phải rời trạng thái "idle" trong thời gian này
    reelDeadbandMin: 0.016,
    reelDeadbandMax: 0.042,
    reelPredictionSec: 0.12,
    hookDebounceMs: 220,
    maxCastRetry: 5,
    castTapHoldMs: 70,
    noSellCooldownMs: 90000,
    blindSellEvery: 10          // nếu không đọc được số cá trong giỏ: bán ★1–2 sau mỗi N lần kéo cá
  };

  let root = null, panel = null, statusEl = null, logEl = null, statsEl = null;
  let tapXSlider = null, tapYSlider = null, tapXVal = null, tapYVal = null;
  let holdMsInput = null, blindInput = null, modeSelect = null, castSelect = null;

  let running = false;
  let autoSell = true;
  let cfgMode = 'auto';       // 'auto' | 'direct' | 'dispatch'
  let autoMode = null;        // chế độ đang dùng khi cfgMode = auto
  let forcedMode = null;      // dùng cho nút "Thử ném"
  let loopHandle = null;
  let loopBusy = false;
  let lastState = 'unknown';
  let stateSince = 0;
  let lastActionAt = 0;
  let cooldownUntil = 0;
  let noSellUntil = 0;
  let sinceSell = 0;
  let castRetryCount = 0;
  let castPending = null;
  let interfaceMisses = 0;
  let reelHeld = false;
  let reelMode = null;
  let reelStartedAt = 0;
  let lastHookAt = 0;
  let hookAttempts = 0;
  let hookTried = null;       // kiểu giật của lần thử gần nhất
  let hookLog = [];
  let hookGood = null;        // kiểu giật đã từng thành công
  let handlerAll = false;     // true: gọi MỌI handler trên nút thay vì chỉ handler điểm cao nhất
  let cfgCast = 'auto';       // 'auto' | 'tap' | 'drag'
  let autoCast = null;
  let castComboIdx = 0;       // chỉ số cách ném (kiểu/chế độ) đang dùng trong castCombos()
  let forcedCombo = null;     // dùng cho nút "Thử ném"
  let hookPref = 0;           // bước giật từng thành công gần nhất (thử trước)
  let forcedCast = null;
  let lastGoodCast = '';
  let biteObs = null, observedBtn = null;
  let bagFlow = null;
  let logLines = [];
  let nextPid = SYNTH_BASE;
  let activePointerId = null;
  let gaugePrev = null;
  let gaugeVel = { fish: 0, zone: 0 };
  let gaugeMisses = 0;
  let lastCanvasGauge = null;
  let lastCanvasScan = 0;
  let staminaLast = null;
  let staminaTrend = null;
  let wakeLock = null;
  let testBusy = false;
  const stats = { casts: 0, hooks: 0, reels: 0, sold: 0 };

  const normalize = (s) => String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .replace(/\u00A0/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const newPid = () => ++nextPid;

  async function waitFor(fn, timeoutMs, stepMs = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { if (fn()) return true; } catch (_) {}
      await sleep(stepMs);
    }
    try { return !!fn(); } catch (_) { return false; }
  }

  /* ---- lưu / nạp cài đặt ---- */
  function loadSaved() {
    try {
      const raw = PAGE.localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  function saveCfg() {
    try {
      PAGE.localStorage.setItem(STORE_KEY, JSON.stringify({
        tapX: Number(tapXSlider && tapXSlider.value),
        tapY: Number(tapYSlider && tapYSlider.value),
        holdMs: Number(holdMsInput && holdMsInput.value),
        blindN: Number(blindInput && blindInput.value),
        autoSell,
        mode: cfgMode,
        cast: cfgCast
      }));
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 4) Giao diện
   * ------------------------------------------------------------------ */
  function initUI() {
    if (!DOC.body || DOC.getElementById(ROOT_ID)) return;
    const saved = loadSaved();
    const tapX = clamp(Number(saved.tapX) || CFG.tapXPercent, 5, 95);
    const tapY = clamp(Number(saved.tapY) || CFG.tapYPercent, 5, 95);
    const holdMs = clamp(Number(saved.holdMs) || CFG.castHoldDurationMs, 20, 2000);
    const blindN = (saved.blindN === undefined || !Number.isFinite(Number(saved.blindN))) ? CFG.blindSellEvery : clamp(Math.round(Number(saved.blindN)), 0, 50);
    if (typeof saved.autoSell === 'boolean') autoSell = saved.autoSell;
    if (['auto', 'direct', 'dispatch'].includes(saved.mode)) cfgMode = saved.mode;
    if (['auto', 'tap', 'drag'].includes(saved.cast)) cfgCast = saved.cast;

    root = DOC.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <style>
        #${ROOT_ID} { position:fixed !important; z-index:2147483647 !important; isolation:isolate; pointer-events:auto; right:9px; top:88px; width:min(322px, calc(100vw - 18px)); color:#f5f2ff; font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; touch-action:manipulation; }
        #${ROOT_ID} * { box-sizing:border-box; }
        #${ROOT_ID} .fish-fab { display:block; margin-left:auto; border:1px solid #5bcaaf; border-radius:22px; background:#102a2d; color:#eafffa; padding:12px 15px; font-size:15px; font-weight:900; box-shadow:0 4px 15px #0008; cursor:pointer; }
        #${ROOT_ID} .fish-panel { margin-top:7px; background:rgba(20,20,27,.97); border:1px solid #4b8e84; border-radius:13px; padding:11px; box-shadow:0 8px 25px #0009; display:none; max-height:70vh; overflow:auto; }
        #${ROOT_ID} .fish-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:800; font-size:14px; margin-bottom:8px; }
        #${ROOT_ID} .fish-head small { font-size:10px; font-weight:600; color:#99d6c9; }
        #${ROOT_ID} .fish-status { padding:8px; border-radius:8px; background:#282832; margin-bottom:8px; overflow-wrap:anywhere; }
        #${ROOT_ID} .fish-status strong { color:#74e2c4; }
        #${ROOT_ID} .fish-row { display:flex; gap:6px; margin:6px 0; }
        #${ROOT_ID} button.fish-action { border:0; border-radius:8px; padding:9px 8px; color:#fff; background:#38404a; font-weight:750; flex:1; min-width:0; cursor:pointer; }
        #${ROOT_ID} button.fish-start { background:#087f68; }
        #${ROOT_ID} button.fish-stop { background:#a33c4b; }
        #${ROOT_ID} button.fish-sell { background:#7d5a14; }
        #${ROOT_ID} button.fish-test { background:#6a4c9c; }
        #${ROOT_ID} button.fish-small { padding:7px 8px; font-size:11px; }
        #${ROOT_ID} label { display:flex; align-items:center; gap:7px; margin:7px 0; color:#e4dff0; font-size:11px; }
        #${ROOT_ID} input[type=checkbox] { width:17px; height:17px; accent-color:#42c7a3; }
        #${ROOT_ID} .fish-slider-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
        #${ROOT_ID} .fish-slider-row input[type=range] { flex:1; accent-color:#42c7a3; }
        #${ROOT_ID} .fish-slider-row span { width:42px; text-align:right; }
        #${ROOT_ID} .fish-count-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
        #${ROOT_ID} .fish-count-row input, #${ROOT_ID} .fish-count-row select { width:auto; min-width:72px; padding:6px; border-radius:6px; border:1px solid #585766; background:#121219; color:#fff; font-size:12px; }
        #${ROOT_ID} .fish-count-row input { width:72px; }
        #${ROOT_ID} .fish-stats { color:#9fe6d3; font-size:10.5px; margin-top:6px; }
        #${ROOT_ID} .fish-note { color:#c3bfce; font-size:10.5px; margin-top:8px; }
        #${ROOT_ID} .fish-log { white-space:pre-wrap; font-size:10px; color:#d4d0df; background:#111117; border-radius:8px; padding:7px; margin-top:8px; max-height:132px; overflow:auto; }
        #${ROOT_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:4px 8px !important; flex:0 0 auto !important; }
        .hh3d-debug-dot { position:fixed; width:20px; height:20px; background:red; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:.8; transition:opacity .5s; }
        .hh3d-debug-btn { position:fixed; width:30px; height:30px; border:3px solid yellow; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:.8; transition:opacity .5s; }
      </style>
      <button type="button" class="fish-fab" id="hh3df-fab">🎣 Câu Cá</button>
      <section class="fish-panel" id="hh3df-panel">
        <div class="fish-head"><span>🎣 HH3D · Câu Cá <small>v${VERSION}</small></span><button class="fish-action fish-collapse" id="hh3df-hide" type="button">Ẩn</button></div>
        <div class="fish-status" id="hh3df-status">Trạng thái: <strong>Sẵn sàng</strong></div>
        <div class="fish-row">
          <button type="button" class="fish-action fish-start" id="hh3df-start">▶ Bắt đầu</button>
          <button type="button" class="fish-action fish-stop" id="hh3df-stop">■ Dừng</button>
        </div>
        <label><input type="checkbox" id="hh3df-autosell" ${autoSell ? 'checked' : ''}> Tự bán ★1–2 khi giỏ gần đầy</label>

        <div style="margin-top:10px; font-weight:bold; color:#74e2c4; font-size:11px;">Điểm ném:</div>
        <div class="fish-slider-row"><span>Ngang:</span><input type="range" id="hh3df-tap-x" min="5" max="95" value="${tapX}"><span id="hh3df-tap-x-val">${tapX}%</span></div>
        <div class="fish-slider-row"><span>Dọc:</span><input type="range" id="hh3df-tap-y" min="5" max="95" value="${tapY}"><span id="hh3df-tap-y-val">${tapY}%</span></div>
        <div class="fish-row"><button type="button" class="fish-action fish-small" id="hh3df-pick">🎯 Chọn điểm ném trên màn hình</button></div>
        <div class="fish-count-row"><span>Kiểu ném:</span>
          <select id="hh3df-cast">
            <option value="auto">Tự động (chạm → kéo)</option>
            <option value="tap">Chạm (theo "Điểm câu" của game)</option>
            <option value="drag">Kéo tới điểm đã chọn</option>
          </select>
        </div>
        <div class="fish-count-row"><span>Giữ ném (ms):</span><input type="number" id="hh3df-hold-ms" min="20" max="2000" step="20" value="${holdMs}"></div>
        <div class="fish-count-row"><span>Chế độ nhập:</span>
          <select id="hh3df-mode">
            <option value="auto">Tự động</option>
            <option value="direct">Trực tiếp</option>
            <option value="dispatch">Mô phỏng</option>
          </select>
        </div>
        <div class="fish-count-row" title="Dùng khi tool không đọc được số cá trong giỏ. 0 = tắt."><span>Bán mỗi (lần kéo):</span><input type="number" id="hh3df-blind-n" min="0" max="50" step="1" value="${blindN}"></div>

        <div class="fish-row"><button type="button" class="fish-action fish-sell" id="hh3df-sell">🧺 Bán cá thường</button></div>
        <div class="fish-row">
          <button type="button" class="fish-action fish-small" id="hh3df-check">🔎 Chẩn đoán</button>
          <button type="button" class="fish-action fish-test" id="hh3df-test-cast">🎣 Thử ném</button>
        </div>
        <div class="fish-row">
          <button type="button" class="fish-action fish-small" id="hh3df-copy">📋 Sao chép log</button>
          <button type="button" class="fish-action fish-small" id="hh3df-clear">Xóa log</button>
        </div>
        <div class="fish-stats" id="hh3df-stats"></div>
        <div class="fish-note">GIỮ: nâng khung · THẢ: hạ khung. Hãy để màn hình sáng & tab ở phía trước.</div>
        <div class="fish-log" id="hh3df-log">Chưa có hoạt động.</div>
      </section>`;

    DOC.body.appendChild(root);

    panel = root.querySelector('#hh3df-panel');
    statusEl = root.querySelector('#hh3df-status');
    logEl = root.querySelector('#hh3df-log');
    statsEl = root.querySelector('#hh3df-stats');
    tapXSlider = root.querySelector('#hh3df-tap-x');
    tapYSlider = root.querySelector('#hh3df-tap-y');
    tapXVal = root.querySelector('#hh3df-tap-x-val');
    tapYVal = root.querySelector('#hh3df-tap-y-val');
    holdMsInput = root.querySelector('#hh3df-hold-ms');
    blindInput = root.querySelector('#hh3df-blind-n');
    modeSelect = root.querySelector('#hh3df-mode');
    modeSelect.value = cfgMode;
    castSelect = root.querySelector('#hh3df-cast');
    castSelect.value = cfgCast;

    root.querySelector('#hh3df-fab').addEventListener('click', () => {
      panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
    });
    root.querySelector('#hh3df-hide').addEventListener('click', () => { panel.style.display = 'none'; });
    tapXSlider.addEventListener('input', e => { tapXVal.textContent = e.target.value + '%'; saveCfg(); });
    tapYSlider.addEventListener('input', e => { tapYVal.textContent = e.target.value + '%'; saveCfg(); });
    holdMsInput.addEventListener('change', saveCfg);
    blindInput.addEventListener('change', saveCfg);
    modeSelect.addEventListener('change', e => {
      cfgMode = e.target.value;
      autoMode = null;
      castComboIdx = 0;
      castRetryCount = 0;
      saveCfg();
      log(`Chế độ nhập: ${cfgMode}.`);
    });
    castSelect.addEventListener('change', e => {
      cfgCast = e.target.value;
      autoCast = null;
      castComboIdx = 0;
      castRetryCount = 0;
      saveCfg();
      log(`Kiểu ném: ${cfgCast}.`);
    });
    root.querySelector('#hh3df-pick').addEventListener('click', pickAim);
    root.querySelector('#hh3df-start').addEventListener('click', start);
    root.querySelector('#hh3df-stop').addEventListener('click', () => stop('Dừng thủ công.'));
    root.querySelector('#hh3df-autosell').addEventListener('change', e => {
      autoSell = !!e.target.checked;
      saveCfg();
      log(`Tự bán cá ★1–2: ${autoSell ? 'BẬT' : 'TẮT'}.`);
    });
    root.querySelector('#hh3df-sell').addEventListener('click', () => startBagFlow('manual', !running));
    root.querySelector('#hh3df-check').addEventListener('click', diagnostic);
    root.querySelector('#hh3df-test-cast').addEventListener('click', testCast);
    root.querySelector('#hh3df-copy').addEventListener('click', copyLog);
    root.querySelector('#hh3df-clear').addEventListener('click', () => { logLines = []; logEl.textContent = 'Đã xóa log.'; });

    updateStats();
    log(`Đã nạp v${VERSION} · Hook: ${INPUT_BRIDGE.ok ? 'OK' : 'LỖI'} · Probe vẽ: ${DRAW_PROBE.supported ? 'OK' : 'không'}.`);
    setStatus('Sẵn sàng.', 'Sẵn sàng');
  }

  function setStatus(message, strong = '') {
    if (!statusEl) return;
    statusEl.innerHTML = `Trạng thái: <strong>${escapeHtml(strong || message)}</strong>${strong ? `<div style="margin-top:3px">${escapeHtml(message)}</div>` : ''}`;
  }

  function log(message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    logLines.unshift(`[${time}] ${message}`);
    logLines = logLines.slice(0, 80);
    if (logEl) logEl.textContent = logLines.slice(0, 14).join('\n');
  }

  function updateStats() {
    if (!statsEl) return;
    const st = staminaLast ? ` · Sức câu ${staminaLast.value}/${staminaLast.max}` : '';
    statsEl.textContent = `Ném ${stats.casts} · Giật ${stats.hooks} · Kéo xong ${stats.reels} · Đã bán ${stats.sold} con${st}`;
  }

  async function copyLog() {
    const text = `HH3D Fishing v${VERSION}\nUA: ${PAGE.navigator.userAgent}\nURL: ${PAGE.location.href}\n` +
      logLines.slice().reverse().join('\n');
    try {
      await PAGE.navigator.clipboard.writeText(text);
      log('Đã sao chép log vào clipboard.');
    } catch (_) {
      try {
        const ta = DOC.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
        DOC.body.appendChild(ta);
        ta.select();
        DOC.execCommand('copy');
        ta.remove();
        log('Đã sao chép log (cách dự phòng).');
      } catch (e) { log('Không sao chép được log: ' + (e && e.message || e)); }
    }
  }

  function showDebugDot(x, y, isButton = false) {
    if (!DOC.body) return;
    const dot = DOC.createElement('div');
    dot.className = isButton ? 'hh3d-debug-btn' : 'hh3d-debug-dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    DOC.body.appendChild(dot);
    setTimeout(() => { dot.style.opacity = '0'; setTimeout(() => dot.remove(), 500); }, 1200);
  }

  // Chạm lên màn hình để chọn điểm ném (đổi sang kiểu "Kéo tới điểm đã chọn").
  function pickAim() {
    if (DOC.getElementById('hh3d-aim-overlay') || !DOC.body) return;
    const ov = DOC.createElement('div');
    ov.id = 'hh3d-aim-overlay';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:rgba(0,0,0,.25);touch-action:none;display:flex;justify-content:center;align-items:flex-start;';
    ov.innerHTML = '<div style="margin-top:96px;padding:10px 14px;border-radius:12px;background:#102a2d;color:#eafffa;font:700 14px/1.4 system-ui,sans-serif;text-align:center;max-width:80%;border:1px solid #5bcaaf">🎯 Chạm vào điểm trên hồ bạn muốn ném câu tới<br><button type="button" id="hh3d-aim-cancel" style="margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #5bcaaf;background:transparent;color:#fff;font-weight:700">Hủy</button></div>';
    const close = () => { ov.remove(); if (panel) panel.style.display = 'block'; };
    ov.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'hh3d-aim-cancel') { close(); return; }
      const px = clamp(Math.round(e.clientX / PAGE.innerWidth * 100), 5, 95);
      const py = clamp(Math.round(e.clientY / PAGE.innerHeight * 100), 5, 95);
      if (tapXSlider) { tapXSlider.value = px; tapXVal.textContent = px + '%'; }
      if (tapYSlider) { tapYSlider.value = py; tapYVal.textContent = py + '%'; }
      cfgCast = 'drag';
      autoCast = null;
      castComboIdx = 0;
      if (castSelect) castSelect.value = 'drag';
      saveCfg();
      showDebugDot(e.clientX, e.clientY);
      log(`Điểm ném mới: ${px}% / ${py}% (${Math.round(e.clientX)},${Math.round(e.clientY)}) → kiểu ném: kéo tới điểm đã chọn.`);
      close();
    });
    DOC.body.appendChild(ov);
    if (panel) panel.style.display = 'none';
  }

  /* ------------------------------------------------------------------ *
   * 5) Đọc trạng thái game
   * ------------------------------------------------------------------ */
  function gameMainButton() {
    return DOC.querySelector('button.fish-main, .fish-main');
  }

  function gameState(btn = gameMainButton()) {
    if (!btn) return 'missing';
    if (btn.classList.contains('st-idle')) return 'idle';
    if (btn.classList.contains('st-wait')) return 'wait';
    if (btn.classList.contains('st-bite')) return 'bite';
    if (btn.classList.contains('st-reel')) return 'reel';
    const t = normalize(btn.getAttribute('aria-label') || btn.textContent || '');
    if (/giat/.test(t)) return 'bite';
    if (/giu/.test(t)) return 'reel';
    if (/cho ca/.test(t)) return 'wait';
    if (/nem cau/.test(t)) return 'idle';
    const raw = (/\bst-([a-z0-9_-]+)/i.exec(String(btn.className)) || [])[1] || '';
    if (/bite|hook|strike|tug|nibble|giat/i.test(raw)) return 'bite';
    if (/reel|pull|fight|tension|keo/i.test(raw)) return 'reel';
    if (/wait|float|cast|line|sink/i.test(raw)) return 'wait';
    return raw ? 'st-' + raw : 'unknown';
  }

  const labelOf = (btn) => String((btn && (btn.getAttribute('aria-label') || btn.textContent)) || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  /* ------------------------------------------------------------------ *
   * 6) Gửi input: "direct" (gọi thẳng handler đã bắt) hoặc "dispatch" (bắn PointerEvent)
   * ------------------------------------------------------------------ */
  function matchesRecord(target, r) {
    if (r.target === target) return true;
    if (target === PAGE) return r.isWin;
    if (target === DOC) return r.isDoc;
    if (r.isNode && target && target.nodeType === 1) { try { return target.isSameNode(r.target); } catch (_) {} }
    return false;
  }

  const fbCache = new Map();
  let fbAt = 0;

  function getCaptured(target, type) {
    let out = [];
    try {
      const store = (target && (typeof target === 'object' || typeof target === 'function')) ? STORE.get(target) : null;
      if (store && Array.isArray(store[type])) out = store[type].slice();
      else if (CONTENT && target) {
        const nowT = performance.now();
        if (nowT - fbAt > 500) { fbCache.clear(); fbAt = nowT; }
        let m = fbCache.get(target);
        if (!m) { m = Object.create(null); fbCache.set(target, m); }
        out = (m[type] || (m[type] = ALL.filter(r => r.type === type && matchesRecord(target, r)).map(r => r.entry))).slice();
      }
    } catch (_) {}
    try {                                   // handler gán kiểu thuộc tính: el.onpointerdown = fn
      const prop = target && target['on' + type];
      if (typeof prop === 'function') out.push({ listener: prop, capture: false, once: false, prop: true });
    } catch (_) {}
    return out;
  }

  function chainOf(btn) {                   // nút → cha → ... → document → window
    const list = [];
    for (let el = btn; el; el = el.parentElement) list.push(el);
    list.push(DOC, PAGE);
    return list;
  }

  // Số handler gắn thẳng trên nút (own) và trên cả chuỗi nổi bọt (chain).
  let hsCache = { at: -1e9, btn: null, val: null };
  function handlerStatus(btn = gameMainButton(), force = false) {
    const nowT = performance.now();
    if (!force && btn && hsCache.btn === btn && hsCache.val && nowT - hsCache.at < 400) return hsCache.val;
    const z = { down: 0, move: 0, up: 0 };
    if (!btn) return { own: z, chain: { ...z } };
    const own = { ...z }, chain = { ...z };
    const keys = { down: 'pointerdown', move: 'pointermove', up: 'pointerup' };
    const list = chainOf(btn);
    for (const k of Object.keys(keys)) {
      own[k] = getCaptured(btn, keys[k]).length;
      for (const t of list) chain[k] += getCaptured(t, keys[k]).length;
    }
    hsCache = { at: nowT, btn, val: { own, chain } };
    return hsCache.val;
  }

  const hasAll = (h) => !!(h.down && h.move && h.up);
  function directAvailable(btn = gameMainButton()) { return hasAll(handlerStatus(btn).chain); }
  function directStrong(btn = gameMainButton()) { return hasAll(handlerStatus(btn).own); }

  function currentMode() {
    if (forcedMode) return forcedMode;
    const direct = directAvailable();
    if (cfgMode === 'direct') return direct ? 'direct' : 'dispatch';
    if (cfgMode === 'dispatch') return 'dispatch';
    if (autoMode === 'direct' && !direct) autoMode = 'dispatch';
    if (!autoMode) autoMode = directStrong() ? 'direct' : 'dispatch';
    return autoMode;
  }

  // Các cách ném có thể thử: kiểu (chạm / kéo tới điểm) × chế độ nhập (trực tiếp / mô phỏng).
  function castCombos() {
    const kinds = cfgCast === 'auto' ? ['tap', 'drag'] : [cfgCast];
    let modes;
    if (cfgMode === 'direct') modes = directAvailable() ? ['direct'] : ['dispatch'];
    else if (cfgMode === 'dispatch') modes = ['dispatch'];
    else modes = directAvailable() ? (directStrong() ? ['direct', 'dispatch'] : ['dispatch', 'direct']) : ['dispatch'];
    const out = [];
    for (const k of kinds) for (const m of modes) out.push({ kind: k, mode: m });
    return out;
  }
  function currentCombo() {
    if (forcedCombo) return forcedCombo;
    const combos = castCombos();
    if (castComboIdx >= combos.length) castComboIdx = 0;
    return combos[castComboIdx];
  }
  function advanceCombo() {
    const combos = castCombos();
    if (combos.length > 1) {
      castComboIdx = (castComboIdx + 1) % combos.length;
      const n = combos[castComboIdx];
      if (cfgMode === 'auto') autoMode = n.mode;
      log(`→ thử cách ném ${n.kind}/${n.mode}.`);
    }
  }

  function chooseHandlers(entries, type) {
    if (!entries.length) return [];
    const scored = entries.map(entry => {
      const fn = entry.listener;
      let src = '', name = '';
      try { name = typeof fn === 'function' ? fn.name || '' : ''; } catch (_) {}
      try { src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''; } catch (_) {}
      let score = 0;
      if (type === 'pointerdown') {
        if (name === 'js') score += 100;
        if (/setPointerCapture/.test(src)) score += 30;
        if (/pressed/.test(src)) score += 20;
        if (/pointerId/.test(src)) score += 10;
      } else if (type === 'pointermove') {
        if (name === 'yr') score += 100;
        if (/Math\.hypot/.test(src)) score += 40;
        if (/clientX/.test(src) && /clientY/.test(src)) score += 10;
      } else {
        if (name === 'Ze') score += 100;
        if (/pressed/.test(src)) score += 20;
      }
      return { entry, score };
    }).sort((a, b) => b.score - a.score);

    if (scored[0].score >= 30) return [scored[0].entry];
    return entries;
  }

  // Facade KHÔNG dùng `this` (để chạy đúng cả khi bị cloneInto sang realm của trang).
  function makeEventFacade(type, target, x, y, pointerId, buttons, flags) {
    const toPage = (arr) => (CONTENT ? cloneInto(arr, W, { wrapReflectors: true }) : arr);
    return {
      type, target, currentTarget: target,
      isTrusted: true,
      pointerId, pointerType: 'touch', isPrimary: true,
      width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      button: type === 'pointermove' ? -1 : 0, buttons,
      clientX: x, clientY: y,
      pageX: x + (PAGE.scrollX || 0), pageY: y + (PAGE.scrollY || 0),
      screenX: x, screenY: y, offsetX: 0, offsetY: 0, movementX: 0, movementY: 0,
      ctrlKey: false, shiftKey: false, altKey: false, metaKey: false,
      bubbles: true, cancelable: true, composed: true, eventPhase: 2, detail: 0,
      view: CONTENT ? null : PAGE, relatedTarget: null,
      timeStamp: PAGE.performance ? PAGE.performance.now() : Date.now(),
      defaultPrevented: false,
      preventDefault() { flags.prevented = true; },
      stopPropagation() { flags.stop = true; },
      stopImmediatePropagation() { flags.stop = true; flags.stopNow = true; },
      composedPath() { return toPage([target, DOC.body, DOC.documentElement, DOC]); },
      getModifierState() { return false; },
      getCoalescedEvents() { return toPage([]); },
      getPredictedEvents() { return toPage([]); }
    };
  }

  // Gọi trực tiếp handler của game theo đúng thứ tự DOM: capture (window→nút) rồi bubble (nút→window).
  async function invokeGamePointer(btn, type, x, y, pointerId, buttons) {
    if (!btn) return false;
    const chain = chainOf(btn);
    const plan = chain.map(t => {
      let entries = getCaptured(t, type);
      if (t === btn && entries.length && !handlerAll) entries = chooseHandlers(entries, type);
      return { t, entries };
    }).filter(p => p.entries.length);
    if (!plan.length) return false;

    const flags = { stop: false, stopNow: false, prevented: false };
    const ev = makeEventFacade(type, btn, x, y, pointerId, buttons, flags);
    let invoked = 0;

    const callEntry = async (t, entry) => {
      let listener = entry.listener;
      try {
        ev.currentTarget = t;
        ev.eventPhase = t === btn ? 2 : (entry.capture ? 1 : 3);
        const arg = CONTENT ? cloneInto(ev, W, { cloneFunctions: true, wrapReflectors: true }) : ev;
        if (CONTENT && listener && typeof listener === 'object' && listener.wrappedJSObject) listener = listener.wrappedJSObject;
        let out;
        if (typeof listener === 'function') out = Reflect.apply(listener, t, [arg]);
        else if (listener && typeof listener.handleEvent === 'function') out = Reflect.apply(listener.handleEvent, listener, [arg]);
        else return;
        invoked++;
        if (out && typeof out.then === 'function') await out;
      } catch (e) {
        log(`Handler ${type} báo lỗi: ${e && e.message || e}`);
      }
      if (entry.once) {
        try {
          const st = STORE.get(t);
          const arr = st && st[type];
          const i = arr ? arr.indexOf(entry) : -1;
          if (i >= 0) arr.splice(i, 1);
        } catch (_) {}
      }
    };

    // pha capture: từ window xuống nút
    for (const p of plan.slice().reverse()) {
      for (const entry of p.entries.filter(e => e.capture)) {
        await callEntry(p.t, entry);
        if (flags.stopNow) break;
      }
      if (flags.stop) return invoked > 0;
    }
    // pha bubble: từ nút lên window
    for (const p of plan) {
      for (const entry of p.entries.filter(e => !e.capture)) {
        await callEntry(p.t, entry);
        if (flags.stopNow) break;
      }
      if (flags.stop) break;
    }
    return invoked > 0;
  }

  function firePointer(btn, type, x, y, pid, buttons) {
    let target = btn;
    if (type === 'pointerdown') {
      try {
        const hit = DOC.elementFromPoint(x, y);
        if (hit && btn.contains(hit)) target = hit;
      } catch (_) {}
    }
    const init = {
      bubbles: true, cancelable: true, composed: true, view: PAGE,
      pointerId: pid, pointerType: 'touch', isPrimary: true,
      width: 1, height: 1, pressure: buttons ? 0.5 : 0,
      button: type === 'pointermove' ? -1 : 0, buttons,
      clientX: x, clientY: y, screenX: x, screenY: y
    };
    try {
      const Ctor = PAGE.PointerEvent;
      const ev = Ctor ? new Ctor(type, init) : new PAGE.MouseEvent(type.replace('pointer', 'mouse'), init);
      target.dispatchEvent(ev);
      return true;
    } catch (e) {
      log(`Không bắn được ${type}: ${e && e.message || e}`);
      return false;
    }
  }

  async function sendPointer(btn, type, x, y, pid, buttons, mode) {
    if (mode === 'direct') return invokeGamePointer(btn, type, x, y, pid, buttons);
    return firePointer(btn, type, x, y, pid, buttons);
  }

  function centerOf(element) {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /* ---- Ném cần ---- */
  async function performCastGesture(debug = false) {
    const btn = gameMainButton();
    if (!btn) { log('Không tìm thấy nút .fish-main.'); return false; }
    if (gameState(btn) !== 'idle') { log(`Không thể ném: trạng thái hiện tại là ${gameState(btn)}.`); return false; }

    const combo = currentCombo();
    const mode = combo.mode, kind = combo.kind;
    const { x: sx, y: sy } = centerOf(btn);
    const tx = (Number(tapXSlider && tapXSlider.value || CFG.tapXPercent) / 100) * PAGE.innerWidth;
    const ty = (Number(tapYSlider && tapYSlider.value || CFG.tapYPercent) / 100) * PAGE.innerHeight;
    const holdMs = clamp(Number(holdMsInput && holdMsInput.value || CFG.castHoldDurationMs), 20, 2000);
    const pid = newPid();
    activePointerId = pid;

    if (debug) { showDebugDot(sx, sy, true); if (kind === 'drag') showDebugDot(tx, ty, false); }
    setStatus(kind === 'tap' ? `Chạm ném (${mode}) theo "Điểm câu" của game…` : `Kéo tới ${Math.round(tx)},${Math.round(ty)} (${mode})…`, 'Đang ném');

    try {
      if (!await sendPointer(btn, 'pointerdown', sx, sy, pid, 1, mode)) {
        log(`Ném (${kind}/${mode}): pointerdown không được xử lý.`);
        return false;
      }
      let up;
      if (kind === 'tap') {
        await sleep(70);
        up = await sendPointer(btn, 'pointerup', sx, sy, pid, 0, mode);
      } else {
        await sleep(40);
        const steps = Math.max(1, CFG.castMoveSteps);
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          const ok = await sendPointer(btn, 'pointermove', sx + (tx - sx) * k, sy + (ty - sy) * k, pid, 1, mode);
          if (!ok) {
            log(`Ném (${kind}/${mode}): pointermove không được xử lý.`);
            await sendPointer(btn, 'pointerup', sx, sy, pid, 0, mode);
            return false;
          }
          await sleep(18);
        }
        await sleep(holdMs);
        up = await sendPointer(btn, 'pointerup', tx, ty, pid, 0, mode);
      }
      lastActionAt = Date.now();
      castPending = { at: Date.now(), mode, kind };
      stats.casts++;
      updateStats();
      log(`Đã gửi lệnh ném (${kind}/${mode}).`);
      return !!up;
    } finally {
      activePointerId = null;
    }
  }

  function castConfirmed() {
    if (!castPending) return;
    const { mode, kind } = castPending;
    castPending = null;
    castRetryCount = 0;
    if (cfgMode === 'auto') autoMode = mode;
    if (cfgCast === 'auto') autoCast = kind;
  }

  function castFailed() {
    const p = castPending || currentCombo();
    castPending = null;
    castRetryCount++;
    log(`Game không phản hồi lệnh ném (${p.kind}/${p.mode}) · lần ${castRetryCount}.`);
    advanceCombo();
    if (castRetryCount > CFG.maxCastRetry) {
      stop('Ném nhiều lần nhưng game không phản hồi. Kiểm tra: còn sức câu? giỏ đầy? có popup che? Bấm "Chẩn đoán" rồi "Sao chép log".');
    }
  }

  async function testCast() {
    if (testBusy) return;
    testBusy = true;
    try {
      const combos = castCombos();
      for (let i = 0; i < combos.length; i++) {
        const c = combos[i];
        if (gameState() !== 'idle') { log(`Không thử ném được: game đang ở trạng thái ${gameState()}.`); break; }
        forcedCombo = c;
        forcedMode = c.mode;
        const sent = await performCastGesture(true);
        castPending = null;
        if (!sent) { log(`❌ ${c.kind}/${c.mode}: không gửi được lệnh.`); continue; }
        const ok = await waitFor(() => gameState() !== 'idle', CFG.castVerifyMs);
        if (ok) {
          log(`✅ Ném thành công: ${c.kind}/${c.mode}.`);
          castComboIdx = i;
          if (cfgMode === 'auto') autoMode = c.mode;
          if (cfgCast === 'auto') autoCast = c.kind;
          setStatus(`Cách ném "${c.kind}/${c.mode}" hoạt động.`, 'Thử ném OK');
          return;
        }
        log(`❌ ${c.kind}/${c.mode}: game không đổi trạng thái.`);
      }
      setStatus('Không cách ném nào làm game phản hồi. Bấm "Sao chép log".', 'Thử ném thất bại');
    } finally {
      forcedCombo = null;
      forcedMode = null;
      testBusy = false;
    }
  }

  /* ---- Giật + giữ/thả khi kéo ---- */
  async function pressMainForReel() {
    if (reelHeld) return true;
    const btn = gameMainButton();
    if (!btn) return false;
    const { x, y } = centerOf(btn);
    const pid = activePointerId || newPid();
    activePointerId = pid;
    const mode = currentMode();
    const ok = await sendPointer(btn, 'pointerdown', x, y, pid, 1, mode);
    if (ok) { reelHeld = true; reelMode = mode; }
    return ok;
  }

  async function releaseMainForReel() {
    if (!reelHeld && activePointerId == null) return true;
    const btn = gameMainButton();
    if (!btn) { reelHeld = false; activePointerId = null; return false; }
    const { x, y } = centerOf(btn);
    const pid = activePointerId || newPid();
    const ok = await sendPointer(btn, 'pointerup', x, y, pid, 0, reelMode || currentMode());
    reelHeld = false;
    activePointerId = null;
    reelMode = null;
    return ok;
  }

  async function hookTapPointer(btn, mode, holdMs) {
    const { x, y } = centerOf(btn);
    const pid = newPid();
    const down = await sendPointer(btn, 'pointerdown', x, y, pid, 1, mode);
    await sleep(holdMs);
    const up = await sendPointer(btn, 'pointerup', x, y, pid, 0, mode);
    return !!(down || up);
  }

  // Dự phòng cho game nghe sự kiện touch/mouse/click thay vì pointer.
  function hookMouseTouch(btn) {
    const { x, y } = centerOf(btn);
    let target = btn;
    try { const hit = DOC.elementFromPoint(x, y); if (hit && btn.contains(hit)) target = hit; } catch (_) {}
    try {
      if (PAGE.TouchEvent && PAGE.Touch) {
        const t = new PAGE.Touch({ identifier: newPid(), target, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
        const base = { bubbles: true, cancelable: true, composed: true };
        target.dispatchEvent(new PAGE.TouchEvent('touchstart', { ...base, touches: [t], targetTouches: [t], changedTouches: [t] }));
        target.dispatchEvent(new PAGE.TouchEvent('touchend', { ...base, touches: [], targetTouches: [], changedTouches: [t] }));
      }
    } catch (_) {}
    for (const type of ['mousedown', 'mouseup', 'click']) {
      try {
        target.dispatchEvent(new PAGE.MouseEvent(type, {
          bubbles: true, cancelable: true, composed: true, view: PAGE,
          clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0
        }));
      } catch (_) {}
    }
    return true;
  }

  // Giật cá: thử lần lượt nhiều cách, sau mỗi cách kiểm tra game đã rời trạng thái "bite" chưa.
  async function hookFish() {
    let btn = gameMainButton();
    if (!btn || gameState(btn) !== 'bite') return false;
    lastHookAt = Date.now();
    hookAttempts++;
    const mode = currentMode();
    const alt = mode === 'direct' ? 'dispatch' : (directAvailable() ? 'direct' : 'dispatch');
    const B = () => gameMainButton() || btn;
    const steps = [
      { name: `chạm ${mode}`, run: () => hookTapPointer(B(), mode, 60) },
      { name: 'click()', run: async () => { try { B().click(); } catch (_) {} } },
      { name: `chạm ${alt}${alt === mode ? ' (giữ lâu)' : ''}`, run: () => hookTapPointer(B(), alt, alt === mode ? 240 : 60) },
      { name: 'mouse+touch', run: async () => hookMouseTouch(B()) }
    ];
    const order = steps.map((_, i) => i);
    if (hookPref > 0 && hookPref < steps.length) { order.splice(order.indexOf(hookPref), 1); order.unshift(hookPref); }

    setStatus(`Phao chìm — đang Giật! (${mode})`, 'Cá cắn');
    for (const i of order) {
      if (gameState() !== 'bite') break;
      try { await steps[i].run(); } catch (e) { log(`Giật "${steps[i].name}" lỗi: ${e && e.message || e}`); }
      await sleep(130);
      if (gameState() !== 'bite') {
        hookPref = i;
        stats.hooks++;
        updateStats();
        log(`✅ Giật thành công: "${steps[i].name}" (lần ${hookAttempts}).`);
        return true;
      }
      log(`Giật: "${steps[i].name}" chưa có tác dụng.`);
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 7) Đọc thanh kéo cá
   * ------------------------------------------------------------------ */
  function pointToT(x, y) {
    const Ds = 205 * Math.PI / 180;
    const cr = 95 * Math.PI / 180;
    let angle = Math.atan2(-y, x);
    if (angle < 0) angle += Math.PI * 2;
    return clamp((angle - Ds) / (cr - Ds), 0, 1);
  }

  function readLakeGauge() {
    const t = PAGE.performance ? PAGE.performance.now() : Date.now();
    if (t - lastCanvasScan < 220) return lastCanvasGauge;
    lastCanvasScan = t;
    let best = null;
    const canvases = [...DOC.querySelectorAll('canvas')].filter(c => {
      const r = c.getBoundingClientRect();
      return r.width > 220 && r.height > 160 && c.width > 220 && c.height > 160;
    });
    for (const canvas of canvases) {
      try {
        const w = canvas.width, h = canvas.height;
        if (w * h > 9000000) continue;
        const sampleStep = Math.max(1, Math.round(w / 950));
        let data;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          data = ctx.getImageData(0, 0, w, h).data;
        } else {
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
          if (!gl) continue;
          const raw = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
          if (gl.getError() !== gl.NO_ERROR) continue;
          data = new Uint8Array(raw.length);
          for (let y = 0; y < h; y++) data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
        }
        const orange = (x, y) => {
          const i = (y * w + x) * 4;
          return data[i] > 206 && data[i] < 255 && data[i + 1] > 115 && data[i + 1] < 215 &&
                 data[i + 2] > 35 && data[i + 2] < 145 && data[i] > data[i + 1] + 45 && data[i + 1] > data[i + 2] + 35 && data[i + 3] > 195;
        };
        const white = (x, y) => {
          const i = (y * w + x) * 4;
          return data[i] > 208 && data[i + 1] > 223 && data[i + 2] > 220 && data[i + 3] > 210 &&
                 Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) < 45;
        };
        const consider = (y0, y1, x) => {
          const length = y1 - y0;
          if (length < 28 || length > Math.min(270, h * .68)) return;
          let contiguous = 0;
          for (let yy = y0 + 4; yy < y1 - 4; yy += 6) {
            let row = 0;
            for (let xx = Math.max(0, x - 6); xx < Math.min(w, x + 7); xx += 3) if (orange(xx, yy)) row++;
            if (row >= 2) contiguous++;
          }
          if (contiguous < 4) return;
          let fishY = -1, scoreBest = -1;
          const center = (y0 + y1) / 2;
          const radius = Math.min(Math.round(h * .42), 250);
          for (let yy = Math.max(12, Math.round(center - radius)); yy < Math.min(h - 12, Math.round(center + radius)); yy += 2) {
            let score = 0;
            for (let xx = Math.max(0, x - 11); xx < Math.min(w, x + 12); xx += 2) if (white(xx, yy)) score++;
            if (score >= 3) {
              let peak = score;
              for (let dy = -3; dy <= 3; dy += 3) {
                const ry = yy + dy;
                if (ry < 0 || ry >= h) continue;
                let v = 0;
                for (let xx = Math.max(0, x - 11); xx < Math.min(w, x + 12); xx += 2) if (white(xx, ry)) v++;
                peak += v;
              }
              const quality = peak - Math.abs(yy - center) * .035;
              if (quality > scoreBest) { scoreBest = quality; fishY = yy; }
            }
          }
          if (fishY < 0 || scoreBest < 7) return;
          const candidate = {
            fish: 1 - fishY / h, zone: 1 - center / h, width: length / h,
            lo: 1 - y1 / h, hi: 1 - y0 / h, now: t, source: 'canvas', score: contiguous + scoreBest,
            canvasX: x, fishY, zoneY: center
          };
          if (!best || candidate.score > best.score) best = candidate;
        };
        for (let x = 15; x < w - 15; x += 3 * sampleStep) {
          let run = 0, runStart = -1;
          for (let y = 10; y < h - 10; y += 2) {
            if (orange(x, y)) {
              if (!run) runStart = y;
              run += 2;
            } else {
              if (run >= 28) consider(runStart, y - 2, x);
              run = 0;
            }
          }
          if (run >= 28) consider(runStart, h - 12, x);
        }
      } catch (e) { /* canvas bị taint hoặc không đọc được pixel */ }
    }
    lastCanvasGauge = best;
    return best;
  }

  function readDrawGauge() {
    const d = DRAW_PROBE.last;
    if (!d || performance.now() - d.at > 350 || d.zoneHeight < 8) return null;
    return {
      fish: d.fishY, zone: d.zoneY, width: d.zoneHeight,
      lo: d.zoneY - d.zoneHeight / 2, hi: d.zoneY + d.zoneHeight / 2,
      now: d.at, source: 'draw2d'
    };
  }

  function readGauge() {
    const btn = gameMainButton();
    if (!btn || gameState(btn) !== 'reel') return null;
    if (btn.classList.contains('ruler-lake')) return readDrawGauge() || readLakeGauge();
    const fish = btn.querySelector('.fg-fish');
    const zone = btn.querySelector('.fg-zone');
    if (!fish || !zone) return readDrawGauge();
    const cx = Number(fish.getAttribute('cx'));
    const cy = Number(fish.getAttribute('cy'));
    const d = zone.getAttribute('d') || '';
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || nums.length < 9) return null;
    const a = pointToT(nums[0], nums[1]);
    const b = pointToT(nums[nums.length - 2], nums[nums.length - 1]);
    const fishT = pointToT(cx, cy);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const now = PAGE.performance ? PAGE.performance.now() : Date.now();
    return { fish: fishT, zone: (lo + hi) / 2, width: Math.max(.02, hi - lo), lo, hi, now, source: 'svg' };
  }

  function updateVelocity(g) {
    if (!gaugePrev) { gaugePrev = g; return gaugeVel; }
    if (g.now - gaugePrev.now >= 12) {            // mẫu mới
      const dt = Math.max(0.03, (g.now - gaugePrev.now) / 1000);
      gaugeVel = dt < 0.4
        ? { fish: (g.fish - gaugePrev.fish) / dt, zone: (g.zone - gaugePrev.zone) / dt }
        : { fish: 0, zone: 0 };
      gaugePrev = g;
    }
    return gaugeVel;
  }

  async function adaptiveReel() {
    const g = readGauge();
    if (!g) {
      gaugeMisses++;
      if (reelHeld) await releaseMainForReel();
      setStatus('Mất dữ liệu thanh cá, tạm thả.', 'Thiếu tín hiệu gauge');
      if (gaugeMisses === 1 || gaugeMisses % 30 === 0) {
        log(`Không có gauge · Canvas2D=${DRAW_PROBE.supported ? 'có' : 'không'}, tuổi=${DRAW_PROBE.last ? Math.round(performance.now() - DRAW_PROBE.last.at) + 'ms' : 'chưa có'}.`);
      }
      return;
    }

    gaugeMisses = 0;
    const vel = updateVelocity(g);
    const fishV = vel.fish, zoneV = vel.zone;

    if (g.source === 'draw2d') {
      const fishAhead = g.fish + clamp(fishV * .10, -16, 16);
      const zoneAhead = g.zone + clamp(zoneV * .05, -9, 9);
      const diff = zoneAhead - fishAhead;           // y màn hình hướng xuống
      const dead = Math.max(3, Math.min(11, g.width * .18));
      if (reelHeld) {
        if (diff < -dead) await releaseMainForReel();
      } else if (diff > dead) {
        await pressMainForReel();
      }
      setStatus(`Vẽ 2D · Cá Y=${g.fish.toFixed(0)} · Cam Y=${g.zone.toFixed(0)} · Δ=${diff.toFixed(0)}px · ${reelHeld ? 'GIỮ' : 'THẢ'}`, 'Cân cá');
      return;
    }

    const predict = CFG.reelPredictionSec;
    const targetFish = clamp(g.fish + fishV * predict, 0.02, 0.98);
    const predictedZone = clamp(g.zone + zoneV * (predict * 0.55), 0.02, 0.98);
    const err = targetFish - predictedZone;
    const dead = clamp(g.width * 0.14, CFG.reelDeadbandMin, CFG.reelDeadbandMax);

    if (reelHeld) {
      if (err < -dead || g.zone > 1 - g.width / 2 - 0.012) await releaseMainForReel();
    } else if (err > dead || (g.zone < g.width / 2 + 0.012 && g.fish > g.zone)) {
      await pressMainForReel();
    }
    setStatus(`Nguồn ${g.source} · Cá ${(g.fish * 100).toFixed(0)}% · Khung ${(g.zone * 100).toFixed(0)}% · ${reelHeld ? 'GIỮ' : 'THẢ'}`, 'Kéo cá');
  }

  /* ------------------------------------------------------------------ *
   * 8) Đọc chữ trên trang (số cá trong giỏ, sức câu) - có cache cho nhẹ
   * ------------------------------------------------------------------ */
  function isVisible(el) {
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
    } catch (_) {}
    return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length));
  }

  function visibleText() {
    if (!DOC.body) return '';
    const parts = [];
    const vis = new Map();
    const walker = DOC.createTreeWalker(DOC.body, PAGE.NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const v = node.nodeValue;
      if (!v || !v.trim()) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      let ok = vis.get(parent);
      if (ok === undefined) {
        ok = !parent.closest('#' + ROOT_ID) && isVisible(parent);
        vis.set(parent, ok);
      }
      if (ok) parts.push(v);
    }
    return parts.join(' ');
  }

  let pageCache = { at: -1e9, norm: '' };
  function pageNorm(maxAgeMs = 700) {
    const now = performance.now();
    if (now - pageCache.at < maxAgeMs) return pageCache.norm;
    pageCache = { at: now, norm: normalize(visibleText()) };
    return pageCache.norm;
  }

  function parseBag(norm) {
    const re = /gio(?:\s+ca)?\s*(\d{1,3})\s*\/\s*(\d{1,3})/g;
    let m;
    while ((m = re.exec(norm)) !== null) {
      const count = Number(m[1]);
      const capacity = Number(m[2]);
      if (capacity > 0 && capacity <= 1000 && count >= 0 && count <= capacity) return { count, capacity, source: 'dom' };
    }
    return null;
  }

  function parseStamina(norm) {
    const m = /suc cau hom nay\s*(\d+)\s*\/\s*(\d+)/.exec(norm);
    if (!m) return null;
    const value = Number(m[1]), max = Number(m[2]);
    return max > 0 ? { value, max } : null;
  }

  // Đọc số cá trong giỏ từ chính nút/huy hiệu giỏ (aria-label, title, chữ trong nút...).
  function parseBagFromElements() {
    let els;
    try {
      els = DOC.querySelectorAll('.fish-quick-bag, [class*="bag" i], [aria-label*="giỏ" i], [aria-label*="gio" i], [title*="giỏ" i]');
    } catch (_) { return null; }
    for (const el of els) {
      if (root && root.contains(el)) continue;
      const t = normalize(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${el.textContent || ''}`);
      if (/suc cau/.test(t)) continue;
      const m = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(t);
      if (!m) continue;
      const count = Number(m[1]), capacity = Number(m[2]);
      if (capacity >= 5 && capacity <= 500 && count >= 0 && count <= capacity) return { count, capacity, source: 'dom' };
    }
    return null;
  }

  let bagCache = { at: -1e9, val: null };
  function readBagCount(force = false) {
    const now = performance.now();
    if (!force && now - bagCache.at < 700) return bagCache.val;
    const val = parseBag(pageNorm(force ? 0 : 700)) || parseBagFromElements();
    bagCache = { at: now, val };
    return val;           // null = không đọc được → dùng chế độ "bán mỗi N lần kéo"
  }

  // Trả về chuỗi lý do dừng nếu đã hết sức câu; chỉ kết luận khi đã thấy xu hướng tăng/giảm.
  function checkStamina() {
    const s = parseStamina(pageNorm(700));
    if (!s) return null;
    if (staminaLast && s.value !== staminaLast.value) {
      const d = s.value - staminaLast.value;
      if (Math.abs(d) <= 10) staminaTrend = d < 0 ? 'down' : 'up';
    }
    staminaLast = s;
    updateStats();
    if (staminaTrend === 'down' && s.value <= 0) return `Hết sức câu hôm nay (0/${s.max}).`;
    if (staminaTrend === 'up' && s.value >= s.max) return `Đã dùng hết sức câu hôm nay (${s.value}/${s.max}).`;
    return null;
  }

  /* ------------------------------------------------------------------ *
   * 9) Giỏ cá & bán cá
   * ------------------------------------------------------------------ */
  function isBagOpen() { return !!DOC.querySelector('.fish-bag'); }

  function findCloseButton() {
    const bag = DOC.querySelector('.fish-bag');
    if (!bag) return null;
    const scope = bag.closest('.sheet, .modal, [role="dialog"]') || bag;
    const cands = [...scope.querySelectorAll('button,[role="button"],[aria-label],[title]')];
    const exact = cands.find(el => {
      if (root && root.contains(el)) return false;
      const t = normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
      return /^(x|×|✕|✖|dong|dong lai|close|thoat)$/.test(t);
    });
    return exact || scope.querySelector('[class*="close"]') || null;
  }

  function closeBag() {
    if (!isBagOpen()) return false;
    const b = findCloseButton();
    if (b) { b.click(); return true; }
    for (const t of [DOC, DOC.body]) {
      try {
        t.dispatchEvent(new PAGE.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      } catch (_) {}
    }
    return false;
  }

  function startBagFlow(reason = 'manual', stopAfter = false) {
    if (bagFlow) return;
    if (!running && reason === 'manual') {
      running = true;
      if (!loopHandle) loopHandle = setInterval(tick, CFG.pollMs);
    }
    const bag = readBagCount(true);
    bagFlow = {
      reason, stopAfter, stage: 'open',
      startedAt: Date.now(), stageAt: Date.now(),
      before: bag ? bag.count : null, selected: 0
    };
    setStatus('Đang mở Giỏ cá…', 'Xử lý giỏ');
    log(reason === 'auto' ? 'Tự động bán cá ★1–2.' : 'Bán cá ★1–2 thủ công.');
  }

  function endBagFlow(msg, { sold = false, error = false } = {}) {
    const f = bagFlow;
    bagFlow = null;
    sinceSell = 0;
    try { closeBag(); } catch (_) {}
    cooldownUntil = Date.now() + 900;
    if (msg) log(msg);
    if (f && !sold && f.reason === 'auto') {
      noSellUntil = Date.now() + CFG.noSellCooldownMs;
      const bag = readBagCount(true);
      if (bag && bag.count >= bag.capacity) {
        stop('Giỏ đầy nhưng không có cá ★1–2 để bán. Hãy dọn giỏ thủ công rồi bấm Bắt đầu.');
        return;
      }
    }
    if (f && f.stopAfter) stop(msg || 'Xong.');
    else if (msg) setStatus(msg, error ? 'Lỗi giỏ' : 'Giỏ cá');
  }

  async function tickBagFlow() {
    const f = bagFlow;
    if (!f) return;
    const now = Date.now();
    if (now - f.startedAt > 25000) { endBagFlow('Bán cá quá thời gian.', { error: true }); return; }

    if (f.stage === 'open') {
      if (isBagOpen()) { f.stage = 'select'; f.stageAt = now; return; }
      const btn = DOC.querySelector('.fish-quick-bag') ||
        [...DOC.querySelectorAll('button')].find(x => /gio ca/.test(normalize(x.getAttribute('aria-label') || x.textContent)));
      if (btn) { btn.click(); f.stage = 'wait_open'; f.stageAt = now; }
      else if (now - f.stageAt > 2500) endBagFlow('Không tìm thấy nút Giỏ cá.', { error: true });
      return;
    }

    if (f.stage === 'wait_open') {
      if (isBagOpen()) { f.stage = 'select'; f.stageAt = now; return; }
      if (now - f.stageAt > 4000) endBagFlow('Không nhận diện được Giỏ cá.', { error: true });
      return;
    }

    if (f.stage === 'select') {
      const bag = DOC.querySelector('.fish-bag');
      if (!bag) { f.stage = 'open'; f.stageAt = now; return; }
      const chip = bag.querySelector('.fish-bag-chip[data-r="12"]') ||
        [...bag.querySelectorAll('button')].find(x => /chon ca.*1.*2/.test(normalize(x.getAttribute('aria-label') || x.textContent)));
      if (!chip) { endBagFlow('Không có cá ★1–2 để bán.'); return; }
      const label = normalize(chip.getAttribute('aria-label') || chip.textContent || '');
      const n = Number((label.match(/(\d+)\s*con/) || [])[1] || 0);
      if (n === 0) { endBagFlow('Không có cá ★1–2 để bán.'); return; }
      if (chip.getAttribute('aria-pressed') !== 'true') chip.click();
      f.stage = 'sell'; f.stageAt = now; f.selected = n;
      return;
    }

    if (f.stage === 'sell') {
      const bag = DOC.querySelector('.fish-bag');
      if (!bag) { f.stage = 'open'; f.stageAt = now; return; }
      const btn = [...bag.querySelectorAll('button')].find(x => /^ban\s+\d+\s+con/.test(normalize(x.textContent || '')) && !x.disabled);
      if (btn) { btn.click(); f.stage = 'wait_sale'; f.stageAt = now; return; }
      if (now - f.stageAt > 3500) endBagFlow('Không thấy nút Bán cá.', { error: true });
      return;
    }

    if (f.stage === 'wait_sale') {
      const current = readBagCount(true);
      const changed = current && f.before != null && current.count < f.before;
      const assumed = now - f.stageAt > 1800 && current && current.count <= Math.max(0, (f.before ?? current.count) - (f.selected || 0));
      if (changed || assumed) {
        const left = current ? current.count : null;
        stats.sold += f.selected || 0;
        updateStats();
        endBagFlow(`Đã bán cá ★1–2${left != null ? `; giỏ còn ${left}/${current.capacity}` : ''}.`, { sold: true });
        return;
      }
      if (now - f.stageAt > (current ? 5500 : 2200)) {
        stats.sold += f.selected || 0;
        updateStats();
        endBagFlow('Đã gửi lệnh bán; không đọc được số giỏ mới.', { sold: true });
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 10) Chẩn đoán
   * ------------------------------------------------------------------ */
  function describeTarget(t) {
    if (t === PAGE) return 'window';
    if (t === DOC) return 'document';
    const id = t.id ? '#' + t.id : '';
    const cls = (typeof t.className === 'string' && t.className.trim()) ? '.' + t.className.trim().split(/\s+/)[0] : '';
    return (t.tagName || '?').toLowerCase() + id + cls;
  }

  function diagnostic() {
    const btn = gameMainButton();
    const hs = handlerStatus(btn, true);
    const st = gameState(btn);
    const bag = readBagCount(true);
    const g = readGauge();
    const stam = parseStamina(pageNorm(0));
    const f = (h) => `${h.down}/${h.move}/${h.up}`;
    const seen = INPUT_BRIDGE.seen || {};
    const seenTxt = Object.keys(seen).map(k => `${k}=${seen[k]}`).join(', ') || '0';
    log(`Cách nạp: ${HOW} · exportFunction=${typeof exportFunction === 'function' ? 'có' : 'không'} · cloneInto=${typeof cloneInto === 'function' ? 'có' : 'không'} · hook=${bridge.mode}${bridge.ok ? '' : ' (' + (bridge.reason || 'lỗi') + ')'}.`);
    if (CONTENT && !CAN_EXPORT) log('⚠ Firefox content-script không có exportFunction/cloneInto nên KHÔNG hook được. Cần bật chế độ chèn vào trang (page) cho script, hoặc thử trình quản lý script khác.');
    log(`Realm: ${REALM} · nạp lúc readyState=${INSTALL.rs}, t=${INSTALL.t}ms · hook thấy ${INPUT_BRIDGE.total || 0} listener của trang (${seenTxt}).`);
    if (INSTALL.rs !== 'loading') log(`⚠ Script nạp khi trang đã tải xong (readyState=${INSTALL.rs}) nên KHÔNG bắt được listener game gắn trước đó. Hãy thoát ra rồi vào lại màn câu cá trong game, hoặc F5, rồi chẩn đoán lại.`);
    else if (!INPUT_BRIDGE.total) log('⚠ Hook chưa thấy listener nào của trang: script không chạy trong realm của trang. Thử F5; nếu vẫn vậy hãy gửi log này.');
    log(`Kiểm tra: state=${st}; mode=${currentMode()} (chọn: ${cfgMode}); cách ném=${(currentCombo() || {}).kind}/${(currentCombo() || {}).mode} (chọn: ${cfgCast}); handler down/move/up — trên nút=${f(hs.own)}, cả chuỗi=${f(hs.chain)}; giỏ=${bag ? `${bag.count}/${bag.capacity}` : '?'}${stam ? `; sức câu=${stam.value}/${stam.max}` : ''}${g ? `; gauge(${g.source}) cá=${g.fish.toFixed(2)} khung=${g.zone.toFixed(2)}` : ''}.`);
    if (btn) {
      const r = btn.getBoundingClientRect();
      log(`Nút: <${btn.tagName.toLowerCase()} class="${btn.className}"> ${Math.round(r.width)}×${Math.round(r.height)} tại (${Math.round(r.left)},${Math.round(r.top)}); viewport ${PAGE.innerWidth}×${PAGE.innerHeight}.`);
      const chain = chainOf(btn);
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'mousedown', 'click']) {
        const where = [];
        for (const t of chain) {
          const n = getCaptured(t, type).length;
          if (n) where.push(`${describeTarget(t)}×${n}`);
        }
        log(`  ${type}: ${where.join(', ') || '—'}`);
      }
    } else {
      log('Chưa thấy nút .fish-main (đã vào hồ câu chưa?).');
    }
    try {
      const labels = [...DOC.querySelectorAll('button')].filter(b => !(root && root.contains(b))).slice(0, 30).map(b => {
        const t = (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
        const c = typeof b.className === 'string' ? b.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `${t || '∅'}[${c}]`;
      });
      log('Các nút trên trang: ' + (labels.join(' | ') || '—'));
      const gio = (pageNorm(0).match(/gio[^]{0,26}/g) || []).slice(0, 4);
      log('Chữ có "giỏ": ' + (gio.join(' ¦ ') || '—'));
    } catch (_) {}
    log(`Canvas: ${DOC.querySelectorAll('canvas').length} · Probe vẽ: ${DRAW_PROBE.supported ? 'có' : 'không'} · Wake Lock: ${wakeLock ? 'đang giữ' : 'không'}.`);
    if (!btn) setStatus('Chưa vào hồ câu.', 'Chờ game');
    else if (!INPUT_BRIDGE.total || (INSTALL.rs !== 'loading' && !directStrong(btn))) setStatus('Hook chưa bắt được handler của game (script nạp muộn?). Thoát ra vào lại màn câu cá hoặc F5.', 'Cần nạp lại');
    else if (directAvailable(btn)) setStatus(`Có handler trực tiếp. Trạng thái: ${st}. Mode: ${currentMode()}.`, 'Kiểm tra OK');
    else setStatus('Không thấy handler pointer → dùng chế độ Mô phỏng. Bấm "Thử ném" để kiểm tra.', 'Kiểm tra');
  }

  /* ------------------------------------------------------------------ *
   * 11) Điều khiển chạy / dừng
   * ------------------------------------------------------------------ */
  async function acquireWake() {
    try {
      if (PAGE.navigator.wakeLock && !wakeLock) {
        wakeLock = await PAGE.navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
        log('Giữ màn hình sáng (Wake Lock).');
      }
    } catch (e) { log('Không bật được Wake Lock: ' + (e && e.message || e)); }
  }
  function releaseWake() {
    try { if (wakeLock) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  function start() {
    if (running) return;
    running = true;
    autoSell = !!(root && root.querySelector('#hh3df-autosell') && root.querySelector('#hh3df-autosell').checked);
    lastState = 'unknown';
    stateSince = Date.now();
    castRetryCount = 0;
    castPending = null;
    interfaceMisses = 0;
    cooldownUntil = 0;
    noSellUntil = 0;
    sinceSell = 0;
    reelHeld = false;
    reelMode = null;
    activePointerId = null;
    gaugePrev = null;
    gaugeVel = { fish: 0, zone: 0 };
    staminaLast = null;
    staminaTrend = null;
    bagFlow = null;
    if (loopHandle) clearInterval(loopHandle);
    loopHandle = setInterval(tick, CFG.pollMs);
    log('Auto bắt đầu.');
    setStatus('Đang đồng bộ game…', 'Đang chạy');
    acquireWake();
    tick();
  }

  function stop(reason) {
    running = false;
    bagFlow = null;
    castPending = null;
    gaugePrev = null;
    setProbeActive(false);
    if (reelHeld || activePointerId != null) releaseMainForReel().catch(() => {});
    reelHeld = false;
    activePointerId = null;
    if (loopHandle) { clearInterval(loopHandle); loopHandle = null; }
    releaseWake();
    setStatus(reason || 'Đã dừng', 'Đã dừng');
    log(reason || 'Đã dừng tool.');
  }

  async function tick() {
    if (!running || loopBusy) return;
    loopBusy = true;
    try {
      if (bagFlow) { await tickBagFlow(); return; }

      const now = Date.now();
      const btn = gameMainButton();
      if (!btn) {
        interfaceMisses++;
        setProbeActive(false);
        if (interfaceMisses % 12 === 1) setStatus('Chưa vào hồ câu.', 'Chờ game');
        if (interfaceMisses > 180) stop('Không tìm thấy nút câu.');
        return;
      }
      interfaceMisses = 0;

      const state = gameState(btn);
      setProbeActive(state === 'reel');

      if (state !== lastState) {
        const prev = lastState;
        lastState = state;
        stateSince = now;
        gaugePrev = null;
        gaugeVel = { fish: 0, zone: 0 };
        lastCanvasGauge = null;
        gaugeMisses = 0;
        hookAttempts = 0;
        const lbl = (btn.getAttribute('aria-label') || btn.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70);
        log(`Trạng thái: ${prev} → ${state}${(state === 'bite' || state === 'reel' || state === 'unknown') ? ` [${btn.className}] «${lbl}»` : ''}.`);
        if (prev === 'reel' && state !== 'reel') {
          if (reelHeld || activePointerId != null) await releaseMainForReel();
          reelStartedAt = 0;
          stats.reels++;
          sinceSell++;
          updateStats();
          cooldownUntil = Math.max(cooldownUntil, now + CFG.afterCatchCooldownMs);
        }
        if (state === 'reel') reelStartedAt = now;
      }

      // Xác nhận lệnh ném đã được game nhận (state rời "idle") hay chưa
      if (castPending) {
        if (state !== 'idle') castConfirmed();
        else if (now - castPending.at > CFG.castVerifyMs) { castFailed(); return; }
        else { setStatus('Chờ game xác nhận lệnh ném…', 'Đã ném'); return; }
      }

      if (now < cooldownUntil) {
        setStatus(`Chờ ${(cooldownUntil - now) / 1000 | 0}s trước lượt tiếp theo…`, 'Chờ kết quả');
        return;
      }

      if (state === 'idle') {
        if (reelHeld || activePointerId != null) await releaseMainForReel();
        gaugePrev = null;

        const stam = checkStamina();
        if (stam) { stop(stam); return; }

        const bag = readBagCount();
        if (autoSell && now >= noSellUntil) {
          const blindN = Math.max(0, Math.round(Number(blindInput && blindInput.value) || 0));
          if (bag && bag.count >= bag.capacity - CFG.sellMargin) { startBagFlow('auto', false); return; }
          if (!bag && blindN > 0 && sinceSell >= blindN) {
            log(`Không đọc được số cá trong giỏ → bán ★1–2 sau ${sinceSell} lần kéo.`);
            startBagFlow('auto', false);
            return;
          }
        }

        if (now - lastActionAt < CFG.actionCooldownMs) return;

        const ok = await performCastGesture(false);
        if (ok) {
          setStatus('Đã thả câu; chờ game chuyển sang Chờ cá…', 'Đã ném');
        } else {
          castRetryCount++;
          advanceCombo();
          if (castRetryCount > CFG.maxCastRetry) stop('Ném lỗi nhiều lần. Bấm "Chẩn đoán" rồi "Sao chép log".');
        }
        return;
      }

      if (state === 'wait') {
        castRetryCount = 0;
        if (now - stateSince > CFG.waitBiteTimeoutMs) { stop('Quá thời gian đợi cá.'); return; }
        setStatus(`Chờ cá ${Math.floor((now - stateSince) / 1000)}s`, 'Chờ cá');
        return;
      }

      if (state === 'bite') {
        if (now - lastHookAt >= CFG.hookDebounceMs) await hookFish();
        return;
      }

      if (state === 'reel') {
        if (!reelStartedAt) reelStartedAt = now;
        if (now - reelStartedAt > CFG.reelTimeoutMs) { stop('Quá thời gian kéo cá.'); return; }
        await adaptiveReel();
        return;
      }

      setStatus(`Trạng thái game chưa nhận diện: ${state}`, 'Đang đồng bộ');
    } catch (e) {
      console.error('[HH3D Fishing v' + VERSION + ']', e);
      stop(`Lỗi runtime: ${e && e.message || e}`);
    } finally {
      loopBusy = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * 12) Khởi động
   * ------------------------------------------------------------------ */
  function boot() {
    if (DOC.body) initUI();
    else setTimeout(boot, 20);
  }
  boot();

  // Nếu game (SPA) xóa mất panel thì dựng lại.
  setInterval(() => {
    try { if (DOC.body && !DOC.getElementById(ROOT_ID)) initUI(); } catch (_) {}
  }, 2000);

  DOC.addEventListener('visibilitychange', () => {
    if (running && DOC.visibilityState === 'visible') acquireWake();
  });

  PAGE.addEventListener('pagehide', () => {
    running = false;
    if (loopHandle) clearInterval(loopHandle);
    if (reelHeld || activePointerId != null) releaseMainForReel().catch(() => {});
    releaseWake();
  });
  } // end main

  /* ---- Bootstrap ----
   * Chrome / Tampermonkey / Violentmonkey page-mode: main() chạy luôn (đã ở realm của trang).
   * Firefox + Violentmonkey (sandbox content-script, có window.wrappedJSObject):
   *   1) thử nạp chính main() vào trang bằng <script> (kèm nonce nếu trang có CSP dùng nonce);
   *   2) nếu bị chặn mà có exportFunction/cloneInto: chạy main() ngay trong content-script và hook bằng exportFunction;
   *   3) nếu không có exportFunction: thử blob: URL, cuối cùng chạy tạm ở content-script (không hook được). */
  let wrapped;
  try { wrapped = window.wrappedJSObject; } catch (_) {}
  if (!wrapped) { main(false, 'direct'); return; }

  const parentReady = () => document.head || document.documentElement;
  const active = () => { try { return !!wrapped.__HH3D_FISH_ACTIVE__; } catch (_) { return false; } };
  const nonceOf = () => {
    try {
      const el = document.querySelector('script[nonce], style[nonce], link[nonce]');
      return el ? (el.nonce || el.getAttribute('nonce') || '') : '';
    } catch (_) { return ''; }
  };
  const inject = (kind) => {
    try {
      const code = '(' + main.toString() + ')(true,"' + kind + '");';
      const s = document.createElement('script');
      const nonce = nonceOf();
      if (nonce) { try { s.nonce = nonce; } catch (_) {} s.setAttribute('nonce', nonce); }
      if (kind === 'blob') s.src = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      else s.textContent = code;
      parentReady().appendChild(s);
      s.remove();
    } catch (_) {}
  };
  const hasExport = typeof exportFunction === 'function' && typeof cloneInto === 'function';
  const go = () => {
    inject('inline');
    if (active()) return;
    if (hasExport) { main(false, 'content'); return; }   // CSP chặn <script> nội tuyến: hook ngay bằng exportFunction
    inject('blob');
    let tries = 0;
    const iv = setInterval(() => {
      if (active()) { clearInterval(iv); return; }
      if (++tries >= 12) { clearInterval(iv); main(false, 'content'); }   // ≈0,5s mà trang vẫn chưa chạy bản nạp
    }, 40);
  };

  if (parentReady()) go();
  else {
    const mo = new MutationObserver(() => { if (parentReady()) { mo.disconnect(); go(); } });
    mo.observe(document, { childList: true });
  }
})();

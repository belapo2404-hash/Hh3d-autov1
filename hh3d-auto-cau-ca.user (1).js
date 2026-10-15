// ==UserScript==
// @name         HH3D | Auto Câu Cá Tiên Giới
// @namespace    hh3d-tien-gioi-fishing
// @version      1.0.2
// @description  Tự động câu cá Tiên Giới: ném, giật, kéo cá (điều khiển 60Hz tự học), bán/thả cá, lọc giữ cá hiếm / kỷ lục / cá nặng cho bảng xếp hạng. Chạy trên Violentmonkey/Tampermonkey (Firefox/Chrome, PC & Android).
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
  function main(isInjected, how, fatal) {
  'use strict';

  const PAGE = window;
  const DOC = PAGE.document;
  const VERSION = '1.0.2';
  const HOW = how || 'direct';
  const FATAL = typeof fatal === 'function' ? fatal : null;
  const reportErr = (e, stage) => {
    try { console.error('[HH3D]', stage, e); } catch (_) {}
    if (FATAL) { try { FATAL(e, stage); } catch (_) {} }
  };
  let uiFails = 0;
  let WRAPPED;
  try { WRAPPED = window.wrappedJSObject; } catch (_) {}
  const INSTALL = { t: Math.round(performance.now()), rs: DOC.readyState };

  // Chống nạp trùng (SPA có thể inject lại script).
  if (PAGE.__HH3D_FISH_ACTIVE__) return;
  try {
    Object.defineProperty(PAGE, '__HH3D_FISH_ACTIVE__', { value: VERSION, configurable: true });
  } catch (_) { PAGE.__HH3D_FISH_ACTIVE__ = VERSION; }

  const ROOT_ID = 'hh3d-fishing-tool-root';
  const STORE_KEY = 'hh3d_fish_cfg_v050';
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
  const DRAW_PROBE = { supported: false, installed: false, active: false, last: null, zone: null, fish: null, bars: [], fishes: [], usedLoose: 0 };
  const drawOrig = {};
  const drawPaths = new WeakMap();
  let drawProto = null;
  try { drawProto = (HOOKABLE && W.CanvasRenderingContext2D) ? W.CanvasRenderingContext2D.prototype : null; } catch (_) {}
  DRAW_PROBE.supported = !!drawProto;

  function drawAdd(ctx, x, y) {                 // chỉ ghi toạ độ thô (rất rẻ)
    const path = drawPaths.get(ctx);
    if (!path) return;
    if (x < path.minX) path.minX = x;
    if (x > path.maxX) path.maxX = x;
    if (y < path.minY) path.minY = y;
    if (y > path.maxY) path.maxY = y;
  }
  const tfPt = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

  function patchDraw() {
    if (!drawProto || DRAW_PROBE.installed) return;
    const probe = DRAW_PROBE;
    const wrappers = {
      beginPath: (orig) => function () {
        drawPaths.set(this, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, fish: false, arcs: 0, fl: null });
        return Reflect.apply(orig, this, arguments);
      },
      moveTo: (orig) => function (x, y) {
        drawAdd(this, x, y);
        return Reflect.apply(orig, this, arguments);
      },
      arcTo: (orig) => function (x1, y1, x2, y2) {
        drawAdd(this, x1, y1); drawAdd(this, x2, y2);
        const pa = drawPaths.get(this);
        if (pa) pa.arcs++;
        return Reflect.apply(orig, this, arguments);
      },
      ellipse: (orig) => function (x, y, rx, ry) {
        // Dấu vân tay icon cá trong mã nguồn game: ellipse(-2, 0, 8.5, 5.2)
        const path = drawPaths.get(this);
        if (path) {
          if (Math.abs(x + 2) < .01 && Math.abs(y) < .01 && Math.abs(rx - 8.5) < .01 && Math.abs(ry - 5.2) < .01) path.fish = true;
          // dự phòng: mọi hình elip nhỏ dạng thân cá (cá hiếm/lớn có thể dùng icon khác)
          if (rx >= 4 && rx <= 16 && ry >= 2.5 && ry <= 10) path.fl = { x, y };
        }
        return Reflect.apply(orig, this, arguments);
      },
      fill: (orig) => function () {
        try {
          const path = drawPaths.get(this);
          if (path) {
            const color = typeof this.fillStyle === 'string' ? this.fillStyle.toLowerCase() : '';
            const isZone = color === '#f2b04a' || color === '#78ffc8';
            const isFish = path.fish && (color === '#fff' || color === '#ffffff' || color === 'white');
            const wantBar = !isZone && path.arcs >= 3 && path.minX <= path.maxX;
            const wantFishL = !isFish && path.fl;
            if (isZone || isFish || wantBar || wantFishL) {
              const now = performance.now();
              const m = this.getTransform();             // chỉ gọi khi cần (vài lần/khung)
              const boxOf = () => {
                const c = [tfPt(m, path.minX, path.minY), tfPt(m, path.maxX, path.minY), tfPt(m, path.minX, path.maxY), tfPt(m, path.maxX, path.maxY)];
                const xs = c.map(q => q[0]), ys = c.map(q => q[1]);
                const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
                return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, h: maxY - minY, w: maxX - minX };
              };
              if ((isZone || wantBar) && path.minX <= path.maxX) {
                const b = boxOf();
                if (isZone && b.h >= 8 && b.h < 550 && b.w >= 8 && b.w < 120) {
                  probe.zone = { x: b.x, y: b.y, height: b.h, at: now, canvas: this.canvas };
                }
                if (b.h >= 20 && b.h < 700 && b.w >= 8 && b.w < 120) {
                  const bars = probe.bars;
                  while (bars.length && now - bars[0].at > 120) bars.shift();
                  if (bars.length > 14) bars.shift();
                  bars.push({ x: b.x, y: b.y, h: b.h, w: b.w, color, at: now, canvas: this.canvas });
                }
              }
              if (isFish) {
                const q = tfPt(m, -2, 0);
                probe.fish = { x: q[0], y: q[1], at: now, canvas: this.canvas };
                const fs = probe.fishes;
                while (fs.length && now - fs[0].at > 120) fs.shift();
                fs.push({ x: q[0], y: q[1], color, at: now, canvas: this.canvas });
              } else if (wantFishL) {
                const q = tfPt(m, path.fl.x, path.fl.y);
                const fs = probe.fishes;
                while (fs.length && now - fs[0].at > 120) fs.shift();
                if (fs.length > 10) fs.shift();
                fs.push({ x: q[0], y: q[1], color, at: now, canvas: this.canvas });
              }
              if (probe.zone && probe.fish && probe.zone.canvas === probe.fish.canvas &&
                  Math.abs(probe.zone.at - probe.fish.at) < 75 && Math.abs(probe.zone.x - probe.fish.x) < 45) {
                probe.last = { fishY: probe.fish.y, zoneY: probe.zone.y, zoneHeight: probe.zone.height, at: now };
              }
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
    afterCatchCooldownMs: 2000,
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
  let holdMsInput = null, blindInput = null, modeSelect = null, castSelect = null, sellSelect = null, reelSelect = null;

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
  let sellAtN = 0;            // 0 = tự động (còn 2 chỗ trống)
  let sellFailStreak = 0;
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
  let cfgSell = 'all';        // 'all' = bán hết | 'low' = chỉ ★1–2
  let cfgCast = 'auto';       // 'auto' | 'tap' | 'drag'
  let autoCast = null;
  let castComboIdx = 0;       // chỉ số cách ném (kiểu/chế độ) đang dùng trong castCombos()
  let forcedCombo = null;     // dùng cho nút "Thử ném"
  let hookPref = 0;           // bước giật từng thành công gần nhất (thử trước)
  let forcedCast = null;
  let lastGoodCast = '';
  let biteObs = null, observedBtn = null;
  let bagFlow = null;
  // Bộ lọc cá: chỉ bán / thả những con KHÔNG thuộc nhóm "giữ lại".
  const GOAL = { rare: false, rareMin: 4, badge: false, kg: 0, rest: 'sell', stopN: 0, skip: false };
  const goalActive = () => !!(GOAL.rare || GOAL.badge || GOAL.kg > 0);
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
  const stats = { casts: 0, hooks: 0, reels: 0, sold: 0, caught: 0, lost: 0, skipped: 0, kept: 0 };

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
        cast: cfgCast,
        sell: cfgSell,
        goal: GOAL,
        reel: cfgReel,
        sellAt: sellAtN
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
    if (['all', 'low'].includes(saved.sell)) cfgSell = saved.sell;
    if (['auto', 'soft', 'std', 'hard'].includes(saved.reel)) cfgReel = saved.reel;
    sellAtN = clamp(Math.round(Number(saved.sellAt)) || 0, 0, 99);
    if (saved.goal && typeof saved.goal === 'object') {
      const g = saved.goal;
      GOAL.rare = !!g.rare; GOAL.badge = !!g.badge; GOAL.skip = !!g.skip;
      GOAL.rareMin = clamp(Math.round(Number(g.rareMin)) || 4, 1, 9);
      GOAL.kg = Math.max(0, Number(g.kg) || 0);
      GOAL.stopN = clamp(Math.round(Number(g.stopN)) || 0, 0, 99);
      GOAL.rest = g.rest === 'release' ? 'release' : 'sell';
    }

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
        #${ROOT_ID} details.fish-sec { margin:8px 0; border:1px solid #3a4a49; border-radius:9px; padding:2px 8px 6px; background:#1b1b24; }
        #${ROOT_ID} details.fish-sec > summary { cursor:pointer; font-weight:800; font-size:12px; color:#9fe6d3; padding:6px 0; list-style:none; }
        #${ROOT_ID} details.fish-sec > summary::-webkit-details-marker { display:none; }
        #${ROOT_ID} details.fish-sec > summary::after { content:' ▾'; opacity:.7; }
        #${ROOT_ID} .fish-count-row input[type=number] { width:64px; min-width:64px; }
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
        <label><input type="checkbox" id="hh3df-autosell" ${autoSell ? 'checked' : ''}> Tự bán khi giỏ gần đầy</label>

        <details class="fish-sec" open>
          <summary>🎯 Ném cần</summary>
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
        </details>

        <details class="fish-sec">
          <summary>🏆 Lọc cá · Bán cá</summary>
          <div class="fish-note" style="margin-top:2px">Bật bất kỳ mục "Giữ lại" nào → khi bán, tool chỉ bán/thả những con KHÔNG thuộc nhóm giữ.</div>
          <label><input type="checkbox" id="hh3df-keep-rare" ${GOAL.rare ? 'checked' : ''}> Giữ cá hiếm: từ ★ <input type="number" id="hh3df-rare-min" min="1" max="9" value="${GOAL.rareMin}" style="width:52px;min-width:52px;padding:4px;border-radius:6px;border:1px solid #585766;background:#121219;color:#fff"></label>
          <label><input type="checkbox" id="hh3df-keep-badge" ${GOAL.badge ? 'checked' : ''}> Giữ cá kỷ lục / huy chương / loài mới</label>
          <div class="fish-count-row" title="Cá nặng từ mức này trở lên được giữ lại (hợp để leo bảng xếp hạng). 0 = tắt."><span>Giữ cá nặng ≥ (kg):</span><input type="number" id="hh3df-keep-kg" min="0" step="0.5" value="${GOAL.kg}"></div>
          <div class="fish-count-row"><span>Cá không giữ:</span>
            <select id="hh3df-rest"><option value="sell">Bán</option><option value="release">Thả về hồ</option></select>
          </div>
          <div class="fish-count-row" title="Tự dừng khi trong giỏ đã có đủ số cá giữ lại. 0 = không dừng."><span>Dừng khi giữ được (con):</span><input type="number" id="hh3df-stop-n" min="0" max="99" value="${GOAL.stopN}"></div>
          <div class="fish-count-row" title="Tool chỉ lọc/bán khi số cá trong giỏ đạt mức này. Để trống = tự động (còn 2 chỗ trống). Đặt 1 = lọc sau mỗi lần câu."><span>Bán/lọc khi giỏ ≥ (con):</span><input type="number" id="hh3df-sell-at" min="0" max="99" step="1" value="${sellAtN || ''}" placeholder="auto"></div>
          <div class="fish-row"><button type="button" class="fish-action fish-small" id="hh3df-dry">🧪 Thử bộ lọc (không bán gì)</button></div>
          <label title="Nếu game hiện độ hiếm (★) ngay lúc kéo, bỏ qua cá thấp hơn mức hiếm đã chọn để đỡ tốn thời gian."><input type="checkbox" id="hh3df-skip" ${GOAL.skip ? 'checked' : ''}> Bỏ qua cá thường khi kéo (thử nghiệm)</label>
          <div class="fish-count-row"><span>Khi không lọc:</span>
            <select id="hh3df-sell-mode">
              <option value="all">Bán hết cá trong giỏ</option>
              <option value="low">Chỉ bán cá ★1–2</option>
            </select>
          </div>
          <div class="fish-count-row" title="Dùng khi tool không đọc được số cá trong giỏ. 0 = tắt."><span>Bán mỗi (lần kéo):</span><input type="number" id="hh3df-blind-n" min="0" max="50" step="1" value="${blindN}"></div>
        </details>

        <details class="fish-sec">
          <summary>⚙️ Nâng cao</summary>
          <div class="fish-count-row"><span>Chế độ nhập:</span>
            <select id="hh3df-mode">
              <option value="auto">Tự động</option>
              <option value="direct">Trực tiếp</option>
              <option value="dispatch">Mô phỏng</option>
            </select>
          </div>
          <div class="fish-count-row"><span>Độ nhạy kéo cá:</span>
            <select id="hh3df-reel">
              <option value="auto">Tự động (tự học)</option>
              <option value="soft">Êm</option>
              <option value="std">Chuẩn</option>
              <option value="hard">Gắt</option>
            </select>
          </div>
        </details>

        <div class="fish-row"><button type="button" class="fish-action fish-sell" id="hh3df-sell">🧺 Bán cá ngay</button></div>
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

    try {
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
    sellSelect = root.querySelector('#hh3df-sell-mode');
    sellSelect.value = cfgSell;
    sellSelect.addEventListener('change', e => { cfgSell = e.target.value; saveCfg(); log(`Khi bán: ${cfgSell === 'all' ? 'bán hết cá trong giỏ' : 'chỉ bán cá ★1–2'}.`); });
    reelSelect = root.querySelector('#hh3df-reel');
    reelSelect.value = cfgReel;
    reelSelect.addEventListener('change', e => { cfgReel = e.target.value; saveCfg(); log(`Độ nhạy kéo cá: ${cfgReel}.`); });
    const readGoal = () => {
      GOAL.rare = !!root.querySelector('#hh3df-keep-rare').checked;
      GOAL.rareMin = clamp(Math.round(Number(root.querySelector('#hh3df-rare-min').value)) || 4, 1, 9);
      GOAL.badge = !!root.querySelector('#hh3df-keep-badge').checked;
      GOAL.kg = Math.max(0, Number(root.querySelector('#hh3df-keep-kg').value) || 0);
      GOAL.rest = root.querySelector('#hh3df-rest').value === 'release' ? 'release' : 'sell';
      GOAL.stopN = clamp(Math.round(Number(root.querySelector('#hh3df-stop-n').value)) || 0, 0, 99);
      GOAL.skip = !!root.querySelector('#hh3df-skip').checked;
      saveCfg();
      log(goalActive()
        ? `Lọc cá: giữ ${[GOAL.rare && `hiếm ★≥${GOAL.rareMin}`, GOAL.badge && 'kỷ lục/huy chương/loài mới', GOAL.kg > 0 && `nặng ≥${GOAL.kg}kg`].filter(Boolean).join(' + ')}; còn lại ${GOAL.rest === 'release' ? 'thả về hồ' : 'bán'}${GOAL.stopN ? `; dừng khi giữ được ${GOAL.stopN}` : ''}.`
        : ((GOAL.stopN || GOAL.skip) ? 'Lọc cá: CHƯA chọn nhóm cần giữ (hiếm / huy hiệu / kg) nên chưa có tác dụng.' : 'Lọc cá: TẮT (bán hết).'));
    };
    root.querySelector('#hh3df-rest').value = GOAL.rest;
    for (const id of ['keep-rare', 'rare-min', 'keep-badge', 'keep-kg', 'rest', 'stop-n', 'skip']) {
      root.querySelector('#hh3df-' + id).addEventListener('change', readGoal);
    }

    root.querySelector('#hh3df-dry').addEventListener('click', dryRunFilter);
    root.querySelector('#hh3df-sell-at').addEventListener('change', (e) => {
      sellAtN = clamp(Math.round(Number(e.target.value)) || 0, 0, 99);
      saveCfg();
      log(sellAtN ? `Bán/lọc khi giỏ ≥ ${sellAtN} con.` : 'Bán/lọc khi giỏ gần đầy (tự động).');
    });
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
      log(`Tự bán cá: ${autoSell ? 'BẬT' : 'TẮT'}.`);
    });
    root.querySelector('#hh3df-sell').addEventListener('click', () => startBagFlow('manual', !running));
    root.querySelector('#hh3df-check').addEventListener('click', diagnostic);
    root.querySelector('#hh3df-test-cast').addEventListener('click', testCast);
    root.querySelector('#hh3df-copy').addEventListener('click', copyLog);
    root.querySelector('#hh3df-clear').addEventListener('click', () => { logLines = []; logEl.textContent = 'Đã xóa log.'; });

    updateStats();
    log(`Đã nạp v${VERSION} · Hook: ${INPUT_BRIDGE.ok ? 'OK' : 'LỖI'} · Probe vẽ: ${DRAW_PROBE.supported ? 'OK' : 'không'}.`);
    setStatus('Bấm ▶ Bắt đầu để chạy.', 'Sẵn sàng');
    } catch (e) {
      // Có ít nhất nút 🎣 hiện ra; báo lỗi để biết đoạn nào hỏng.
      reportErr(e, 'initUI.bind');
    }
    loadToast();
  }

  // Thông báo nhỏ 2,5 giây xác nhận script đã chạy.
  function loadToast() {
    try {
      if (!DOC.body || DOC.getElementById('hh3d-toast')) return;
      const t = DOC.createElement('div');
      t.id = 'hh3d-toast';
      t.textContent = `🎣 HH3D v${VERSION} đã nạp`;
      t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);z-index:2147483647;background:#102a2d;color:#eafffa;border:1px solid #5bcaaf;border-radius:16px;padding:7px 14px;font:700 12px system-ui,sans-serif;pointer-events:none;opacity:.95';
      DOC.body.appendChild(t);
      setTimeout(() => { try { t.remove(); } catch (_) {} }, 2500);
    } catch (_) {}
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
    if (logEl && PAGE.__HH3D_DEBUG_LOG__) logEl.setAttribute('data-full', logLines.slice().reverse().join('\n'));   // chỉ dùng khi kiểm thử
  }

  function updateStats() {
    if (!statsEl) return;
    const st = staminaLast ? ` · Sức câu ${staminaLast.value}/${staminaLast.max}` : '';
    statsEl.textContent = `Ném ${stats.casts} · Giật ${stats.hooks} · Được ${stats.caught} · Hụt ${stats.lost}${stats.skipped ? ` · Bỏ qua ${stats.skipped}` : ''} · Đã bán ${stats.sold} con${st}`;
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

  const colorSat = (c) => {
    if (!c) return 0.3;
    let r, g, b, m;
    if ((m = /^#([0-9a-f]{3})$/.exec(c))) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
    else if ((m = /^#([0-9a-f]{6})/.exec(c))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
    else if ((m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c))) { r = +m[1]; g = +m[2]; b = +m[3]; }
    else return 0.3;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx ? (mx - mn) / mx : 0;
  };

  // Nhận diện dự phòng: không dựa vào màu / hình icon cụ thể (cho cá hiếm, cá lớn có giao diện khác).
  function readLooseGauge() {
    const now = performance.now();
    const bars = DRAW_PROBE.bars.filter(b => now - b.at < 80);
    if (!bars.length) return null;
    const sorted = bars.slice().sort((a, b) => b.h - a.h);
    let zone = null;
    if (sorted.length >= 2) {
      const track = sorted[0];
      const inner = sorted.slice(1).filter(b => b.h < track.h * 0.92 && Math.abs(b.x - track.x) <= Math.max(14, track.w) &&
        b.y >= track.y - track.h / 2 - 6 && b.y <= track.y + track.h / 2 + 6);
      inner.sort((a, b) => (colorSat(b.color) - colorSat(a.color)) || (b.h - a.h));
      zone = inner[0] || null;
    } else if (sorted[0].h < 420) zone = sorted[0];
    if (!zone) return null;
    const fishes = DRAW_PROBE.fishes.filter(f => now - f.at < 80 && Math.abs(f.x - zone.x) < 70);
    if (!fishes.length) return null;
    fishes.sort((a, b) => Math.abs(a.x - zone.x) - Math.abs(b.x - zone.x));
    const f = fishes[0];
    return {
      fish: f.y, zone: zone.y, width: zone.h, lo: zone.y - zone.h / 2, hi: zone.y + zone.h / 2,
      now: Math.max(zone.at, f.at), source: 'draw2d', loose: true, zc: zone.color || '?', fc: f.color || '?'
    };
  }

  function readDrawGauge() {
    const now = performance.now();
    const d = DRAW_PROBE.last;
    if (d && now - d.at <= 150 && d.zoneHeight >= 8) {
      return { fish: d.fishY, zone: d.zoneY, width: d.zoneHeight, lo: d.zoneY - d.zoneHeight / 2, hi: d.zoneY + d.zoneHeight / 2, now: d.at, source: 'draw2d' };
    }
    const l = readLooseGauge();
    if (l) { DRAW_PROBE.usedLoose++; return l; }
    if (d && now - d.at <= 350 && d.zoneHeight >= 8) {
      return { fish: d.fishY, zone: d.zoneY, width: d.zoneHeight, lo: d.zoneY - d.zoneHeight / 2, hi: d.zoneY + d.zoneHeight / 2, now: d.at, source: 'draw2d' };
    }
    return null;
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

  /* ---- Bộ điều khiển thanh kéo cá ----
   * Mô hình  dv/dt = α(lệnh) − β·v  (bao trùm cả game kiểu "gia tốc" lẫn kiểu "vận tốc có độ trễ").
   * Tự học (α_giữ, α_thả, β) bằng RLS rồi mỗi khung chọn GIỮ/THẢ theo dự đoán chi phí ~HOR giây tới.
   * Toạ độ "up": lớn hơn = cao hơn. Mô hình học được giữ qua các lần kéo cá.
   * coast(): khi mất tín hiệu thanh cá vài khung, tiếp tục điều khiển bằng dự đoán thay vì thả ngay. */
  function createReelController(opts) {
    opts = opts || {};
    const LAT = opts.latMs != null ? opts.latMs : 32;
    let HOR = opts.horizon != null ? opts.horizon : 0.14;
    const MU = opts.mu != null ? opts.mu : 0.2;
    const HYST = opts.hyst != null ? opts.hyst : 0.01;
    const MIN_DWELL = opts.minDwell != null ? opts.minDwell : 16;
    const LAMBDA = opts.lambda != null ? opts.lambda : 0.996;
    const STEP = 1 / 60;
    const M = { scale: null, th: null, P: null };
    const S = {};
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    function reset() {
      S.prev = null; S.zv = 0; S.fv = 0; S.hf = 0; S.hold = false; S.hist = [{ t: -1e9, hold: false }];
      S.lastSwitch = -1e9; S.zMin = Infinity; S.zMax = -Infinity; S.n = 0; S.w = null; S.dtAvg = 0; S.ovr = 0;
    }
    const latNow = () => Math.max(LAT, Math.min(150, (S.dtAvg || 0) * 1200));   // máy chậm/khung thưa → độ trễ lớn hơn
    reset();
    function cmdAt(t) {
      for (let i = S.hist.length - 1; i >= 0; i--) if (S.hist[i].t <= t) return S.hist[i].hold;
      return false;
    }
    function initModel(w) {
      M.scale = w;
      M.th = [10, -10, 0];
      M.P = [[100, 0, 0], [0, 100, 0], [0, 0, 100]];
    }
    function rls(phi, y) {
      const P = M.P, th = M.th;
      const Pphi = [0, 1, 2].map(i => P[i][0] * phi[0] + P[i][1] * phi[1] + P[i][2] * phi[2]);
      const den = LAMBDA + phi[0] * Pphi[0] + phi[1] * Pphi[1] + phi[2] * Pphi[2];
      const k = Pphi.map(v => v / den);
      const lim = 2 * Math.max(Math.abs(th[0]), Math.abs(th[1])) + 5;
      const err = cl(y - (th[0] * phi[0] + th[1] * phi[1] + th[2] * phi[2]), -lim, lim);   // chống nhiễu đột biến làm hỏng mô hình
      for (let i = 0; i < 3; i++) th[i] += k[i] * err;
      const phiP = [0, 1, 2].map(j => phi[0] * P[0][j] + phi[1] * P[1][j] + phi[2] * P[2][j]);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) P[i][j] = (P[i][j] - k[i] * phiP[j]) / LAMBDA;
      th[0] = cl(th[0], 3, 150); th[1] = cl(th[1], -150, -3); th[2] = cl(th[2], 0, 40);
      if (th[0] - th[1] < 8) { const mid = (th[0] + th[1]) / 2; th[0] = mid + 4; th[1] = mid - 4; }   // GIỮ phải khác THẢ rõ rệt
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (P[i][j] > 1e4) P[i][j] = 1e4;
    }
    // Quyết định GIỮ/THẢ cho trạng thái (z, f, w) tại thời điểm t (đơn vị đã chia theo scale).
    function decide(t, z, f, w, sc) {
      const known = (S.zMax - S.zMin) > 3 * w;
      const th = M.th;
      const lat = latNow();
      function cost(u) {
        let zz = z, v = S.zv, c = 0;
        const N = Math.round(HOR / STEP);
        for (let j = 1; j <= N; j++) {
          const tau = j * STEP;
          const cmd = tau <= lat / 1000 ? cmdAt(t + tau * 1000 - lat) : u;
          v += ((cmd ? th[0] : th[1]) - th[2] * v) * STEP;
          zz += v * STEP;
          if (known) {
            if (zz > S.zMax + 0.2 * w) { zz = S.zMax + 0.2 * w; v = Math.min(v, 0); }
            if (zz < S.zMin - 0.2 * w) { zz = S.zMin - 0.2 * w; v = Math.max(v, 0); }
          }
          const e = (zz - (f + S.fv * tau)) / w;
          c += e * e;
        }
        const vr = (v - S.fv) * HOR / w;
        return c / N + MU * vr * vr;
      }
      const cH = cost(true), cF = cost(false);
      const m = HYST * Math.max(0.05, Math.min(cH, cF)) + 1e-4;
      const wantHold = S.hold ? !(cF < cH - m) : (cH < cF - m);
      let hold = S.hold;
      if (wantHold !== S.hold && (t - S.lastSwitch) >= MIN_DWELL) {
        hold = wantHold; S.lastSwitch = t; S.hist.push({ t, hold });
        if (S.hist.length > 60) S.hist.splice(0, S.hist.length - 60);
      }
      // Chốt an toàn (độc lập mô hình): cá còn xa khung mà khung không tiến về phía cá → ép đi về phía cá.
      // Tránh kẹt "mô hình sai → không bao giờ GIỮ" và luôn tạo dữ liệu mới để học lại.
      const eNow = f - z;
      if (Math.abs(eNow) > 1.5 * w && S.zv * Math.sign(eNow) < 1.0 * w) {
        const need = eNow > 0;
        if (hold !== need) {
          hold = need; S.lastSwitch = t; S.hist.push({ t, hold });
          if (S.hist.length > 60) S.hist.splice(0, S.hist.length - 60);
          S.ovr = (S.ovr || 0) + 1;
        }
      }
      S.hold = hold;
      return { hold, zv: S.zv * sc, fv: S.fv * sc, aH: th[0] * sc, aF: th[1] * sc, beta: th[2], aHn: th[0], aFn: th[1], ovr: S.ovr || 0 };
    }
    function step(smp) {          // smp = { t(ms), fish, zone, w }
      if (M.scale == null) initModel(Math.max(1e-6, smp.w));
      const sc = M.scale;
      const z = smp.zone / sc, f = smp.fish / sc, w = Math.max(1e-6, smp.w / sc);
      const t = smp.t;
      const p = S.prev;
      if (p) {
        const dt = (t - p.t) / 1000;
        if (dt >= 0.006 && dt < 0.4) {
          const tf = 0.04;
          const af = 1 - Math.exp(-dt / tf);
          const zvm = (z - p.z) / dt, fvm = (f - p.f) / dt;
          const aF = (zvm - S.zv) / tf;
          S.zv += af * (zvm - S.zv);
          S.fv += (1 - Math.exp(-dt / 0.05)) * (fvm - S.fv);
          S.dtAvg = S.dtAvg ? S.dtAvg + 0.1 * (dt - S.dtAvg) : dt;
          const he = cmdAt(t - latNow()) ? 1 : 0;
          S.hf += af * (he - S.hf);
          S.n++;
          const nearEdge = (z - S.zMin < 0.5 * w) || (S.zMax - z < 0.5 * w);
          if (S.n > 8 && !nearEdge && dt <= 0.05) rls([S.hf, 1 - S.hf, -S.zv], aF);
          S.fv = cl(S.fv, -9 * w, 9 * w);
        } else if (dt >= 0.4) { S.zv = 0; S.fv = 0; }
      }
      S.prev = { t, z, f }; S.w = w;
      S.zMin = Math.min(S.zMin, z); S.zMax = Math.max(S.zMax, z);
      return decide(t, z, f, w, sc);
    }
    // Mất tín hiệu: ngoại suy từ mẫu thật gần nhất bằng mô hình đã học.
    function coast(t) {
      const p = S.prev;
      if (!p || M.th == null || S.w == null) return null;
      const dt = (t - p.t) / 1000;
      if (dt <= 0 || dt > 0.6) return null;
      const th = M.th, sc = M.scale;
      const a = (S.hold ? th[0] : th[1]) - th[2] * S.zv;
      const z = p.z + S.zv * dt + 0.5 * a * dt * dt;
      const f = p.f + S.fv * dt * 0.8;       // cá có thể đổi hướng → giảm dần
      return decide(t, z, f, S.w, sc);
    }
    function resetModel() { M.scale = null; M.th = null; M.P = null; }
    return { reset, resetModel, step, coast, setHorizon(h) { HOR = h; }, getHorizon() { return HOR; } };
  }

  const reelCtls = {};
  const ctlFor = (source) => reelCtls[source] || (reelCtls[source] = createReelController());

  /* ---- Tự tối ưu độ nhạy kéo cá (bandit theo độ khó của thanh) ---- */
  const ARMS = [0.10, 0.14, 0.19, 0.26];     // tầm nhìn xa (giây): nhỏ = gắt, lớn = êm
  const ARM_DEFAULT = 1;
  const FIXED_ARM = { soft: 2, std: 1, hard: 0 };
  const TUNE_KEY = 'hh3d_fish_tune_v1';
  const TUNE = { stats: {}, wRef: {} };
  let cfgReel = 'auto';        // 'auto' | 'soft' | 'std' | 'hard'
  try { const raw = PAGE.localStorage.getItem(TUNE_KEY); if (raw) Object.assign(TUNE, JSON.parse(raw)); } catch (_) {}
  function saveTune() { try { PAGE.localStorage.setItem(TUNE_KEY, JSON.stringify(TUNE)); } catch (_) {} }
  function tierOf(src, w) {
    const ref = Math.max(TUNE.wRef[src] || 0, w);
    TUNE.wRef[src] = ref;
    const r = w / ref;
    return r < 0.62 ? 0 : (r < 0.85 ? 1 : 2);   // 0 = khung nhỏ (khó), 2 = khung lớn (dễ)
  }
  function pickArm(tier) {
    if (cfgReel !== 'auto') return FIXED_ARM[cfgReel] != null ? FIXED_ARM[cfgReel] : ARM_DEFAULT;
    const st = TUNE.stats[tier] || {};
    const mean = (i) => (st[i] && st[i].n) ? st[i].sum / st[i].n : null;
    const tried = ARMS.map((_, i) => (st[i] ? st[i].n : 0));
    const under = ARMS.map((_, i) => i).filter(i => tried[i] < 2);
    if (under.length && Math.random() < 0.5) return under[Math.floor(Math.random() * under.length)];
    if (Math.random() < 0.12) return Math.floor(Math.random() * ARMS.length);
    let best = ARM_DEFAULT, bm = mean(ARM_DEFAULT);
    if (bm == null) bm = 0.5;
    ARMS.forEach((_, i) => { const m = mean(i); if (m != null && tried[i] >= 2 && m > bm + 0.02) { best = i; bm = m; } });
    return best;
  }

  let holdWanted = false, holdBusy = false;
  let reelLoopOn = false, reelRaf = 0, reelLast = { fish: null, zone: null };
  let reelStatusAt = 0, reelSamples = 0, reelT0 = 0, reelFirst = true;
  let abandonReel = false;
  let textBase = null, fishTextLogs = 0;
  function textSnapshot() {
    const set = new Set();
    try {
      const walker = DOC.createTreeWalker(DOC.body, PAGE.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        const v = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (v.length < 2 || v.length > 80) continue;
        const pe = n.parentElement;
        if (pe && !pe.closest('#' + ROOT_ID)) set.add(v);
      }
    } catch (_) {}
    return set;
  }
  // Sau khi bắt đầu kéo ~0,45s: xem game có hiện thêm chữ nào (tên cá / độ hiếm ★) không.
  function analyzeFishText() {
    try {
      if (!running || lastState !== 'reel' || !textBase) return;
      const now = textSnapshot();
      const fresh = [...now].filter(t => !textBase.has(t) && !/^[\d\s.,:%/+\-–]+$/.test(t)).slice(0, 6);
      textBase = null;
      const joined = fresh.join(' ');
      const m = /★\s*(\d)/.exec(joined) || /(\d)\s*sao\b/i.exec(normalize(joined));
      const stars = m ? Number(m[1]) : null;
      RS.stars = stars;
      if (fresh.length && (fishTextLogs < 4 || stars != null)) {
        fishTextLogs++;
        log(`Chữ mới khi kéo: ${fresh.map(t => '«' + t.slice(0, 40) + '»').join(' ')}${stars != null ? ` → độ hiếm ★${stars}` : ''}.`);
      }
      if (GOAL.skip && GOAL.rare && stars != null && stars < GOAL.rareMin && !abandonReel) {
        abandonReel = true;
        setHold(false);
        log(`⏭ Bỏ qua cá ★${stars} (< ★${GOAL.rareMin}).`);
      }
    } catch (_) {}
  }
  const RS = { stars: null, t0: 0, last: 0, tot: 0, inT: 0, err: 0, src: '', w: 0, arm: -1, tier: 1, bag0: null, loose: 0, miss: 0, looseLogged: false, ratioNow: 0 };

  function reelBegin() {
    Object.assign(RS, { stars: null, t0: performance.now(), last: 0, tot: 0, inT: 0, err: 0, src: '', w: 0, arm: -1, tier: 1, loose: 0, miss: 0, looseLogged: false, ratioNow: 0, recovered: false, aH: 0, aF: 0, ovr: 0 });
    const b = readBagCount(false);
    RS.bag0 = b ? b.count : null;
    abandonReel = false;
  }

  // Tổng kết một lần kéo cá + cập nhật bộ tự tối ưu.
  function reelFinish() {
    const snap = Object.assign({}, RS);
    const dur = (performance.now() - snap.t0) / 1000;
    const ratio = snap.tot > 0 ? snap.inT / snap.tot : 0;
    const err = snap.tot > 0 ? snap.err / snap.tot : 0;
    const wasAbandoned = abandonReel;
    setTimeout(() => {
      let ok = null;
      const b1 = readBagCount(true);
      if (snap.bag0 != null && b1) ok = b1.count > snap.bag0;
      const guessed = ok == null;
      if (guessed) ok = ratio >= 0.5 && dur >= 2.5;
      if (wasAbandoned) ok = false;
      if (snap.src && reelCtls[snap.src] && snap.tot > 1 && (wasAbandoned || ratio < 0.3)) reelCtls[snap.src].resetModel();   // bỏ cá / lần kéo kém → đừng giữ mô hình lệch
      if (wasAbandoned) stats.skipped++; else if (ok) stats.caught++; else stats.lost++;
      updateStats();
      const fmtW = snap.src === 'draw2d' ? snap.w.toFixed(0) + 'px' : snap.w.toFixed(2);
      log(`Kéo xong ${dur.toFixed(1)}s · trong khung ${(ratio * 100).toFixed(0)}% · lệch TB ${err.toFixed(2)}×khung · ${snap.src || '?'}${snap.loose ? ' (dự phòng)' : ''} · khung ${fmtW} · bậc ${snap.tier}/${snap.arm >= 0 ? ARMS[snap.arm] + 's' : '-'} · mất tín hiệu ${snap.miss} khung · mô hình giữ ${(snap.aH || 0).toFixed(0)}/thả ${(snap.aF || 0).toFixed(0)}${snap.ovr ? ` · chốt an toàn ${snap.ovr}` : ''} → ${wasAbandoned ? '⏭ bỏ cá' : (ok ? '✅ câu được' : '❌ hụt')}${guessed && !wasAbandoned ? ' (ước đoán)' : ''}.`);
      if (!wasAbandoned && snap.arm >= 0 && cfgReel === 'auto' && snap.tot > 1) {
        const st = TUNE.stats[snap.tier] || (TUNE.stats[snap.tier] = {});
        const a = st[snap.arm] || (st[snap.arm] = { n: 0, sum: 0 });
        a.n++; a.sum += 0.65 * (ok ? 1 : 0) + 0.35 * ratio;
        saveTune();
      }
    }, 800);
  }

  // Gửi lệnh GIỮ/THẢ tuần tự (không bao giờ chồng lệnh nhau).
  async function syncHold() {
    if (holdBusy) return;
    holdBusy = true;
    try {
      for (let i = 0; i < 4 && reelHeld !== holdWanted; i++) {
        if (holdWanted) await pressMainForReel(); else await releaseMainForReel();
      }
    } catch (_) {} finally { holdBusy = false; }
  }
  function setHold(v) {
    holdWanted = !!v;
    if (reelHeld !== holdWanted && !holdBusy) syncHold();
  }

  function reelStep() {
    if (!running || lastState !== 'reel') return;
    if (abandonReel) { if (holdWanted) setHold(false); return; }
    const g = readGauge();
    if (!g) {
      gaugeMisses++; RS.miss++;
      const c0 = RS.src ? reelCtls[RS.src] : null;
      if (c0 && gaugeMisses >= 2 && gaugeMisses < 30) {            // ~0,5s: điều khiển bằng dự đoán
        const o = c0.coast(performance.now());
        if (o) setHold(o.hold);
      } else if (gaugeMisses >= 30 && holdWanted) setHold(false);
      if (gaugeMisses === 8 || gaugeMisses % 120 === 0) {
        log(`Không có gauge · Canvas2D=${DRAW_PROBE.supported ? 'có' : 'không'}, tuổi=${DRAW_PROBE.last ? Math.round(performance.now() - DRAW_PROBE.last.at) + 'ms' : 'chưa có'}, thanh=${DRAW_PROBE.bars.length}, cá=${DRAW_PROBE.fishes.length}.`);
        setStatus('Mất dữ liệu thanh cá, đang dự đoán.', 'Thiếu tín hiệu gauge');
      }
      return;
    }
    gaugeMisses = 0;
    if (g.source !== 'canvas' && g.fish === reelLast.fish && g.zone === reelLast.zone) return;   // game chưa vẽ khung mới
    if (g.source === 'canvas' && g.now === reelLast.now) return;
    reelLast = { fish: g.fish, zone: g.zone, now: g.now };
    if (g.loose) {
      RS.loose++;
      if (!RS.looseLogged) { RS.looseLogged = true; log(`Nhận diện dự phòng (không theo màu): khung màu ${g.zc}, cá màu ${g.fc}.`); }
    }
    const ctl = ctlFor(g.source);
    if (reelFirst) {
      ctl.reset(); reelFirst = false; reelT0 = performance.now(); reelSamples = 0;
      RS.src = g.source; RS.w = g.width;
      RS.tier = tierOf(g.source, g.width);
      RS.arm = pickArm(RS.tier);
      ctl.setHorizon(ARMS[RS.arm]);
    }
    reelSamples++;
    const dtS = RS.last ? Math.min(0.2, Math.max(0, (g.now - RS.last) / 1000)) : 0;
    RS.last = g.now;
    if (dtS > 0) {
      const e = Math.abs(g.fish - g.zone) / Math.max(1e-6, g.width);
      RS.tot += dtS; RS.err += e * dtS;
      if (e <= 0.5) RS.inT += dtS;
      RS.ratioNow = RS.tot > 0 ? RS.inT / RS.tot : 0;
    }
    const sgn = g.source === 'draw2d' ? -1 : 1;      // draw2d: y hướng xuống → đổi sang "up"
    const out = ctl.step({ t: g.now, fish: sgn * g.fish, zone: sgn * g.zone, w: g.width });
    setHold(out.hold);
    RS.aH = out.aHn; RS.aF = out.aFn; RS.ovr = out.ovr;
    if (!RS.recovered && RS.tot > 1.3 && RS.inT / RS.tot < 0.05) {      // 1,3s mà gần như không bám được cá → học lại từ đầu
      RS.recovered = true; ctl.resetModel();
      log('Mô hình kéo cá có vẻ sai → học lại từ đầu.');
    }
    const nowT = performance.now();
    if (nowT - reelStatusAt > 300) {
      reelStatusAt = nowT;
      const hz = reelSamples / Math.max(0.2, (nowT - reelT0) / 1000);
      const unit = g.source === 'draw2d' ? 'px' : '';
      const fmt = g.source === 'draw2d' ? (v) => v.toFixed(0) : (v) => (v * 100).toFixed(0) + '%';
      setStatus(`${g.source}${g.loose ? '*' : ''} · Cá ${fmt(g.fish)} · Khung ${fmt(g.zone)}${unit} · ${holdWanted ? 'GIỮ' : 'THẢ'} · ${hz.toFixed(0)}Hz · ${(RS.ratioNow * 100).toFixed(0)}% trong khung`, 'Kéo cá');
    }
  }

  function startReelLoop() {
    if (reelLoopOn) return;
    reelLoopOn = true;
    holdWanted = false;
    reelLast = { fish: null, zone: null };
    reelFirst = true;
    reelBegin();
    const schedule = () => {
      reelRaf = PAGE.requestAnimationFrame ? PAGE.requestAnimationFrame(frame) : setTimeout(frame, 16);
    };
    const frame = () => {
      reelRaf = 0;
      if (!reelLoopOn) return;
      try { reelStep(); } catch (e) { log('Lỗi điều khiển kéo cá: ' + (e && e.message || e)); }
      if (reelLoopOn) schedule();
    };
    schedule();
  }

  function stopReelLoop() {
    reelLoopOn = false;
    holdWanted = false;
    try {
      if (reelRaf) { if (PAGE.cancelAnimationFrame) PAGE.cancelAnimationFrame(reelRaf); else clearTimeout(reelRaf); }
    } catch (_) {}
    reelRaf = 0;
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

  // Đọc nhanh số cá trong giỏ từ đúng nút "Giỏ cá N/24" (nhớ lại phần tử, không quét cả trang).
  let bagCountEl = null;
  function quickBagCount() {
    const read = (el) => {
      const t = normalize(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`);
      if (/suc cau/.test(t)) return null;
      const m = /(\d{1,3})\s*\/\s*(\d{1,3})/.exec(t);
      if (!m) return null;
      const count = Number(m[1]), capacity = Number(m[2]);
      return (capacity >= 5 && capacity <= 500 && count <= capacity) ? { count, capacity, source: 'dom' } : null;
    };
    try {
      if (bagCountEl && bagCountEl.isConnected) { const r = read(bagCountEl); if (r) return r; }
      for (const b of DOC.querySelectorAll('button,[role="button"]')) {
        if (root && root.contains(b)) continue;
        const t = normalize(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`);
        if (!/gio ca/.test(t)) continue;
        const r = read(b);
        if (r) { bagCountEl = b; return r; }
      }
    } catch (_) {}
    return null;
  }
  let bagCache = { at: -1e9, val: null };
  function readBagCount(force = false) {
    const now = performance.now();
    if (!force && now - bagCache.at < 700) return bagCache.val;
    const val = quickBagCount() || parseBag(pageNorm(force ? 0 : 700)) || parseBagFromElements();
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

  /* ---- Bán cá: "bán hết" (mặc định) hoặc chỉ ★1–2 ---- */
  const normLabel = (el) => normalize(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
  const bagButtons = (bag) => [...bag.querySelectorAll('button,[role="button"],[aria-pressed]')].filter(x => !(root && root.contains(x)));

  function bagDiag(tag) {
    try {
      const bag = DOC.querySelector('.fish-bag');
      const labels = bag ? bagButtons(bag).slice(0, 24).map(b => {
        const t = (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26);
        const c = typeof b.className === 'string' ? b.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        return `${t || '∅'}${b.disabled ? '(tắt)' : ''}[${c}]`;
      }) : [];
      log(`${tag}: nút trong giỏ: ${labels.join(' | ') || '—'}`);
    } catch (_) {}
  }

  function findSellButton(bag) {
    const cands = bagButtons(bag).filter(x => !x.disabled && /^ban\b/.test(normLabel(x)));
    return cands.find(x => /\d/.test(normLabel(x))) || cands[0] || null;
  }

  // Chọn tất cả cá trong giỏ: ưu tiên nút "Chọn tất cả"; không có thì bấm mọi chip nhóm cá.
  function selectAllInBag(bag) {
    const all = bagButtons(bag).find(x => !x.disabled && /chon\s*(tat\s*ca|het)|^tat\s*ca$|^het$/.test(normLabel(x)));
    if (all) {
      if (all.getAttribute('aria-pressed') !== 'true') all.click();
      return `nút "${normLabel(all)}"`;
    }
    let n = 0;
    for (const c of bag.querySelectorAll('.fish-bag-chip')) {
      if (c.disabled) continue;
      if (c.getAttribute('aria-pressed') !== 'true') { c.click(); n++; }
    }
    return n ? `${n} nhóm cá` : '';
  }

  // Dự phòng: giỏ không có chip/nút "tất cả" → bấm từng ô cá chưa được chọn.
  function selectEachFish(bag) {
    let n = 0;
    const els = bag.querySelectorAll('[aria-pressed="false"], [class*="item" i], [class*="card" i], [class*="slot" i], [class*="cell" i]');
    for (const el of els) {
      if (root && root.contains(el)) continue;
      const t = normLabel(el);
      if (/^ban\b|dong|close|^x$|chon\s*(tat|het)|^tha\b|^bo\s*chon/.test(t)) continue;
      if (el.disabled || el.getAttribute('aria-pressed') === 'true') continue;
      try { el.click(); n++; } catch (_) {}
      if (n >= 60) break;
    }
    return n;
  }

  // Số cá đang được chọn = số trong nút "Bán N con · +X".
  let sellBtnCache = null;
  function selCountOf(bag) {
    let b = sellBtnCache;
    if (!b || !b.isConnected || !bag.contains(b)) {
      b = bagButtons(bag).find(x => /^ban\b/.test(normLabel(x)));
      sellBtnCache = b || null;
    }
    if (!b) return 0;
    const m = /(\d+)/.exec(normLabel(b));
    return m ? Number(m[1]) : 0;
  }
  // Chờ khung hình kế tiếp (có giới hạn 50ms để không treo khi tab ẩn).
  const nextFrame = () => new Promise(res => {
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    try { if (PAGE.requestAnimationFrame) PAGE.requestAnimationFrame(fin); } catch (_) {}
    setTimeout(fin, 50);
  });

  // Tìm các thẻ cá: phần tử lá có chữ "x,xx kg" / "yy cm" → tổ tiên chung → mỗi con của nó là một thẻ.
  function findFishCards(bag) {
    const leaves = [...bag.querySelectorAll('*')].filter(el => !el.children.length && /\d\s*(kg|cm)\b/i.test(el.textContent || ''));
    if (!leaves.length) return [];
    let cont = leaves[0].parentElement;
    while (cont && !leaves.every(l => cont.contains(l))) cont = cont.parentElement;
    if (!cont) return [];
    const cards = [];
    for (const l of leaves) {
      let c = l;
      while (c.parentElement && c.parentElement !== cont) c = c.parentElement;
      if (c.parentElement === cont && !cards.includes(c)) cards.push(c);
    }
    return cards;
  }

  function looksSelected(card) {
    try {
      if (['aria-pressed', 'aria-checked', 'aria-selected'].some(a => card.getAttribute(a) === 'true')) return true;
      if (/(^|[\s_-])(sel|selected|on|active|checked|picked|chosen)([\s_-]|$)/i.test(String(card.className || ''))) return true;
      return !!card.querySelector('[class*="check" i], [class*="tick" i]');
    } catch (_) { return false; }
  }

  function pointerTap(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2, pid = newPid();
    firePointer(el, 'pointerdown', x, y, pid, 1);
    firePointer(el, 'pointerup', x, y, pid, 0);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      try {
        el.dispatchEvent(new PAGE.MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: PAGE, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 }));
      } catch (_) {}
    }
  }

  async function tapAndWatch(el, bag, before, how) {
    if (how === 'pointer') pointerTap(el); else { try { el.click(); } catch (_) {} }
    const t0 = performance.now();
    let n = selCountOf(bag);
    while (n === before && performance.now() - t0 < 220) { await nextFrame(); n = selCountOf(bag); }
    return n;
  }

  // Chọn TẤT CẢ cá trong giỏ (kể cả cá game không tự chọn như loài mới / kỷ lục / huy chương).
  // Dùng số trong nút "Bán N con" làm phản hồi: bấm trúng thẻ đã chọn sẽ bỏ chọn → bấm lại để hoàn tác.
  async function selectAllCards(bag) {
    const cards = findFishCards(bag);
    const bagInfo = readBagCount(true);
    const target = cards.length || (bagInfo ? bagInfo.count : 0);
    const info = { cards: cards.length, target, start: 0, end: 0, chips: 0, undone: 0, noEffect: 0 };
    let n = selCountOf(bag);
    info.start = n;
    const done = () => target > 0 && n >= target;
    const norm = (el) => normLabel(el);

    // 1) nút "Chọn tất cả" (nếu game có)
    const all = bagButtons(bag).find(x => !x.disabled && /chon\s*(tat\s*ca|het)|^tat\s*ca$|^het$/.test(norm(x)));
    if (all && !done()) { all.click(); await sleep(150); n = Math.max(n, selCountOf(bag)); }

    // 2) các chip nhóm sao (★1–2, ★3, ★4 ...)
    if (!done()) {
      for (const c of bag.querySelectorAll('.fish-bag-chip')) {
        if (c.disabled || c.getAttribute('aria-pressed') === 'true') continue;
        const before = n;
        const n2 = await tapAndWatch(c, bag, before, 'click');
        if (n2 < before) { await tapAndWatch(c, bag, n2, 'click'); info.undone++; n = selCountOf(bag); }
        else { n = Math.max(n, n2); if (n2 > before) info.chips++; }
        if (done()) break;
      }
    }

    // 3) từng thẻ cá: lượt 1 chỉ thẻ trông chưa chọn, lượt 2 thử mọi thẻ còn lại
    for (let pass = 1; pass <= 2 && !done() && cards.length; pass++) {
      let streak = 0;
      for (const card of cards) {
        if (done()) break;
        if (pass === 1 && looksSelected(card)) continue;
        const before = n;
        let n2 = await tapAndWatch(card, bag, before, 'click');
        if (n2 === before) {                       // click() không có tác dụng → thử chuỗi sự kiện pointer/mouse
          n2 = await tapAndWatch(card, bag, before, 'pointer');
        }
        if (n2 < before) { n2 = await tapAndWatch(card, bag, n2, 'click'); info.undone++; n = Math.max(selCountOf(bag), n2); streak = 0; }
        else if (n2 > before) { n = n2; streak = 0; }
        else { info.noEffect++; if (++streak >= 4) break; }
      }
    }
    info.end = selCountOf(bag);
    return info;
  }

  function findConfirmButton() {
    const re = /^(xac nhan|dong y|chac chan|ban ngay|ban het|co|ok|dong y ban)$|xac nhan|dong y|chac chan|van ban|ban luon|tiep tuc|chap nhan/;
    for (const b of DOC.querySelectorAll('button,[role="button"]')) {
      if (root && root.contains(b)) continue;
      if (b.disabled) continue;
      const t = normLabel(b);
      if (/^ban\s+\d+\s+con/.test(t)) continue;
      if (re.test(t) && isVisible(b)) return b;
    }
    return null;
  }

  /* ---- Nhận diện thẻ cá & luật "giữ lại" ---- */
  const BADGE_RX = /ky luc|record|huy chuong|medal|loai moi|new.?species|(^|[^a-z])moi([^a-z]|$)|(^|[^a-z])new([^a-z]|$)|crown|vuong mien|trophy/;

  function badgeOf(card) {
    try {
      for (const el of card.querySelectorAll('*')) {
        const sig = normalize(`${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('title') || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('aria-label') || ''} ${el.children.length ? '' : (el.textContent || '')}`);
        if (sig && BADGE_RX.test(sig) && !/check|tick|select|chon/.test(sig)) return sig.slice(0, 24);
      }
      const r = card.getBoundingClientRect();     // dự phòng: icon nhỏ (không chữ) ở góc trên-trái thẻ
      if (r.width > 40) {
        for (const el of card.querySelectorAll('img,svg,i,span,div')) {
          if (el.children.length > 1 || (el.textContent || '').trim()) continue;
          const b = el.getBoundingClientRect();
          if (b.width >= 8 && b.width <= 36 && b.height >= 8 && b.height <= 36 &&
              b.left - r.left < r.width * 0.3 && b.top - r.top < r.height * 0.3) return 'icon-góc-trái';
        }
      }
    } catch (_) {}
    return '';
  }

  function starsOfCard(card, raw) {
    try {
      const els = [card, ...[...card.querySelectorAll('*')].slice(0, 40)];
      for (const el of els) {
        for (const k of ['r', 'rarity', 'star', 'stars', 'tier']) {
          const v = el.dataset && el.dataset[k];
          if (v != null && /^\d$/.test(String(v).trim())) return Number(v);
        }
        const m = /(?:^|[\s_-])(?:r|rar|rarity|star|stars|tier)[-_]?(\d)(?:[\s_-]|$)/i.exec(typeof el.className === 'string' ? el.className : '');
        if (m) return Number(m[1]);
      }
      const g = (raw.match(/★/g) || []).length;
      if (g >= 1 && g <= 9) return g;
    } catch (_) {}
    return null;
  }

  function classifyCard(card) {
    const raw = (card.textContent || '').replace(/\s+/g, ' ').trim();
    const mk = /(\d+(?:[.,]\d+)?)\s*kg/i.exec(raw);
    const mc = /(\d+(?:[.,]\d+)?)\s*cm/i.exec(raw);
    return {
      name: (mk ? raw.slice(0, mk.index) : raw.slice(0, 24)).replace(/[·\s]+$/, '').trim(),
      kg: mk ? parseFloat(mk[1].replace(',', '.')) : null,
      cm: mc ? parseFloat(mc[1].replace(',', '.')) : null,
      stars: starsOfCard(card, raw),
      badge: badgeOf(card)
    };
  }

  function keepReason(info) {
    const r = [];
    if (GOAL.rare && info.stars != null && info.stars >= GOAL.rareMin) r.push(`hiếm ★${info.stars}`);
    if (GOAL.badge && (info.badge || info.gameKeep)) r.push('kỷ lục/huy chương/mới');
    if (GOAL.kg > 0 && info.kg != null && info.kg >= GOAL.kg) r.push(`${info.kg}kg`);
    return r.join('+');
  }

  function chipInfo(chip) {
    const nums = (chip.textContent || '').match(/\d+/g) || [];
    if (!nums.length) return null;
    const n = Number(nums[nums.length - 1]);
    const lo = Number(nums[0]);
    const hi = nums.length >= 3 ? Number(nums[1]) : lo;
    return { lo, hi, n };
  }

  const findBagButton = () => DOC.querySelector('.fish-quick-bag') ||
    [...DOC.querySelectorAll('button')].find(x => /gio ca/.test(normalize(x.getAttribute('aria-label') || x.textContent)));
  const findReleaseButton = (bag) => bagButtons(bag).find(x => !x.disabled && /^tha\b|tha ve ho/.test(normLabel(x)));

  // Đảm bảo thẻ ở trạng thái mong muốn (dựa vào phản hồi số trong nút "Bán N con").
  async function ensureCard(card, bag, want, info) {
    const before = selCountOf(bag);
    let n = await tapAndWatch(card, bag, before, 'click');
    if (n === before) n = await tapAndWatch(card, bag, before, 'pointer');
    if (n === before) { info.noEffect++; return false; }
    const nowSelected = n > before;
    if (nowSelected !== want) { await tapAndWatch(card, bag, n, 'click'); info.undone++; }
    return true;
  }

  // Phân tích giỏ: phân loại từng thẻ + suy ra con nào game tự giữ lại (không chọn sẵn khi mở hộp:
  // loài mới / kỷ lục / huy chương). Chỉ tin suy luận này khi số thẻ "trông đã chọn" khớp số trong nút Bán.
  function analyzeBag(bag) {
    const cards = findFishCards(bag);
    const infos = cards.map(classifyCard);
    const preSel = cards.map(looksSelected);
    const nPre = selCountOf(bag);
    const nLook = preSel.filter(Boolean).length;
    const gameKeepOK = cards.length > 0 && nPre > 0 && nPre < cards.length && nLook === nPre;
    infos.forEach((i, k) => { i.preSelected = preSel[k]; i.gameKeep = gameKeepOK && !preSel[k]; });
    const chips = [...bag.querySelectorAll('.fish-bag-chip')];
    const starsKnown = infos.length > 0 && infos.filter(i => i.stars != null).length >= infos.length * 0.7;
    return { cards, infos, chips, starsKnown, nPre, nLook, gameKeepOK };
  }

  // Chọn cá theo luật lọc: chọn những con KHÔNG thuộc nhóm giữ.
  async function selectByGoal(bag) {
    const A = analyzeBag(bag);
    const { cards, infos, chips, starsKnown } = A;
    const keeps = infos.map(keepReason);
    const out = { cards: cards.length, keep: keeps.filter(Boolean).length, start: 0, end: 0, noEffect: 0, undone: 0, mode: '', keepers: [] };
    infos.forEach((i, k) => { if (keeps[k]) out.keepers.push(`${i.name} ${i.kg != null ? i.kg + 'kg' : ''} (${keeps[k]})`); });

    // 1) xoá lựa chọn có sẵn
    let n = selCountOf(bag);
    const clr = bagButtons(bag).find(x => !x.disabled && /^bo\s*chon$/.test(normLabel(x)));
    if (n > 0 && clr) {
      clr.click();
      const t0 = performance.now();
      while (selCountOf(bag) !== 0 && performance.now() - t0 < 400) await nextFrame();
      n = selCountOf(bag);
    }
    out.start = n;

    if (GOAL.rare && !starsKnown && chips.length) {
      // Không đọc được ★ từng con → dùng chip nhóm ★ (chỉ chọn nhóm thấp hơn mức hiếm)
      out.mode = 'chip';
      for (const c of chips) {
        const ci = chipInfo(c);
        if (!ci || ci.hi >= GOAL.rareMin || c.disabled) continue;
        const before = selCountOf(bag);
        const n2 = await tapAndWatch(c, bag, before, 'click');
        if (n2 < before) await tapAndWatch(c, bag, n2, 'click');
      }
      for (let k = 0; k < cards.length; k++) {                 // loại các con thuộc luật khác khỏi phần đã chọn
        if (keeps[k] && !/hiếm/.test(keeps[k])) await ensureCard(cards[k], bag, false, out);
      }
    } else {
      out.mode = 'card';
      // chọn nhanh bằng chip nhóm khi không có con nào cần giữ
      if (!out.keep && !GOAL.rare) { const r = await selectAllCards(bag); out.end = r.end; out.noEffect = r.noEffect; out.undone = r.undone; return out; }
      for (let k = 0; k < cards.length; k++) {
        if (keeps[k]) continue;                                // con giữ lại: không chọn
        if (!await ensureCard(cards[k], bag, true, out)) {
          if (out.noEffect >= 4 && out.noEffect >= cards.length / 2) break;
        }
      }
    }
    out.end = selCountOf(bag);
    return out;
  }

  // 🧪 Thử bộ lọc: mở giỏ, phân loại từng con và cho biết sẽ GIỮ / BÁN con nào — KHÔNG bán gì cả.
  async function dryRunFilter() {
    if (bagFlow || testBusy) { log('Đang bận, thử lại sau.'); return; }
    testBusy = true;
    try {
      let openedHere = false;
      if (!isBagOpen()) {
        const btn = findBagButton();
        if (!btn) { log('🧪 Không tìm thấy nút Giỏ cá.'); return; }
        btn.click(); openedHere = true;
        if (!await waitFor(isBagOpen, 3500, 25)) { log('🧪 Không mở được Giỏ cá.'); return; }
      }
      await waitFor(() => { const b = DOC.querySelector('.fish-bag'); return b && (b.querySelector('button') || findFishCards(b).length); }, 1500, 25);
      await nextFrame(); await nextFrame();
      const bag = DOC.querySelector('.fish-bag');
      if (!bag) { log('🧪 Giỏ cá vừa đóng.'); return; }
      const A = analyzeBag(bag);
      const keeps = A.infos.map(keepReason);
      const known = A.infos.filter(i => i.stars != null).length;
      log(`🧪 ${A.cards.length} thẻ · chọn sẵn ${A.nPre} (nhìn thấy ${A.nLook}) · game tự giữ ${A.gameKeepOK ? A.infos.filter(i => i.gameKeep).length : '?'} · đọc được ★ ${known}/${A.cards.length} · kg ${A.infos.filter(i => i.kg != null).length}/${A.cards.length}.`);
      log(`🧪 Luật: ${goalActive() ? `giữ ${[GOAL.rare && `★≥${GOAL.rareMin}`, GOAL.badge && 'huy hiệu/game giữ', GOAL.kg > 0 && `≥${GOAL.kg}kg`].filter(Boolean).join(' + ')}; còn lại ${GOAL.rest === 'release' ? 'thả' : 'bán'}` : 'CHƯA bật mục giữ nào → sẽ bán hết'}${GOAL.rare && !A.starsKnown && A.chips.length ? ' · ★ từng con không đọc được → dùng chip nhóm ★' : ''}.`);
      const rest = GOAL.rest === 'release' ? 'THẢ' : 'BÁN';
      A.infos.slice(0, 24).forEach((i, k) => log(`  #${k + 1} ${i.name.slice(0, 16)} · ${i.kg != null ? i.kg + 'kg' : '?kg'} · ★${i.stars != null ? i.stars : '?'}${i.badge ? ' · huy hiệu' : ''}${i.gameKeep ? ' · game giữ' : ''} → ${keeps[k] ? 'GIỮ (' + keeps[k] + ')' : rest}`));
      if (A.infos.length > 24) log(`  … còn ${A.infos.length - 24} con nữa.`);
      const c0 = A.cards[0];
      if (c0) {
        const ds = Object.keys(c0.dataset || {}).slice(0, 5).map(k => `${k}=${c0.dataset[k]}`).join(',');
        const kids = [...c0.querySelectorAll('*')].slice(0, 8).map(e => `${e.tagName.toLowerCase()}.${String(e.className && e.className.baseVal != null ? e.className.baseVal : e.className || '').split(/\s+/)[0]}`).join(' ');
        log(`  DOM thẻ#1: <${c0.tagName.toLowerCase()} class="${String(c0.className).slice(0, 60)}" data=[${ds}]> con: ${kids}`);
      }
      log(`  chip: ${A.chips.map(c => `${(c.textContent || '').trim().replace(/\s+/g, ' ')}${c.getAttribute('aria-pressed') === 'true' ? '(bật)' : ''}`).join(' | ') || '—'}`);
      bagDiag('🧪');
      setStatus('Xem log (Sao chép log) để biết bộ lọc sẽ giữ/bán con nào.', 'Đã thử bộ lọc');
      if (openedHere) closeBagFast();
    } catch (e) {
      log('🧪 Lỗi: ' + (e && e.message || e));
    } finally { testBusy = false; }
  }

  function closeBagFast() {
    if (!isBagOpen()) return;
    closeBag();
  }

  // Tắt hộp chúc mừng / thông báo sau khi bán (cá kỷ lục, cá hiếm thường có hiệu ứng riêng).
  function dismissPopups(bag) {
    let clicked = 0;
    try {
      for (const b of DOC.querySelectorAll('button,[role="button"]')) {
        if (root && root.contains(b)) continue;
        if (bag && bag.contains(b)) continue;
        if (b.disabled || !isVisible(b)) continue;
        const t = normLabel(b);
        if (!/^(tiep tuc|ok|xong|da hieu|da biet|nhan|nhan thuong|dong|dong lai|bo qua|tuyet voi|x|×|✕)$/.test(t)) continue;
        if (!b.closest('[role="dialog"], [class*="modal" i], [class*="popup" i], [class*="toast" i], [class*="reward" i], [class*="celebr" i], [class*="sheet" i]')) continue;
        b.click(); clicked++;
        if (clicked >= 2) break;
      }
    } catch (_) {}
    return clicked;
  }

  function startBagFlow(reason = 'manual', stopAfter = false) {
    if (bagFlow) return;
    if (!running && reason === 'manual') {
      running = true;
      if (!loopHandle) loopHandle = setInterval(tick, CFG.pollMs);
    }
    const bag = readBagCount(true);
    const goal = goalActive();
    bagFlow = {
      reason, stopAfter, stage: 'run', mode: goal ? 'goal' : cfgSell,
      startedAt: Date.now(), stageAt: Date.now(), started: false,
      before: bag ? bag.count : null, selected: 0, kept: 0, recheck: false, fallbackTried: false
    };
    setStatus('Đang mở Giỏ cá…', 'Xử lý giỏ');
    const what = goal
      ? `lọc cá (giữ ${[GOAL.rare && `★≥${GOAL.rareMin}`, GOAL.badge && 'kỷ lục/huy chương/mới', GOAL.kg > 0 && `≥${GOAL.kg}kg`].filter(Boolean).join(', ')}; ${GOAL.rest === 'release' ? 'thả' : 'bán'} phần còn lại)`
      : (cfgSell === 'all' ? 'bán hết cá trong giỏ' : 'bán cá ★1–2');
    log(reason === 'auto' ? `Tự động ${what}.` : `Thủ công: ${what}.`);
  }

  function endBagFlow(msg, { sold = false, error = false, kept = 0 } = {}) {
    const f = bagFlow;
    if (!f) return;
    bagFlow = null;
    sinceSell = 0;
    try { closeBagFast(); } catch (_) {}
    cooldownUntil = Date.now() + 500;
    setTimeout(() => dismissPopups(null), 350); setTimeout(() => dismissPopups(null), 1100);
    if (msg) log(msg);
    if (sold) sellFailStreak = 0;
    if (!sold && f.reason === 'auto' && !kept) {
      sellFailStreak++;
      noSellUntil = Date.now() + Math.min(30 * 60000, CFG.noSellCooldownMs * Math.pow(2, sellFailStreak - 1));
      if (sellFailStreak >= 2) log(`Bán không được ${sellFailStreak} lần liên tiếp (có thể Ngư Ông đã mua đủ hôm nay) → tạm nghỉ tự bán ${Math.round((noSellUntil - Date.now()) / 60000 * 10) / 10} phút.`);
      const bag = readBagCount(true);
      if (bag && bag.count >= bag.capacity) {
        stop('Giỏ đầy nhưng không bán được cá nào. Hãy bán thủ công rồi bấm Bắt đầu (xem "Sao chép log" để biết nút nào bị kẹt).');
        return;
      }
    }
    if (kept) {                                  // giỏ chỉ còn cá giữ lại: đừng mở giỏ liên tục
      noSellUntil = Date.now() + 60000;
      const bag = readBagCount(true);
      if (bag && bag.count >= bag.capacity - 1) {
        stop(`🏆 Giỏ đã đầy cá giữ lại (${kept} con). Hãy dọn giỏ rồi bấm Bắt đầu.`);
        return;
      }
    }
    if (GOAL.stopN > 0 && stats.kept >= GOAL.stopN) {
      stop(`🏆 Đã giữ được ${stats.kept} cá mục tiêu (mục tiêu ${GOAL.stopN}) → dừng.`);
      return;
    }
    if (f.stopAfter) stop(msg || 'Xong.');
    else if (msg) setStatus(msg, error ? 'Lỗi giỏ' : 'Giỏ cá');
  }

  // Luồng bán cá chạy liền mạch (không chia stage theo nhịp 90ms nên không bị khựng).
  async function runBagFlow(f) {
    const T0 = performance.now();
    const marks = [];
    const mark = (k) => marks.push(`${k} ${((performance.now() - T0) / 1000).toFixed(1)}s`);
    const alive = () => bagFlow === f && performance.now() - T0 < 40000;
    sellBtnCache = null;

    // 1) mở giỏ
    if (!isBagOpen()) {
      const btn = findBagButton();
      if (!btn) { endBagFlow('Không tìm thấy nút Giỏ cá.', { error: true }); return; }
      btn.click();
      if (!await waitFor(isBagOpen, 3500, 25)) { endBagFlow('Không mở được Giỏ cá.', { error: true }); return; }
    }
    await waitFor(() => { const b = DOC.querySelector('.fish-bag'); return b && (b.querySelector('button') || findFishCards(b).length); }, 1500, 25);
    await nextFrame(); await nextFrame();
    mark('mở');
    if (!alive()) return;
    const bag = DOC.querySelector('.fish-bag');
    if (!bag) { endBagFlow('Giỏ cá vừa đóng lại.', { error: true }); return; }
    const before = readBagCount(true);
    if (before) f.before = before.count;
    if (f.before === 0) { endBagFlow('Giỏ đang trống, không có gì để bán.', { sold: true }); return; }

    // 2) chọn cá
    let selected = 0, keptNow = 0, goalInfo = null;
    if (f.mode === 'low') {
      const chip = bag.querySelector('.fish-bag-chip[data-r="12"]') ||
        [...bag.querySelectorAll('button')].find(x => /chon ca.*1.*2/.test(normLabel(x)));
      const n = chip ? Number((normLabel(chip).match(/(\d+)\s*con/) || [])[1] || 0) : 0;
      if (!chip || n === 0) { endBagFlow('Không có cá ★1–2 để bán.'); return; }
      if (chip.getAttribute('aria-pressed') !== 'true') chip.click();
      selected = n;
    } else if (f.mode === 'goal') {
      goalInfo = await selectByGoal(bag);
      selected = goalInfo.end;
      keptNow = goalInfo.keep;
      stats.kept = Math.max(0, goalInfo.keep);
      updateStats();
      log(`Lọc cá (${goalInfo.mode}): ${goalInfo.cards} con · giữ ${goalInfo.keep} · chọn ${goalInfo.end} để ${GOAL.rest === 'release' ? 'thả' : 'bán'}${goalInfo.noEffect ? ` · không đổi ${goalInfo.noEffect}` : ''}.`);
      for (const k of goalInfo.keepers.slice(0, 6)) log(`🏆 Giữ: ${k}`);
      if (!goalInfo.cards && !goalInfo.end) { bagDiag('Không nhận ra thẻ cá'); }
    } else {
      const info = await selectAllCards(bag);
      selected = info.end;
      log(`Chọn cá để bán: ${info.end}/${info.target || '?'} con (đầu ${info.start}; chip ${info.chips}; hoàn tác ${info.undone}; không đổi ${info.noEffect}; thẻ ${info.cards}).`);
      if (!info.end && !info.cards) {
        const how = selectAllInBag(bag);
        log(how ? `Đã chọn tất cả cá (${how}).` : 'Không thấy nút/chip chọn tất cả; sẽ thử chọn từng ô.');
      } else if (info.target && info.end < info.target) bagDiag('Chưa chọn đủ');
    }
    mark('chọn');
    if (!alive()) return;

    // 3) bấm bán / thả
    let btn = null;
    if (f.mode === 'goal' && GOAL.rest === 'release') btn = findReleaseButton(bag);
    else btn = findSellButton(bag);
    if (!btn && f.mode !== 'low') {
      await waitFor(() => (btn = (f.mode === 'goal' && GOAL.rest === 'release') ? findReleaseButton(bag) : findSellButton(bag)), 900, 30);
      if (!btn && !f.fallbackTried && f.mode !== 'goal') {
        f.fallbackTried = true;
        const n = selectEachFish(bag);
        log(`Chưa có nút Bán → bấm thử ${n} ô cá.`);
        await waitFor(() => (btn = findSellButton(bag)), 900, 30);
      }
    }
    if (f.mode === 'goal' && !selected) {                      // không có gì để bán: tất cả đều là cá giữ lại
      mark('xong');
      log(`⏱ ${marks.join(' · ')}`);
      endBagFlow(`Không có cá nào cần ${GOAL.rest === 'release' ? 'thả' : 'bán'} (giữ ${keptNow} con).`, { sold: true, kept: keptNow });
      return;
    }
    if (!btn) { bagDiag('Bán cá'); endBagFlow('Không thấy nút Bán cá (xem log "nút trong giỏ").', { error: true }); return; }
    const nBtn = Number((normLabel(btn).match(/(\d+)/) || [])[1] || 0);
    f.selected = nBtn || selected || f.selected;
    log(`Bấm "${(btn.textContent || '').trim().replace(/\s+/g, ' ')}".`);
    const cardsBefore = f.mode === 'low' ? 0 : findFishCards(bag).length;
    btn.click();

    // 4) xác nhận (nếu game hỏi) + chờ số cá giảm — kiểm tra mỗi 40ms bằng đọc nhanh
    const t1 = performance.now();
    let confirmed = 0, left = null, done = false, lastFull = t1, lastPop = t1;
    while (alive() && performance.now() - t1 < 6000) {
      let cur = quickBagCount();
      if (!cur && performance.now() - lastFull > 400) { lastFull = performance.now(); cur = readBagCount(true); }
      const cardsNow = cardsBefore ? findFishCards(bag).length : 0;
      if ((cur && f.before != null && cur.count < f.before) || !isBagOpen() || (cardsBefore && cardsNow < cardsBefore)) {
        left = cur ? cur.count : null; done = true; break;
      }
      if (confirmed < 3) {
        const cb = findConfirmButton();
        if (cb) { log(`Xác nhận: "${(cb.textContent || '').trim().replace(/\s+/g, ' ')}".`); cb.click(); confirmed++; await sleep(60); continue; }
      }
      if (performance.now() - lastPop > 200) { lastPop = performance.now(); dismissPopups(bag); }   // hộp chúc mừng chặn việc bán
      await sleep(30);
    }
    mark('bán');
    if (!alive()) return;
    if (!done) {
      const cur = readBagCount(true);
      if (cur && f.before != null && cur.count >= f.before) {
        bagDiag('Bán không giảm số cá');
        log(`⏱ ${marks.join(' · ')}`);
        endBagFlow('Đã bấm bán nhưng số cá trong giỏ không giảm.', { error: true, kept: keptNow });
        return;
      }
      left = cur ? cur.count : null;
    }
    await sleep(80);
    dismissPopups(bag);                                    // hộp chúc mừng cá kỷ lục / cá hiếm
    if (left == null) { const cur = readBagCount(true); left = cur ? cur.count : null; }
    const sold = (f.before != null && left != null) ? Math.max(0, f.before - left) : (f.selected || 0);
    stats.sold += sold;
    updateStats();
    mark('đóng');
    log(`⏱ ${marks.join(' · ')}`);
    endBagFlow(`${GOAL.rest === 'release' && f.mode === 'goal' ? 'Đã thả' : 'Đã bán'} ${sold > 0 ? sold + ' con' : 'cá'}${left != null ? `; giỏ còn ${left}${(before && before.capacity) ? '/' + before.capacity : ''}` : ''}${keptNow ? `; giữ ${keptNow} cá mục tiêu` : ''}.`, { sold: true, kept: keptNow });
  }

  async function tickBagFlow() {
    const f = bagFlow;
    if (!f) return;
    if (Date.now() - f.startedAt > 45000) { bagDiag('Quá thời gian'); endBagFlow('Bán cá quá thời gian.', { error: true }); return; }
    if (f.started) return;
    f.started = true;
    runBagFlow(f).catch(e => { try { endBagFlow(`Lỗi khi bán cá: ${e && e.message || e}`, { error: true }); } catch (_) {} });
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
    stopReelLoop();
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
          stopReelLoop();
          reelFinish();
          for (let w = 0; w < 40 && holdBusy; w++) await sleep(5);
          if (reelHeld || activePointerId != null) await releaseMainForReel();
          reelStartedAt = 0;
          stats.reels++;
          sinceSell++;
          updateStats();
          cooldownUntil = Math.max(cooldownUntil, now + CFG.afterCatchCooldownMs);
        }
        if (state === 'wait') { textBase = (GOAL.skip || fishTextLogs < 4) ? textSnapshot() : null; }
        if (state === 'reel') { reelStartedAt = now; startReelLoop(); setTimeout(analyzeFishText, 450); }
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
          const thr = sellAtN > 0 ? Math.min(sellAtN, bag.capacity || 99) : (bag ? bag.capacity - CFG.sellMargin : 99);
          if (bag && bag.count >= thr) { startBagFlow('auto', false); return; }
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
        startReelLoop();            // điều khiển chạy ở vòng riêng ~60Hz (reelStep)
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
  function tryInitUI() {
    try { initUI(); } catch (e) { uiFails++; reportErr(e, 'initUI'); }
  }
  function boot() {
    if (DOC.body) tryInitUI();
    else setTimeout(boot, 20);
  }
  boot();

  // Nếu game (SPA) xóa mất panel thì dựng lại (ngừng thử nếu hỏng liên tục).
  setInterval(() => {
    try { if (DOC.body && uiFails < 3 && !DOC.getElementById(ROOT_ID)) tryInitUI(); } catch (_) {}
  }, 2000);

  // Game bật toàn màn hình → phần tử ngoài vùng fullscreen bị ẩn; chuyển panel vào đó.
  DOC.addEventListener('fullscreenchange', () => {
    try {
      const host = DOC.fullscreenElement && DOC.fullscreenElement !== DOC.documentElement ? DOC.fullscreenElement : DOC.body;
      if (root && host && root.parentNode !== host) host.appendChild(root);
    } catch (_) {}
  });

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
  // Nếu script hỏng khi nạp: hiện nút đỏ (chạm để sao chép lỗi) thay vì im lặng.
  function reportFatal(err, stage) {
    try {
      var msg = String((err && (err.stack || err.message)) || err).slice(0, 700);
      var make = function () {
        var parent = document.body || document.documentElement;
        if (!parent) return false;
        if (document.getElementById('hh3d-fatal')) return true;
        var b = document.createElement('button');
        b.id = 'hh3d-fatal';
        b.type = 'button';
        b.textContent = '⚠ HH3D lỗi — chạm để sao chép';
        b.style.cssText = 'position:fixed;right:9px;top:150px;z-index:2147483647;background:#7a1f2b;color:#fff;border:1px solid #ff6b8b;border-radius:20px;padding:10px 14px;font:700 13px system-ui,sans-serif;max-width:80vw;text-align:left';
        b.addEventListener('click', function () {
          var text = 'HH3D 1.0.2 [' + stage + ']\n' + navigator.userAgent + '\n' + location.href + '\n' + msg;
          try { navigator.clipboard.writeText(text); } catch (_) {
            try { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); } catch (__) {}
          }
          b.textContent = '⚠ ' + msg.split('\n')[0].slice(0, 120) + ' (đã sao chép)';
        });
        parent.appendChild(b);
        return true;
      };
      if (!make()) { var iv = setInterval(function () { if (make()) clearInterval(iv); }, 100); }
    } catch (_) {}
  }
  var runMain = function (a, b) { try { main(a, b, reportFatal); } catch (e) { reportFatal(e, 'main:' + b); } };

  let wrapped;
  try { wrapped = window.wrappedJSObject; } catch (_) {}
  if (!wrapped) { runMain(false, 'direct'); return; }

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
      const code = '(function(){var __f=' + reportFatal.toString() + ';try{(' + main.toString() + ')(true,"' + kind + '",__f);}catch(e){__f(e,"page:' + kind + '");}})();';
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
    if (hasExport) { runMain(false, 'content'); return; }   // CSP chặn <script> nội tuyến: hook ngay bằng exportFunction
    inject('blob');
    let tries = 0;
    const iv = setInterval(() => {
      if (active()) { clearInterval(iv); return; }
      if (++tries >= 12) { clearInterval(iv); runMain(false, 'content'); }   // ≈0,5s mà trang vẫn chưa chạy bản nạp
    }, 40);
  };

  if (parentReady()) go();
  else {
    const mo = new MutationObserver(() => { if (parentReady()) { mo.disconnect(); go(); } });
    mo.observe(document, { childList: true });
  }
})();

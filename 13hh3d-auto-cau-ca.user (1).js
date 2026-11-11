// ==UserScript==
// @name         HH3D | Auto Câu Cá Tiên Giới
// @namespace    hh3d-tien-gioi-fishing
// @version      1.4.0
// @description  Tự động câu cá Tiên Giới: ném, giật, kéo cá (tự chọn cách tốt nhất), bán / thả cá về hồ, bảng thông tin cá theo thời tiết & điểm câu. Menu nhỏ gọn, kéo di chuyển được. Chạy trên Violentmonkey/Tampermonkey (Firefox/Chrome, PC & Android).
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
  const VERSION = '1.4.0';
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
    actionCooldownMs: 600,
    afterCatchCooldownMs: 1300,
    waitBiteTimeoutMs: 120000,
    reelTimeoutMs: 60000,
    tapXPercent: 50,            // mặc định: giữa hồ (có thể chỉnh / bấm 🎯 Chọn điểm)
    tapYPercent: 56,
    castHoldDurationMs: 90,
    castMoveSteps: 4,
    castVerifyMs: 3000,         // sau khi ném, game phải rời trạng thái "idle" trong thời gian này
    reelDeadbandMin: 0.016,
    reelDeadbandMax: 0.042,
    reelPredictionSec: 0.12,
    hookDebounceMs: 220,
    maxCastRetry: 5,
    castTapHoldMs: 50,
    noSellCooldownMs: 90000,
    blindSellEvery: 10          // nếu không đọc được số cá trong giỏ: bán sau mỗi N lần kéo cá
  };

  let root = null, panel = null, statusEl = null, logEl = null, statsEl = null;
  let modeSelect = null, reelSelect = null, aimEl = null;
  let aim = null;             // {x, y} (% màn hình) điểm câu đã chọn trên hồ; null = chạm theo "Điểm câu" của game
  let uiPos = { right: 9, top: 88 };
  let dragJustEnded = false;
  let resizeBound = false;

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
  const stats = { casts: 0, hooks: 0, reels: 0, sold: 0, caught: 0, lost: 0, released: 0 };

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
        aim, autoSell,
        mode: cfgMode,
        algo: cfgAlgo,
        reel: cfgReel,
        press: cfgPress,
        pressH: PRESS.custom.h,
        pressR: PRESS.custom.r,
        pos: uiPos,
        rel12: relOn12,
        rel3: relOn3,
        ipos: infoPos,
        iopen: !!(infoPanel && infoPanel.style.display === 'block'),
        autospot: autoSpot
      }));
    } catch (_) {}
  }

  /* ------------------------------------------------------------------ *
   * 4) Giao diện: nút 🎣 nhỏ + menu gọn, kéo di chuyển được
   * ------------------------------------------------------------------ */
  function applyPos() {
    if (!root) return;
    const w = root.offsetWidth || 46;
    uiPos.right = clamp(Number(uiPos.right) || 0, 0, Math.max(0, PAGE.innerWidth - w));
    uiPos.top = clamp(Number(uiPos.top) || 0, 0, Math.max(0, PAGE.innerHeight - 46));
    root.style.right = uiPos.right + 'px';
    root.style.top = uiPos.top + 'px';
  }

  // Mở menu về phía còn chỗ trống (trái/phải, lên/xuống) để không tràn màn hình.
  function placePanel(rootEl = root, panelEl = panel) {
    if (!rootEl || !panelEl || panelEl.style.display !== 'block') return;
    rootEl.classList.remove('left', 'up');
    panelEl.style.maxHeight = '';
    let r = panelEl.getBoundingClientRect();
    if (r.left < 4) { rootEl.classList.add('left'); r = panelEl.getBoundingClientRect(); }
    if (r.bottom > PAGE.innerHeight - 4) {
      const fabTop = rootEl.getBoundingClientRect().top;
      if (fabTop > r.height + 12) rootEl.classList.add('up');
      else panelEl.style.maxHeight = Math.max(160, PAGE.innerHeight - r.top - 10) + 'px';
    }
  }

  // Cho phép kéo `handle` để di chuyển cả menu (chạm nhẹ vẫn là bấm bình thường).
  function makeDraggable(handle) {
    let active = false, drag = false, pid = null, sx = 0, sy = 0, sr = 0, st = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (e.target !== handle && e.target.closest && e.target.closest('button')) return;   // nút nằm trong thanh tiêu đề
      active = true; drag = false; pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      sr = PAGE.innerWidth - r.right; st = r.top;
      try { handle.setPointerCapture(pid); } catch (_) {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!drag && Math.hypot(dx, dy) < 8) return;
      drag = true;
      uiPos.right = sr - dx; uiPos.top = st + dy;
      applyPos();
    });
    const end = (e) => {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      try { handle.releasePointerCapture(pid); } catch (_) {}
      if (drag) { dragJustEnded = true; setTimeout(() => { dragJustEnded = false; }, 150); saveCfg(); placePanel(); }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function initUI() {
    if (!DOC.body || DOC.getElementById(ROOT_ID)) return;
    const saved = loadSaved();
    if (saved.aim && Number.isFinite(Number(saved.aim.x)) && Number.isFinite(Number(saved.aim.y))) {
      aim = { x: clamp(Math.round(Number(saved.aim.x)), 5, 95), y: clamp(Math.round(Number(saved.aim.y)), 5, 95) };
    } else if (saved.cast === 'drag' && Number.isFinite(Number(saved.tapX)) && Number.isFinite(Number(saved.tapY))) {
      aim = { x: clamp(Math.round(Number(saved.tapX)), 5, 95), y: clamp(Math.round(Number(saved.tapY)), 5, 95) };   // điểm đã chọn ở bản cũ
    }
    if (typeof saved.autoSell === 'boolean') autoSell = saved.autoSell;
    if (['auto', 'direct', 'dispatch'].includes(saved.mode)) cfgMode = saved.mode;
    if (['auto', 'classic', 'advanced'].includes(saved.algo)) cfgAlgo = saved.algo;
    if (['auto', 'soft', 'std', 'hard'].includes(saved.reel)) cfgReel = saved.reel;
    if (['auto', 'calm', 'steady', 'fast', 'custom'].includes(saved.press)) cfgPress = saved.press;
    if (Number.isFinite(Number(saved.pressH))) PRESS.custom.h = clamp(Math.round(Number(saved.pressH)), 0, 900);
    if (Number.isFinite(Number(saved.pressR))) PRESS.custom.r = clamp(Math.round(Number(saved.pressR)), 0, 900);
    relOn12 = !!saved.rel12; relOn3 = !!saved.rel3;
    if (saved.ipos && Number.isFinite(Number(saved.ipos.right)) && Number.isFinite(Number(saved.ipos.top))) infoPos = { right: Number(saved.ipos.right), top: Number(saved.ipos.top) };
    infoWantOpen = !!saved.iopen;
    autoSpot = !!saved.autospot;
    if (saved.pos && Number.isFinite(Number(saved.pos.right)) && Number.isFinite(Number(saved.pos.top))) {
      uiPos = { right: Number(saved.pos.right), top: Number(saved.pos.top) };
    }

    root = DOC.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <style>
        #${ROOT_ID} { position:fixed !important; z-index:2147483647 !important; isolation:isolate; pointer-events:auto; right:${uiPos.right}px; top:${uiPos.top}px; width:46px; height:46px; color:#f5f2ff; font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; touch-action:manipulation; }
        #${ROOT_ID} * { box-sizing:border-box; }
        #${ROOT_ID} .fish-fab { display:flex; align-items:center; justify-content:center; width:46px; height:46px; padding:0; border:1px solid #5bcaaf; border-radius:50%; background:rgba(16,42,45,.94); color:#eafffa; font-size:22px; box-shadow:0 3px 12px #0008; cursor:pointer; touch-action:none; user-select:none; }
        #${ROOT_ID} .fish-fab.on { box-shadow:0 0 0 3px #42c7a366, 0 3px 12px #0008; }
        #${ROOT_ID} .fish-panel { position:absolute; right:0; top:calc(100% + 6px); width:min(272px, calc(100vw - 16px)); background:rgba(20,20,27,.97); border:1px solid #4b8e84; border-radius:12px; padding:9px; box-shadow:0 8px 25px #0009; display:none; max-height:min(72vh, 520px); overflow:auto; }
        #${ROOT_ID}.left .fish-panel { right:auto; left:0; }
        #${ROOT_ID}.up .fish-panel { top:auto; bottom:calc(100% + 6px); }
        #${ROOT_ID} .fish-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:800; font-size:13px; margin-bottom:7px; cursor:grab; touch-action:none; user-select:none; }
        #${ROOT_ID} .fish-head small { font-size:10px; font-weight:600; color:#99d6c9; }
        #${ROOT_ID} .fish-head .grip { opacity:.55; font-weight:400; letter-spacing:1px; }
        #${ROOT_ID} .fish-status { padding:6px 8px; border-radius:8px; background:#282832; margin-bottom:7px; overflow-wrap:anywhere; font-size:12px; }
        #${ROOT_ID} .fish-status strong { color:#74e2c4; }
        #${ROOT_ID} .fish-row { display:flex; gap:6px; margin:6px 0; }
        #${ROOT_ID} button.fish-action { border:0; border-radius:8px; padding:9px 8px; color:#fff; background:#38404a; font-weight:750; flex:1; min-width:0; cursor:pointer; font-size:13px; }
        #${ROOT_ID} button.fish-start { background:#087f68; }
        #${ROOT_ID} button.fish-stop { background:#a33c4b; }
        #${ROOT_ID} button.fish-sell { background:#7d5a14; }
        #${ROOT_ID} button.fish-test { background:#6a4c9c; }
        #${ROOT_ID} button.fish-small { padding:7px 8px; font-size:11.5px; }
        #${ROOT_ID} button.fish-x { flex:0 0 38px; }
        #${ROOT_ID} .fish-rel { display:flex; flex-wrap:wrap; align-items:center; gap:2px 10px; color:#c9d6d3; font-size:11px; margin:2px 0 4px; }
        #${ROOT_ID} .fish-rel label { margin:2px 0; }
        #${ROOT_ID} .fish-aim { color:#9fe6d3; font-size:11px; margin:-2px 0 4px 2px; }
        #${ROOT_ID} label { display:flex; align-items:center; gap:7px; margin:6px 0; color:#e4dff0; font-size:11.5px; }
        #${ROOT_ID} input[type=checkbox] { width:17px; height:17px; accent-color:#42c7a3; }
        #${ROOT_ID} .fish-count-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
        #${ROOT_ID} .fish-count-row input, #${ROOT_ID} .fish-count-row select { width:auto; min-width:64px; padding:6px; border-radius:6px; border:1px solid #585766; background:#121219; color:#fff; font-size:12px; }
        #${ROOT_ID} .fish-count-row input[type=number] { width:64px; }
        #${ROOT_ID} .fish-stats { color:#9fe6d3; font-size:10.5px; margin-top:5px; }
        #${ROOT_ID} .fish-log { white-space:pre-wrap; font-size:10px; color:#d4d0df; background:#111117; border-radius:8px; padding:7px; margin-top:8px; max-height:120px; overflow:auto; }
        #${ROOT_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:3px 8px !important; flex:0 0 auto !important; font-size:12px !important; }
        #${ROOT_ID} details.fish-sec { margin:8px 0 2px; border:1px solid #3a4a49; border-radius:9px; padding:2px 8px 6px; background:#1b1b24; }
        #${ROOT_ID} details.fish-sec > summary { cursor:pointer; font-weight:800; font-size:12px; color:#9fe6d3; padding:6px 0; list-style:none; }
        #${ROOT_ID} details.fish-sec > summary::-webkit-details-marker { display:none; }
        #${ROOT_ID} details.fish-sec > summary::after { content:' ▾'; opacity:.7; }
        .hh3d-debug-dot { position:fixed; width:20px; height:20px; background:red; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:.8; transition:opacity .5s; }
        .hh3d-debug-btn { position:fixed; width:30px; height:30px; border:3px solid yellow; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:.8; transition:opacity .5s; }
      </style>
      <button type="button" class="fish-fab" id="hh3df-fab" title="Chạm để mở menu · kéo để di chuyển">🎣</button>
      <section class="fish-panel" id="hh3df-panel">
        <div class="fish-head" id="hh3df-head"><span>🎣 HH3D <small>v${VERSION}</small> <span class="grip">⠿ kéo</span></span><button class="fish-action fish-collapse" id="hh3df-hide" type="button">Ẩn</button></div>
        <div class="fish-status" id="hh3df-status">Trạng thái: <strong>Sẵn sàng</strong></div>
        <div class="fish-row">
          <button type="button" class="fish-action fish-start" id="hh3df-start">▶ Bắt đầu</button>
          <button type="button" class="fish-action fish-stop" id="hh3df-stop">■ Dừng</button>
        </div>
        <div class="fish-row">
          <button type="button" class="fish-action fish-small" id="hh3df-pick">🎯 Chọn điểm câu trên hồ</button>
          <button type="button" class="fish-action fish-small fish-x" id="hh3df-pick-clear" title="Dùng Điểm câu của game">✕</button>
        </div>
        <div class="fish-aim" id="hh3df-aim"></div>
        <label><input type="checkbox" id="hh3df-autosell" ${autoSell ? 'checked' : ''}> Tự bán cá khi giỏ gần đầy</label>
        <div class="fish-rel" title="Khi không bán được (Ngư Ông đã mua đủ hôm nay) mà giỏ sắp đầy, tool thả cá hạng thấp về hồ để tiếp tục câu.">
          <span>Hết lượt bán → thả về hồ:</span>
          <label><input type="checkbox" id="hh3df-rel12" ${relOn12 ? 'checked' : ''}> ★1–2</label>
          <label><input type="checkbox" id="hh3df-rel3" ${relOn3 ? 'checked' : ''}> ★3</label>
        </div>
        <div class="fish-stats" id="hh3df-stats"></div>

        <details class="fish-sec">
          <summary>⚙️ Khác</summary>
          <div class="fish-count-row"><span>Chế độ nhập:</span>
            <select id="hh3df-mode">
              <option value="auto">Tự động</option>
              <option value="direct">Trực tiếp</option>
              <option value="dispatch">Mô phỏng</option>
            </select>
          </div>
          <div class="fish-count-row" title="Cổ điển: cách kéo cá của bản cũ. Dự đoán: mô hình tự học. Tự động: thử cả hai rồi chọn cách cho kết quả tốt hơn."><span>Cách kéo cá:</span>
            <select id="hh3df-algo">
              <option value="auto">Tự động (chọn cách tốt nhất)</option>
              <option value="classic">Cổ điển</option>
              <option value="advanced">Dự đoán (nâng cao)</option>
            </select>
          </div>
          <div id="hh3df-adv-rows">
          <div class="fish-count-row"><span>Độ nhạy kéo cá:</span>
            <select id="hh3df-reel">
              <option value="auto">Tự động (tự học)</option>
              <option value="soft">Êm</option>
              <option value="std">Chuẩn</option>
              <option value="hard">Gắt</option>
            </select>
          </div>
          <div class="fish-count-row" title="Game dặn: giữ nút để nâng khung, đừng nhấp. Êm = mỗi lần giữ/thả kéo dài như người chơi."><span>Cách nhấn khi kéo:</span>
            <select id="hh3df-press">
              <option value="auto">Tự động</option>
              <option value="calm">Êm (giữ lâu)</option>
              <option value="steady">Vừa</option>
              <option value="fast">Nhanh (nhấp dày)</option>
              <option value="custom">Tùy chỉnh (ms)</option>
            </select>
          </div>
          <div class="fish-count-row" title="Chỉ dùng khi chọn Tùy chỉnh. Mỗi lần giữ/thả kéo dài ít nhất bấy nhiêu ms."><span>Giữ ≥ / thả ≥ (ms):</span>
            <input type="number" id="hh3df-press-h" min="0" max="900" step="10" value="${PRESS.custom.h}">
            <input type="number" id="hh3df-press-r" min="0" max="900" step="10" value="${PRESS.custom.r}">
          </div>
          </div>
          <div class="fish-row">
            <button type="button" class="fish-action fish-sell fish-small" id="hh3df-sell">🧺 Bán cá ngay</button>
            <button type="button" class="fish-action fish-small" id="hh3df-release" title="Thả các nhóm ★ đã tick ở trên về hồ">🌊 Thả cá về hồ ngay</button>
          </div>
          <div class="fish-row">
            <button type="button" class="fish-action fish-small" id="hh3df-check">🔎 Chẩn đoán</button>
            <button type="button" class="fish-action fish-test fish-small" id="hh3df-test-cast">🎣 Thử ném</button>
          </div>
          <div class="fish-row">
            <button type="button" class="fish-action fish-small" id="hh3df-copy">📋 Sao chép log</button>
            <button type="button" class="fish-action fish-small" id="hh3df-clear">Xóa log</button>
          </div>
          <div class="fish-log" id="hh3df-log">Chưa có hoạt động.</div>
        </details>
      </section>`;

    DOC.body.appendChild(root);
    applyPos();

    try {
    panel = root.querySelector('#hh3df-panel');
    statusEl = root.querySelector('#hh3df-status');
    logEl = root.querySelector('#hh3df-log');
    statsEl = root.querySelector('#hh3df-stats');
    aimEl = root.querySelector('#hh3df-aim');
    const fab = root.querySelector('#hh3df-fab');
    const toggle = () => {
      const open = panel.style.display !== 'block';
      panel.style.display = open ? 'block' : 'none';
      fab.classList.toggle('on', open);
      if (open) placePanel();
    };
    fab.addEventListener('click', () => { if (!dragJustEnded) toggle(); });
    root.querySelector('#hh3df-hide').addEventListener('click', () => { panel.style.display = 'none'; fab.classList.remove('on'); });
    makeDraggable(fab);
    makeDraggable(root.querySelector('#hh3df-head'));
    if (!resizeBound) { resizeBound = true; PAGE.addEventListener('resize', () => { applyPos(); placePanel(); }); }

    modeSelect = root.querySelector('#hh3df-mode');
    modeSelect.value = cfgMode;
    modeSelect.addEventListener('change', e => {
      cfgMode = e.target.value;
      autoMode = null;
      castComboIdx = 0;
      castRetryCount = 0;
      saveCfg();
      log(`Chế độ nhập: ${cfgMode}.`);
    });
    const algoSelect = root.querySelector('#hh3df-algo');
    const advRows = root.querySelector('#hh3df-adv-rows');
    const syncAlgoUI = () => { advRows.style.display = cfgAlgo === 'classic' ? 'none' : ''; };
    algoSelect.value = cfgAlgo;
    syncAlgoUI();
    algoSelect.addEventListener('change', e => { cfgAlgo = e.target.value; syncAlgoUI(); saveCfg(); log(`Cách kéo cá: ${({ auto: 'tự động', classic: 'cổ điển', advanced: 'dự đoán' })[cfgAlgo]}.`); });
    reelSelect = root.querySelector('#hh3df-reel');
    reelSelect.value = cfgReel;
    reelSelect.addEventListener('change', e => { cfgReel = e.target.value; saveCfg(); log(`Độ nhạy kéo cá: ${cfgReel}.`); });
    pressSelect = root.querySelector('#hh3df-press');
    pressSelect.value = cfgPress;
    pressSelect.addEventListener('change', e => { cfgPress = e.target.value; saveCfg(); log(`Cách nhấn khi kéo: ${cfgPress}.`); });
    pressHInput = root.querySelector('#hh3df-press-h');
    pressRInput = root.querySelector('#hh3df-press-r');
    const onCustom = () => {
      PRESS.custom.h = clamp(Math.round(Number(pressHInput.value)) || 0, 0, 900);
      PRESS.custom.r = clamp(Math.round(Number(pressRInput.value)) || 0, 0, 900);
      cfgPress = 'custom'; pressSelect.value = 'custom';
      saveCfg(); log(`Cách nhấn tùy chỉnh: giữ ≥ ${PRESS.custom.h}ms, thả ≥ ${PRESS.custom.r}ms.`);
    };
    pressHInput.addEventListener('change', onCustom);
    pressRInput.addEventListener('change', onCustom);

    root.querySelector('#hh3df-pick').addEventListener('click', pickAim);
    root.querySelector('#hh3df-pick-clear').addEventListener('click', clearAim);
    root.querySelector('#hh3df-start').addEventListener('click', start);
    root.querySelector('#hh3df-stop').addEventListener('click', () => stop('Dừng thủ công.'));
    root.querySelector('#hh3df-autosell').addEventListener('change', e => {
      autoSell = !!e.target.checked;
      saveCfg();
      log(`Tự bán cá: ${autoSell ? 'BẬT' : 'TẮT'}.`);
    });
    root.querySelector('#hh3df-sell').addEventListener('click', () => startBagFlow('manual', !running));
    root.querySelector('#hh3df-release').addEventListener('click', () => {
      if (!relOn12 && !relOn3) { log('Hãy tick ★1–2 và/hoặc ★3 ở mục "Hết lượt bán → thả về hồ" trước.'); return; }
      startReleaseFlow('manual', !running);
    });
    root.querySelector('#hh3df-rel12').addEventListener('change', e => { relOn12 = !!e.target.checked; saveCfg(); log(`Thả cá ★1–2 khi hết lượt bán: ${relOn12 ? 'BẬT' : 'TẮT'}.`); });
    root.querySelector('#hh3df-rel3').addEventListener('change', e => { relOn3 = !!e.target.checked; saveCfg(); log(`Thả cá ★3 khi hết lượt bán: ${relOn3 ? 'BẬT' : 'TẮT'}.`); });
    root.querySelector('#hh3df-check').addEventListener('click', diagnostic);
    root.querySelector('#hh3df-test-cast').addEventListener('click', testCast);
    root.querySelector('#hh3df-copy').addEventListener('click', copyLog);
    root.querySelector('#hh3df-clear').addEventListener('click', () => { logLines = []; logEl.textContent = 'Đã xóa log.'; });

    updateAimLabel();
    updateStats();
    log(`Đã nạp v${VERSION} · Hook: ${INPUT_BRIDGE.ok ? 'OK' : 'LỖI'} · Probe vẽ: ${DRAW_PROBE.supported ? 'OK' : 'không'}.`);
    setStatus('Bấm ▶ Bắt đầu để chạy.', 'Sẵn sàng');
    } catch (e) {
      // Có ít nhất nút 🎣 hiện ra; báo lỗi để biết đoạn nào hỏng.
      reportErr(e, 'initUI.bind');
    }
    try { buildInfoUI(); } catch (e) { reportErr(e, 'infoUI'); }
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
    statsEl.textContent = `Ném ${stats.casts} · Giật ${stats.hooks} · Được ${stats.caught} · Hụt ${stats.lost} · Bán ${stats.sold}${stats.released ? ` · Thả ${stats.released}` : ''}${st}`;
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

  function updateAimLabel() {
    if (aimEl) aimEl.textContent = aim ? `Điểm câu: ${aim.x}% · ${aim.y}% màn hình` : 'Điểm câu: theo game (chạm nút ném)';
  }

  // Chạm lên mặt hồ để chọn điểm câu (tool sẽ kéo cần tới đúng điểm này).
  function pickAim() {
    if (DOC.getElementById('hh3d-aim-overlay') || !DOC.body) return;
    const ov = DOC.createElement('div');
    ov.id = 'hh3d-aim-overlay';
    ov.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483646;background:rgba(0,0,0,.25);touch-action:none;display:flex;justify-content:center;align-items:flex-start;';
    ov.innerHTML = '<div style="margin-top:96px;padding:10px 14px;border-radius:12px;background:#102a2d;color:#eafffa;font:700 14px/1.4 system-ui,sans-serif;text-align:center;max-width:80%;border:1px solid #5bcaaf">🎯 Chạm vào điểm trên mặt hồ bạn muốn câu<br><button type="button" id="hh3d-aim-cancel" style="margin-top:8px;padding:6px 14px;border-radius:8px;border:1px solid #5bcaaf;background:transparent;color:#fff;font-weight:700">Hủy</button></div>';
    const close = () => { ov.remove(); if (panel) { panel.style.display = 'block'; placePanel(); } };
    ov.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'hh3d-aim-cancel') { close(); return; }
      const px = clamp(Math.round(e.clientX / PAGE.innerWidth * 100), 5, 95);
      const py = clamp(Math.round(e.clientY / PAGE.innerHeight * 100), 5, 95);
      aim = { x: px, y: py };
      castComboIdx = 0;
      saveCfg();
      updateAimLabel();
      showDebugDot(e.clientX, e.clientY);
      log(`Điểm câu mới: ${px}% / ${py}% (${Math.round(e.clientX)},${Math.round(e.clientY)}).`);
      close();
    });
    DOC.body.appendChild(ov);
    if (panel) panel.style.display = 'none';
  }

  function clearAim() {
    aim = null; castComboIdx = 0; saveCfg(); updateAimLabel();
    log('Dùng "Điểm câu" của game (chạm nút ném).');
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
    const kinds = aim ? ['drag', 'tap'] : ['tap', 'drag'];   // đã chọn điểm → kéo tới điểm; chưa chọn → chạm theo Điểm câu của game
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
    const tx = ((aim ? aim.x : CFG.tapXPercent) / 100) * PAGE.innerWidth;
    const ty = ((aim ? aim.y : CFG.tapYPercent) / 100) * PAGE.innerHeight;
    const holdMs = CFG.castHoldDurationMs;
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
        await sleep(CFG.castTapHoldMs);
        up = await sendPointer(btn, 'pointerup', sx, sy, pid, 0, mode);
      } else {
        await sleep(30);
        const steps = Math.max(1, CFG.castMoveSteps);
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          const ok = await sendPointer(btn, 'pointermove', sx + (tx - sx) * k, sy + (ty - sy) * k, pid, 1, mode);
          if (!ok) {
            log(`Ném (${kind}/${mode}): pointermove không được xử lý.`);
            await sendPointer(btn, 'pointerup', sx, sy, pid, 0, mode);
            return false;
          }
          await sleep(14);
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
    if (ok) { reelHeld = true; reelMode = mode; RS.presses++; RS.pressT0 = performance.now(); }
    return ok;
  }

  async function releaseMainForReel() {
    if (!reelHeld && activePointerId == null) return true;
    const btn = gameMainButton();
    if (!btn) { reelHeld = false; activePointerId = null; return false; }
    const { x, y } = centerOf(btn);
    const pid = activePointerId || newPid();
    const ok = await sendPointer(btn, 'pointerup', x, y, pid, 0, reelMode || currentMode());
    if (RS.pressT0) { const d = performance.now() - RS.pressT0; RS.holdSum += d; RS.holdMax = Math.max(RS.holdMax, d); RS.holdMin = Math.min(RS.holdMin, d); RS.pressT0 = 0; }
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
    const FT = opts.fishTau != null ? opts.fishTau : 0.25;   // hằng số thời gian ngoại suy vận tốc cá (giây)
    const M = { scale: null, th: null, P: null };
    const S = {};
    const DW = { h: 0, r: 0 };            // thời gian tối thiểu mỗi lần GIỮ / THẢ (giây); 0 = không ràng buộc
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
    // Kiểu nhấn êm: mỗi lần GIỮ phải kéo dài >= DW.h, mỗi lần THẢ >= DW.r (giây) — giống người, không "nhấp".
    // Vì vậy mỗi phương án được mô phỏng như một KẾ HOẠCH: giữ nguyên lệnh một lúc rồi (có thể) đổi sang lệnh ngược lại.
    function decide(t, z, f, w, sc) {
      const known = (S.zMax - S.zMin) > 3 * w;
      const th = M.th;
      const lat = latNow();
      const Hh = Math.max(HOR, Math.max(DW.h, DW.r) + 0.14);
      const N = Math.round(Hh / STEP);
      function sim(u, tSwitch) {                    // lệnh u cho tới tSwitch giây, sau đó đảo lệnh
        let zz = z, v = S.zv, c = 0;
        for (let j = 1; j <= N; j++) {
          const tau = j * STEP;
          const cmd = tau <= lat / 1000 ? cmdAt(t + tau * 1000 - lat) : (tau <= tSwitch ? u : !u);
          v += ((cmd ? th[0] : th[1]) - th[2] * v) * STEP;
          zz += v * STEP;
          if (known) {
            if (zz > S.zMax + 0.2 * w) { zz = S.zMax + 0.2 * w; v = Math.min(v, 0); }
            if (zz < S.zMin - 0.2 * w) { zz = S.zMin - 0.2 * w; v = Math.max(v, 0); }
          }
          const e = (zz - (f + S.fv * FT * (1 - Math.exp(-tau / FT)))) / w;      // cá đổi hướng thất thường → ngoại suy giảm dần
          c += e * e;
        }
        const vr = (v - S.fv) * Hh / w;
        return c / N + MU * vr * vr;
      }
      const dw = (u) => (u ? DW.h : DW.r);
      function plan(u) {
        const stay = u === S.hold;
        const base = stay ? 0 : dw(u);               // bắt đầu lệnh mới thì phải giữ ít nhất dw(u)
        const ts = stay ? [0.06, 0.14, 0.28, 1e9] : [base, base + 0.1, base + 0.25, 1e9];
        let best = Infinity;
        for (const x of ts) best = Math.min(best, sim(u, x));
        return best;
      }
      const cH = plan(true), cF = plan(false);
      const m = HYST * Math.max(0.05, Math.min(cH, cF)) + 1e-4;
      const wantHold = S.hold ? !(cF < cH - m) : (cH < cF - m);
      let hold = S.hold;
      const sinceSwitch = t - S.lastSwitch;
      const canSwitch = sinceSwitch >= Math.max(MIN_DWELL, dw(S.hold) * 1000);
      const doSwitch = (v) => {
        hold = v; S.lastSwitch = t; S.hist.push({ t, hold });
        if (S.hist.length > 60) S.hist.splice(0, S.hist.length - 60);
      };
      if (wantHold !== S.hold && canSwitch) doSwitch(wantHold);
      // Chốt an toàn (độc lập mô hình): cá còn xa khung mà khung không tiến về phía cá → ép đi về phía cá.
      // Tránh kẹt "mô hình sai → không bao giờ GIỮ" và luôn tạo dữ liệu mới để học lại.
      const eNow = f - z;
      if (Math.abs(eNow) > 1.5 * w && S.zv * Math.sign(eNow) < 1.0 * w && canSwitch) {
        const need = eNow > 0;
        if (hold !== need) { doSwitch(need); S.ovr = (S.ovr || 0) + 1; }
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
    function setDwell(hMs, rMs) { DW.h = Math.max(0, hMs) / 1000; DW.r = Math.max(0, rMs) / 1000; }
    return { reset, resetModel, step, coast, setDwell, setHorizon(h) { HOR = h; }, getHorizon() { return HOR; } };
  }

  const reelCtls = {};
  const ctlFor = (source) => reelCtls[source] || (reelCtls[source] = createReelController());

  /* ---- Tự tối ưu độ nhạy kéo cá (bandit theo độ khó của thanh) ---- */
  const ARMS = [0.10, 0.14, 0.19, 0.26];     // tầm nhìn xa (giây): nhỏ = gắt, lớn = êm
  const ARM_DEFAULT = 1;
  const FIXED_ARM = { soft: 2, std: 1, hard: 0 };
  const TUNE_KEY = 'hh3d_fish_tune_v2';
  const TUNE = { stats: {}, wRef: {}, algo: {} };
  let cfgAlgo = 'auto';        // 'auto' = tự chọn cách tốt nhất theo kết quả thật | 'classic' = cổ điển | 'advanced' = mô hình dự đoán
  let clPrev = null, clVel = { fish: 0, zone: 0 }, clLastDecide = -1e9, clStatusAt = 0;
  let cfgReel = 'auto';        // 'auto' | 'soft' | 'std' | 'hard'
  // Kiểu nhấn khi kéo cá. Game dặn "Giữ nút để nâng khung, đừng nhấp" → mặc định giữ lâu như người chơi.
  const PRESS = { calm: { h: 220, r: 110 }, steady: { h: 130, r: 80 }, fast: { h: 0, r: 0 }, custom: { h: 200, r: 100 } };
  let cfgPress = 'auto';     // 'auto' | 'calm' | 'steady' | 'fast' | 'custom'
  let autoPress = 'fast';   // kiểu đang dùng khi cfgPress = auto (leo thang sang 'steady' → 'calm' mỗi khi game nhắc "đừng nhấp")
  let lastHintCheck = 0;
  const pressKey = () => (cfgPress === 'auto' ? autoPress : cfgPress);
  let pressHInput = null, pressRInput = null;
  let pressSelect = null;
  let resultTextLogs = 0;
  try { const raw = PAGE.localStorage.getItem(TUNE_KEY); if (raw) Object.assign(TUNE, JSON.parse(raw)); } catch (_) {}
  function saveTune() { try { PAGE.localStorage.setItem(TUNE_KEY, JSON.stringify(TUNE)); } catch (_) {} }
  function tierOf(src, w) {
    const ref = Math.max(TUNE.wRef[src] || 0, w);
    TUNE.wRef[src] = ref;
    const r = w / ref;
    return r < 0.62 ? 0 : (r < 0.85 ? 1 : 2);   // 0 = khung nhỏ (khó), 2 = khung lớn (dễ)
  }
  // Chọn cách kéo cho lần này: thăm dò mỗi cách ≥2 lần/bậc rồi chọn cách có kết quả tốt hơn (hòa → cổ điển).
  function pickAlg(tier) {
    const st = (TUNE.algo && TUNE.algo[tier]) || {};
    const n = (a) => (st[a] ? st[a].n : 0);
    const m = (a) => (st[a] && st[a].n ? st[a].sum / st[a].n : 0);
    if (n('classic') < 2 || n('mpc') < 2) return n('classic') <= n('mpc') ? 'classic' : 'mpc';
    if (Math.random() < 0.12) return Math.random() < 0.5 ? 'classic' : 'mpc';
    return m('mpc') > m('classic') + 0.03 ? 'mpc' : 'classic';
  }
  function recordAlgResult(tier, alg, ok, ratio) {
    const sa = (TUNE.algo[tier] || (TUNE.algo[tier] = {}));
    const e = sa[alg] || (sa[alg] = { n: 0, sum: 0 });
    e.n++; e.sum += 0.65 * (ok ? 1 : 0) + 0.35 * ratio;
    saveTune();
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
  // Game nhắc "giữ nút, đừng nhấp" → ở chế độ Tự động chuyển sang kiểu nhấn êm (giữ lâu) và nhớ cho lần sau.
  function onPressHint() {
    if (cfgPress === 'auto' && autoPress !== 'calm') {
      autoPress = autoPress === 'fast' ? 'steady' : 'calm';
      const P = PRESS[autoPress];
      try { const c = RS.src ? reelCtls[RS.src] : null; if (c) c.setDwell(P.h, P.r); } catch (_) {}
      log(`→ Tự động: game nhắc "đừng nhấp" → nhấn dài hơn (giữ ≥ ${P.h}ms, thả ≥ ${P.r}ms).`);
    }
  }
  function checkPressHint() {
    try {
      if (cfgPress !== 'auto' || autoPress === 'calm' || cfgAlgo === 'classic' || (RS.alg || 'mpc') === 'classic') return;
      const nowT = performance.now();
      if (nowT - lastHintCheck < 1500) return;
      lastHintCheck = nowT;
      for (const t of textSnapshot()) if (/dung\s*nhap|khong\s*nhap/.test(normalize(t))) { log('Game nhắc: «' + t.slice(0, 50) + '»'); onPressHint(); return; }
    } catch (_) {}
  }

  // Game hiện thẻ kết quả (tên cá, "6,26 kg · 85 cm") khi câu được — dù cá bị tự bán thì giỏ cũng không tăng.
  function resultSeen(base) {
    const o = { card: false, lost: false, texts: [] };
    try {
      if (!base) return o;
      const fresh = [...textSnapshot()].filter(t => !base.has(t));
      o.texts = fresh;
      o.card = fresh.some(t => /\d[\d.,]*\s*kg\b/i.test(t));
      o.lost = !o.card && fresh.some(t => /(thoat|tuot|dut day|mat ca|that bai|chay mat|bo tron)/.test(normalize(t)));
    } catch (_) {}
    return o;
  }

  function analyzeFishText() {
    try {
      if (!running || lastState !== 'reel' || !textBase) return;
      const now = textSnapshot();
      const fresh = [...now].filter(t => !textBase.has(t) && !/^[\d\s.,:%/+\-–]+$/.test(t)).slice(0, 6);
      textBase = null;
      RS.baseSet = now;
      const joined = fresh.join(' ');
      if (/dung\s*nhap|khong\s*nhap/.test(normalize(joined))) {
        log(`Game nhắc: ${fresh.filter(t => /nhấp|nhap/i.test(normalize(t))).map(t => '«' + t.slice(0, 50) + '»').join(' ')}`);
        onPressHint();
      }
      const m = /★\s*(\d)/.exec(joined) || /(\d)\s*sao\b/i.exec(normalize(joined));
      const stars = m ? Number(m[1]) : null;
      RS.stars = stars;
      if (fresh.length && (fishTextLogs < 4 || stars != null)) {
        fishTextLogs++;
        log(`Chữ mới khi kéo: ${fresh.map(t => '«' + t.slice(0, 40) + '»').join(' ')}${stars != null ? ` → độ hiếm ★${stars}` : ''}.`);
      }
    } catch (_) {}
  }
  const RS = { alg: '', switched: false, ctx: null, net: null, recorded: false, stars: null, t0: 0, last: 0, tot: 0, inT: 0, err: 0, src: '', w: 0, arm: -1, tier: 1, bag0: null, loose: 0, miss: 0, looseLogged: false, ratioNow: 0, presses: 0, holdSum: 0, holdMax: 0, holdMin: 1e9, pressT0: 0, baseSet: null };

  function reelBegin() {
    Object.assign(RS, { stars: null, t0: performance.now(), last: 0, tot: 0, inT: 0, err: 0, src: '', w: 0, arm: -1, tier: 1, loose: 0, miss: 0, looseLogged: false, ratioNow: 0, recovered: false, aH: 0, aF: 0, ovr: 0, presses: 0, holdSum: 0, holdMax: 0, holdMin: 1e9, pressT0: 0, baseSet: null, alg: '', switched: false, ctx: null, net: null, recorded: false });
    try { RS.ctx = readConditions(); RS.net = readPing(); } catch (_) {}
    const b = readBagCount(false);
    RS.bag0 = b ? b.count : null;
  }

  // Tổng kết một lần kéo cá + cập nhật bộ tự tối ưu.
  function reelFinish() {
    const snap = Object.assign({}, RS);
    const dur = (performance.now() - snap.t0) / 1000;
    const ratio = snap.tot > 0 ? snap.inT / snap.tot : 0;
    const err = snap.tot > 0 ? snap.err / snap.tot : 0;
    const wasAbandoned = false;
    setTimeout(() => {
      let ok = null;
      const b1 = readBagCount(true);
      if (snap.bag0 != null && b1) ok = b1.count > snap.bag0;
      const rs = resultSeen(snap.baseSet);
      if (rs.card && !snap.recorded) { snap.recorded = true; try { const pc = parseCatchTexts(rs.texts); if (pc) recordCatch(snap.ctx || readConditions(), pc); } catch (_) {} }
      if (rs.card) ok = true;                       // có thẻ kết quả (kg) → đã câu được (kể cả khi game tự bán cá ★1–2)
      else if (rs.lost && !ok) ok = false;
      const guessed = ok == null;
      if (guessed) ok = ratio >= 0.5 && dur >= 2.5;
      if (wasAbandoned) ok = false;
      if (snap.src && reelCtls[snap.src] && snap.tot > 1 && (wasAbandoned || ratio < 0.3)) reelCtls[snap.src].resetModel();   // bỏ cá / lần kéo kém → đừng giữ mô hình lệch
      if (ok) stats.caught++; else stats.lost++;
      updateStats();
      const fmtW = snap.src === 'draw2d' ? snap.w.toFixed(0) + 'px' : snap.w.toFixed(2);
      log(`Kéo xong ${dur.toFixed(1)}s · cách ${snap.alg === 'classic' ? 'cổ điển' : (snap.alg === 'mpc' ? 'dự đoán' : '?')} · trong khung ${(ratio * 100).toFixed(0)}% · lệch TB ${err.toFixed(2)}×khung · ${snap.src || '?'}${snap.loose ? ' (dự phòng)' : ''} · khung ${fmtW} · bậc ${snap.tier}/${snap.arm >= 0 ? ARMS[snap.arm] + 's' : '-'} · mất tín hiệu ${snap.miss} khung${snap.net ? ` · ping ${snap.net.ping}ms${snap.net.fps ? '/FPS ' + snap.net.fps : ''}` : ''} · nhấp ${snap.presses} lần${snap.presses ? ` (giữ TB ${(snap.holdSum / snap.presses / 1000).toFixed(2)}s, ngắn nhất ${(snap.holdMin / 1000).toFixed(2)}s)` : ''} · mô hình giữ ${(snap.aH || 0).toFixed(0)}/thả ${(snap.aF || 0).toFixed(0)}${snap.ovr ? ` · chốt an toàn ${snap.ovr}` : ''} → ${wasAbandoned ? '⏭ bỏ cá' : (ok ? '✅ câu được' : '❌ hụt')}${guessed && !wasAbandoned ? ' (ước đoán)' : ''}.`);
      if (!wasAbandoned) {      // giỏ / thẻ kết quả có thể xuất hiện muộn → kiểm tra lại (và ghi sổ tay cá)
        const wasOk = !!ok;
        for (const d of [600, 1400, 2600]) setTimeout(() => {
          if (snap.recorded && (wasOk || snap.reclassed)) return;
          const b2 = (!wasOk && snap.bag0 != null) ? readBagCount(true) : null;
          const rsl = resultSeen(snap.baseSet);
          if (rsl.card && !snap.recorded) { snap.recorded = true; try { const pc = parseCatchTexts(rsl.texts); if (pc) recordCatch(snap.ctx || readConditions(), pc); } catch (_) {} }
          if (!wasOk && !snap.reclassed && ((b2 && b2.count > snap.bag0) || rsl.card)) {
            snap.reclassed = true; stats.lost = Math.max(0, stats.lost - 1); stats.caught++; updateStats();
            log('✔ Cập nhật: giỏ tăng / có thẻ kết quả muộn → lần kéo trước thực ra ĐÃ câu được.');
          }
        }, d);
      }
      setTimeout(() => {      // chữ game hiện sau khi kéo xong (để biết thông báo kết quả)
        try {
          if (!snap.baseSet || resultTextLogs >= 8) return;
          const fresh = [...textSnapshot()].filter(t => !snap.baseSet.has(t) && !/^[\d\s.,:%/+\-–]+$/.test(t)).slice(0, 8);
          if (fresh.length) { resultTextLogs++; log(`Chữ sau khi kéo: ${fresh.map(t => '«' + t.slice(0, 40) + '»').join(' ')}.`); }
        } catch (_) {}
      }, 400);
      if (cfgAlgo === 'auto' && snap.alg && snap.tot > 1 && !guessed) recordAlgResult(snap.tier, snap.alg, ok, ratio);
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

  // Bộ kéo cá "cổ điển" — cách làm của bản 0.4.x vốn chạy ổn định ngoài đời thật:
  // so vị trí khung với cá (có dự đoán ngắn), GIỮ liền khi khung nằm dưới cá, THẢ khi khung vượt quá cá.
  // Quyết định ~mỗi 90ms, GIỮ/THẢ theo từng đoạn dài nên khung leo nhanh và không bị "nhấp".
  function classicStep(g) {
    if (!clPrev) clPrev = g;
    if (g.now - clLastDecide < 85) return;
    clLastDecide = g.now;
    if (g.now - clPrev.now >= 12) {
      const dt = Math.max(0.03, (g.now - clPrev.now) / 1000);
      clVel = dt < 0.4 ? { fish: (g.fish - clPrev.fish) / dt, zone: (g.zone - clPrev.zone) / dt } : { fish: 0, zone: 0 };
      clPrev = g;
    }
    const fishV = clVel.fish, zoneV = clVel.zone;
    let diffTxt;
    if (g.source === 'draw2d') {
      const fishAhead = g.fish + clamp(fishV * .10, -16, 16);
      const zoneAhead = g.zone + clamp(zoneV * .05, -9, 9);
      const diff = zoneAhead - fishAhead;                         // y màn hình hướng xuống: diff > 0 = khung nằm DƯỚI cá
      const dead = Math.max(3, Math.min(11, g.width * .18));
      if (holdWanted) { if (diff < -dead) setHold(false); } else if (diff > dead) setHold(true);
      diffTxt = `Vẽ 2D · Cá Y=${g.fish.toFixed(0)} · Cam Y=${g.zone.toFixed(0)} · Δ=${diff.toFixed(0)}px`;
    } else {
      const predict = CFG.reelPredictionSec;
      const targetFish = clamp(g.fish + fishV * predict, 0.02, 0.98);
      const predictedZone = clamp(g.zone + zoneV * (predict * 0.55), 0.02, 0.98);
      const err = targetFish - predictedZone;                     // > 0: khung nằm dưới cá (hướng lên dương)
      const dead = clamp(g.width * 0.14, CFG.reelDeadbandMin, CFG.reelDeadbandMax);
      if (holdWanted) {
        if (err < -dead || g.zone > 1 - g.width / 2 - 0.012) setHold(false);
      } else if (err > dead || (g.zone < g.width / 2 + 0.012 && g.fish > g.zone)) setHold(true);
      diffTxt = `${g.source} · Cá ${(g.fish * 100).toFixed(0)}% · Khung ${(g.zone * 100).toFixed(0)}% · Δ=${(err * 100).toFixed(0)}%`;
    }
    const nowT = performance.now();
    if (nowT - clStatusAt > 140) {
      clStatusAt = nowT;
      setStatus(`${diffTxt} · ${holdWanted ? 'GIỮ' : 'THẢ'} · ${(RS.ratioNow * 100).toFixed(0)}% trong khung`, 'Cân cá');
    }
  }

  function reelStep() {
    if (!running || lastState !== 'reel') return;
    const g = readGauge();
    if (!g) {
      gaugeMisses++; RS.miss++;
      if ((RS.alg || (cfgAlgo === 'advanced' ? 'mpc' : 'classic')) === 'classic') {
        if (holdWanted) setHold(false);
        if (gaugeMisses === 8 || gaugeMisses % 120 === 0) log(`Không có gauge · Canvas2D=${DRAW_PROBE.supported ? 'có' : 'không'}, tuổi=${DRAW_PROBE.last ? Math.round(performance.now() - DRAW_PROBE.last.at) + 'ms' : 'chưa có'}.`);
        return;
      }
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
    let firstSample = false;
    if (reelFirst) {
      firstSample = true;
      reelFirst = false; reelT0 = performance.now(); reelSamples = 0;
      RS.src = g.source; RS.w = g.width;
      RS.tier = tierOf(g.source, g.width);
      RS.alg = cfgAlgo === 'auto' ? pickAlg(RS.tier) : (cfgAlgo === 'advanced' ? 'mpc' : 'classic');
      clPrev = null; clVel = { fish: 0, zone: 0 }; clLastDecide = -1e9; clStatusAt = 0;
    }
    const classic = RS.alg === 'classic';
    const ctl = classic ? null : ctlFor(g.source);
    if (firstSample && !classic) {
      ctl.reset();
      RS.arm = pickArm(RS.tier);
      ctl.setHorizon(ARMS[RS.arm]);
      { const P = PRESS[pressKey()] || PRESS.fast; ctl.setDwell(P.h, P.r); }
    }
    reelSamples++;
    if (!classic) checkPressHint();
    const dtS = RS.last ? Math.min(0.2, Math.max(0, (g.now - RS.last) / 1000)) : 0;
    RS.last = g.now;
    if (dtS > 0) {
      const e = Math.abs(g.fish - g.zone) / Math.max(1e-6, g.width);
      RS.tot += dtS; RS.err += e * dtS;
      if (e <= 0.5) RS.inT += dtS;
      RS.ratioNow = RS.tot > 0 ? RS.inT / RS.tot : 0;
    }
    // Chế độ Tự động: nếu cách đang dùng bám cá quá kém ngay từ đầu → đổi sang cách còn lại cho phần còn lại của lần kéo.
    if (cfgAlgo === 'auto' && !RS.switched && RS.tot > 1.4 && RS.inT / RS.tot < 0.2) {
      RS.switched = true;
      const from = RS.alg, to = from === 'classic' ? 'mpc' : 'classic';
      const pct = Math.round(RS.inT / RS.tot * 100);
      recordAlgResult(RS.tier, from, false, RS.inT / RS.tot);
      RS.alg = to; RS.tot = 0; RS.inT = 0; RS.err = 0;
      clPrev = null; clVel = { fish: 0, zone: 0 }; clLastDecide = -1e9;
      if (to === 'mpc') {
        const c2 = ctlFor(g.source);
        c2.reset();
        RS.arm = pickArm(RS.tier);
        c2.setHorizon(ARMS[RS.arm]);
        { const P = PRESS[pressKey()] || PRESS.fast; c2.setDwell(P.h, P.r); }
      }
      log(`Cách ${from === 'classic' ? 'cổ điển' : 'dự đoán'} chỉ bám cá ${pct}% → đổi sang cách ${to === 'classic' ? 'cổ điển' : 'dự đoán'} ngay trong lần kéo này.`);
      return;
    }
    if (classic) { classicStep(g); return; }
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

  // Hộp hỏi xác nhận, vd. «Bán cả 2 cá hiếm ★4+?» [Thôi] [Bán]: tìm câu hỏi rồi chọn nút KHÔNG phải "Thôi/Hủy".
  const CANCEL_RX = /^(thoi|huy|khong|khong ban|quay lai|de sau|bo qua|tu choi|dong|x|×|✕|✖)$/;
  const NEVER_RX = /^(tha\b|bo\s*chon)|ve ho|chon\s*(tat|het)/;
  function findConfirmDialog(exclude, opts) {
    const out = { present: false, btn: null, question: '', labels: [] };
    try {
      const walker = DOC.createTreeWalker(DOC.body, PAGE.NodeFilter.SHOW_TEXT);
      const qs = [];
      while (walker.nextNode() && qs.length < 4) {
        const n = walker.currentNode;
        const v = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (v.length < 6 || v.length > 120 || v.indexOf('?') < 0) continue;
        const pe = n.parentElement;
        if (!pe || pe.closest('#' + ROOT_ID) || !isVisible(pe)) continue;
        if (!/(ban|xac nhan|chac chan|hiem|huyen thoai|tha)/.test(normalize(v))) continue;
        qs.push({ el: pe, text: v });
      }
      for (const q of qs) {
        let c = q.el;
        for (let k = 0; k < 7 && c && c !== DOC.body; k++, c = c.parentElement) {
          const btns = [...c.querySelectorAll('button,[role="button"]')]
            .filter(b => !(root && root.contains(b)) && !b.disabled && isVisible(b));
          if (btns.length < 2) continue;
          out.present = true; out.question = q.text;
          out.labels = btns.map(b => normLabel(b));
          let best = null, bs = 0;
          for (const b of btns) {
            if (b === exclude) continue;
            if (b.classList && b.classList.contains('fish-bag-chip')) continue;
            const t = normLabel(b);
            if (CANCEL_RX.test(t) || ((opts && opts.allowRelease) ? /^bo\s*chon|chon\s*(tat|het)/ : NEVER_RX).test(t)) continue;
            if (/^ban\s+\d+\s+con/.test(t) && !(b.closest('[role="dialog"], [class*="confirm" i], [class*="modal" i], [class*="popup" i]'))) continue;
            let sc = 1;
            if (/^ban\b/.test(t)) sc = 3;
            else if (/dong y|xac nhan|chac chan|^ok$|^co$|van ban|ban luon|tiep tuc|chap nhan/.test(t)) sc = 2;
            if (sc >= bs) { best = b; bs = sc; }          // cùng điểm → lấy nút đứng sau (thường là nút đồng ý)
          }
          if (best) out.btn = best;
          return out;
        }
      }
    } catch (_) {}
    return out;
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


  const findBagButton = () => DOC.querySelector('.fish-quick-bag') ||
    [...DOC.querySelectorAll('button')].find(x => /gio ca/.test(normalize(x.getAttribute('aria-label') || x.textContent)));

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
    bagFlow = {
      reason, stopAfter, stage: 'run',
      startedAt: Date.now(), stageAt: Date.now(), started: false,
      before: bag ? bag.count : null, selected: 0, recheck: false, fallbackTried: false
    };
    setStatus('Đang mở Giỏ cá…', 'Xử lý giỏ');
    log(reason === 'auto' ? 'Tự động bán hết cá trong giỏ.' : 'Bán hết cá trong giỏ (thủ công).');
  }

  function endBagFlow(msg, { sold = false, error = false } = {}) {
    const f = bagFlow;
    if (!f) return;
    bagFlow = null;
    sinceSell = 0;
    bagCache = { at: -1e9, val: null };          // lần đọc sau phải lấy số giỏ MỚI, không dùng số cũ
    try { closeBagFast(); } catch (_) {}
    cooldownUntil = Date.now() + 500;
    setTimeout(() => dismissPopups(null), 350); setTimeout(() => dismissPopups(null), 1100);
    if (msg) log(msg);
    if (f.kind === 'release') {
      if (sold) relFailStreak = 0;
      else if (f.reason === 'auto') {
        relFailStreak++;
        relBlockedUntil = Date.now() + Math.min(20 * 60000, 120000 * Math.pow(2, relFailStreak - 1));
        const bag = readBagCount(true);
        if (bag && bag.count >= bag.capacity - 1) {
          stop('Giỏ đầy: không bán được và cũng không thả được cá. Hãy dọn giỏ thủ công rồi bấm Bắt đầu.');
          return;
        }
      }
    } else if (sold) {
      sellFailStreak = 0;
    } else if (f.reason === 'auto') {
      // Bán không giảm được số cá → KHÔNG thử lại liên tục: nghỉ tăng dần 1,5 → 3 → 6 … tối đa 30 phút.
      sellFailStreak++;
      noSellUntil = Date.now() + Math.min(30 * 60000, CFG.noSellCooldownMs * Math.pow(2, sellFailStreak - 1));
      log(`Bán không được (lần ${sellFailStreak}) → tạm nghỉ tự bán ${Math.round((noSellUntil - Date.now()) / 6000) / 10} phút${sellFailStreak >= 2 ? ' (có thể Ngư Ông đã mua đủ hôm nay)' : ''}.`);
      const bag = readBagCount(true);
      if (bag && bag.count >= bag.capacity - 1) {
        stop('Giỏ đầy nhưng không bán được cá nào. Hãy bán thủ công rồi bấm Bắt đầu (Sao chép log để xem game báo gì).');
        return;
      }
    }
    if (f.stopAfter) stop(msg || 'Xong.');
    else if (msg) setStatus(msg, error ? 'Lỗi giỏ' : 'Giỏ cá');
  }

  // Luồng bán cá chạy liền mạch (không chia stage theo nhịp 90ms nên không bị khựng).
  // Bán THÀNH CÔNG chỉ khi số cá trong giỏ thật sự GIẢM; nếu không thì coi là thất bại.
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

    // 2) chọn tất cả cá
    const info = await selectAllCards(bag);
    log(`Chọn cá để bán: ${info.end}/${info.target || '?'} con (đầu ${info.start}; chip ${info.chips}; hoàn tác ${info.undone}; không đổi ${info.noEffect}; thẻ ${info.cards}).`);
    if (!info.end && !info.cards) {
      const how = selectAllInBag(bag);
      log(how ? `Đã chọn tất cả cá (${how}).` : 'Không thấy nút/chip chọn tất cả; sẽ thử chọn từng ô.');
    } else if (info.target && info.end < info.target) bagDiag('Chưa chọn đủ');
    mark('chọn');
    if (!alive()) return;

    // 3) tìm + bấm nút Bán
    let btn = findSellButton(bag);
    if (!btn) {
      await waitFor(() => (btn = findSellButton(bag)), 900, 30);
      if (!btn && !f.fallbackTried) {
        f.fallbackTried = true;
        const n = selectEachFish(bag);
        log(`Chưa có nút Bán → bấm thử ${n} ô cá.`);
        await waitFor(() => (btn = findSellButton(bag)), 900, 30);
      }
    }
    if (!btn) { bagDiag('Bán cá'); endBagFlow('Không thấy nút Bán cá (xem log "nút trong giỏ").', { error: true }); return; }
    const nBtn = Number((normLabel(btn).match(/(\d+)/) || [])[1] || 0);
    f.selected = nBtn || info.end || f.selected;
    if (!f.selected) { bagDiag('Không chọn được cá'); endBagFlow('Không chọn được con cá nào để bán.', { error: true }); return; }
    log(`Bấm "${(btn.textContent || '').trim().replace(/\s+/g, ' ')}".`);
    const cardsBefore = findFishCards(bag).length;
    const textBefore = textSnapshot();
    btn.click();

    // 4) xác nhận (nếu game hỏi) + chờ số cá GIẢM (đọc nhanh mỗi 30ms, tối đa 4s)
    const t1 = performance.now();
    let confirmed = 0, left = null, done = false, lastFull = t1, lastPop = t1, said = new Set(), saidAt = 0, asked = false;
    const hudKnown = f.before != null;
    const collectSaid = () => { try { for (const t of textSnapshot()) if (!textBefore.has(t) && !/^[\d\s.,:%/+\-–]+$/.test(t)) said.add(t); } catch (_) {} };
    while (alive() && performance.now() - t1 < 3000) {
      let cur = quickBagCount();
      if (!cur && performance.now() - lastFull > 400) { lastFull = performance.now(); cur = readBagCount(true); }
      if (cur && hudKnown && cur.count < f.before) { left = cur.count; done = true; break; }
      if (!hudKnown && cardsBefore && isBagOpen() && findFishCards(bag).length < cardsBefore) { done = true; break; }   // không đọc được số giỏ → dựa vào thẻ cá biến mất
      const cd = findConfirmDialog(btn);
      if (cd.present && confirmed < 3) {
        if (cd.btn) {
          log(`Xác nhận «${cd.question.slice(0, 50)}» → bấm "${(cd.btn.textContent || '').trim().replace(/\s+/g, ' ')}".`);
          cd.btn.click(); confirmed++; await sleep(80); continue;
        }
        if (!asked) { asked = true; log(`Game hỏi «${cd.question.slice(0, 50)}» nhưng không thấy nút đồng ý (các nút: ${cd.labels.join(' | ')}).`); }
      } else if (!cd.present) {
        const cb = findConfirmButton();
        if (cb && confirmed < 3) { log(`Xác nhận: "${(cb.textContent || '').trim().replace(/\s+/g, ' ')}".`); cb.click(); confirmed++; await sleep(60); continue; }
      }
      if (!cd.present && performance.now() - lastPop > 200) { lastPop = performance.now(); dismissPopups(bag); }   // hộp chúc mừng chặn việc bán
      if (performance.now() - saidAt > 450) { saidAt = performance.now(); collectSaid(); }           // thông báo thoáng qua của game
      await sleep(30);
    }
    mark('bán');
    if (!alive()) return;
    if (!done) {
      // Thất bại: ghi lại game báo gì để biết lý do (vd. Ngư Ông đã mua đủ hôm nay).
      collectSaid();
      const fresh = [...said].slice(0, 6);
      const saidTxt = fresh.length ? ` Game báo: ${fresh.map(t => '«' + t.slice(0, 60) + '»').join(' ')}` : '';
      bagDiag('Bán không giảm số cá');
      log(`⏱ ${marks.join(' · ')}`);
      endBagFlow(`Đã bấm bán nhưng số cá trong giỏ KHÔNG giảm.${saidTxt}`, { error: true });
      return;
    }
    await sleep(80);
    dismissPopups(bag);                                    // hộp chúc mừng cá kỷ lục / cá hiếm
    if (left == null) { const cur = readBagCount(true); left = cur ? cur.count : null; }
    const sold = (f.before != null && left != null) ? Math.max(0, f.before - left) : (f.selected || 0);
    stats.sold += sold;
    updateStats();
    mark('đóng');
    log(`⏱ ${marks.join(' · ')}`);
    endBagFlow(`Đã bán ${sold > 0 ? sold + ' con' : 'cá'}${left != null ? `; giỏ còn ${left}${(before && before.capacity) ? '/' + before.capacity : ''}` : ''}.`, { sold: true });
  }


  async function tickBagFlow() {
    const f = bagFlow;
    if (!f) return;
    if (Date.now() - f.startedAt > 45000) { bagDiag('Quá thời gian'); endBagFlow('Bán cá quá thời gian.', { error: true }); return; }
    if (f.started) return;
    f.started = true;
    (f.kind === 'release' ? runReleaseFlow : runBagFlow)(f).catch(e => { try { endBagFlow(`Lỗi khi bán cá: ${e && e.message || e}`, { error: true }); } catch (_) {} });
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
    log(`Kiểm tra: state=${st}; mode=${currentMode()} (chọn: ${cfgMode}); cách ném=${(currentCombo() || {}).kind}/${(currentCombo() || {}).mode} (điểm: ${aim ? aim.x + '/' + aim.y + '%' : 'theo game'}); handler down/move/up — trên nút=${f(hs.own)}, cả chuỗi=${f(hs.chain)}; giỏ=${bag ? `${bag.count}/${bag.capacity}` : '?'}${stam ? `; sức câu=${stam.value}/${stam.max}` : ''}${g ? `; gauge(${g.source}) cá=${g.fish.toFixed(2)} khung=${g.zone.toFixed(2)}` : ''}.`);
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
    { const nt = readPing(); const cd = readConditions(); log(`Mạng: ${nt ? `ping ${nt.ping}ms${nt.fps ? ', FPS ' + nt.fps : ''}` : 'không đọc được'} · Điều kiện: ${cd.tod || '?'} · ${cd.weather || '?'} · điểm câu «${cd.spot || '?'}»${cd.tide ? ' · ' + cd.tide : ''}.`); }
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
        if (state === 'wait') { textBase = textSnapshot(); }
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
        const bagFull = !!(bag && bag.count >= bag.capacity - CFG.sellMargin);
        if (autoSell && now >= noSellUntil) {
          if (bagFull) { startBagFlow('auto', false); return; }
          if (!bag && CFG.blindSellEvery > 0 && sinceSell >= CFG.blindSellEvery) {
            log(`Không đọc được số cá trong giỏ → bán sau ${sinceSell} lần kéo.`);
            startBagFlow('auto', false);
            return;
          }
        } else if (bagFull && (relOn12 || relOn3) && now >= relBlockedUntil) {
          log(`Giỏ ${bag.count}/${bag.capacity} mà ${autoSell ? 'đang không bán được' : 'tự bán đang tắt'} → thả cá hạng thấp về hồ.`);
          startReleaseFlow('auto', false);
          return;
        }

        if (autoSpot && now - lastSpotSwitch > 120000 && now - lastActionAt >= CFG.actionCooldownMs) {
          let sw = false;
          try { sw = await maybeSwitchSpot(); } catch (e) { log('🧭 Lỗi: ' + (e && e.message || e)); spotFailUntil = Date.now() + 300000; }
          if (sw) { cooldownUntil = Date.now() + 700; return; }
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
   * 11b) Thả cá về hồ · Sổ tay cá tự học (thời tiết / điểm câu → loại cá)
   * ------------------------------------------------------------------ */
  const INFO_ID = 'hh3d-fish-info-root';
  const DEX_KEY = 'hh3d_fish_dex_v1';
  const dex = { catches: [], spots: [], book: [] };
  let relOn12 = false, relOn3 = false, relFailStreak = 0, relBlockedUntil = 0;
  let infoRoot = null, infoPanel = null, infoBody = null, infoPos = { right: 9, top: 142 };
  let infoWantOpen = false, infoSig = '', infoTarget = '', infoTimer = 0, infoDragEnded = false;
  let pingEl = null, pingScanAt = 0;

  /* ---- Thả cá hạng thấp về hồ khi Ngư Ông không mua thêm ---- */
  const findReleaseButton = (bag) => bagButtons(bag).find(x => !x.disabled && /^tha\b|tha ve ho/.test(normLabel(x))) || null;

  function startReleaseFlow(reason = 'manual', stopAfter = false) {
    if (bagFlow) return;
    if (!running && reason === 'manual') {
      running = true;
      if (!loopHandle) loopHandle = setInterval(tick, CFG.pollMs);
    }
    const bag = readBagCount(true);
    bagFlow = {
      kind: 'release', reason, stopAfter, stage: 'run',
      startedAt: Date.now(), stageAt: Date.now(), started: false,
      before: bag ? bag.count : null, selected: 0
    };
    setStatus('Đang mở Giỏ cá để thả cá…', 'Thả cá');
    log(`Thả cá ${[relOn12 && '★1–2', relOn3 && '★3'].filter(Boolean).join(' + ')} về hồ (${reason === 'auto' ? 'tự động' : 'thủ công'}).`);
  }

  async function runReleaseFlow(f) {
    const T0 = performance.now();
    const alive = () => bagFlow === f && performance.now() - T0 < 30000;
    if (!isBagOpen()) {
      const b = findBagButton();
      if (!b) { endBagFlow('Không tìm thấy nút Giỏ cá.', { error: true }); return; }
      b.click();
      if (!await waitFor(isBagOpen, 3500, 25)) { endBagFlow('Không mở được Giỏ cá.', { error: true }); return; }
    }
    await waitFor(() => { const x = DOC.querySelector('.fish-bag'); return x && x.querySelector('button'); }, 1500, 25);
    await nextFrame(); await nextFrame();
    const bag = DOC.querySelector('.fish-bag');
    if (!bag || !alive()) { endBagFlow('Giỏ cá vừa đóng lại.', { error: true }); return; }
    const cb = readBagCount(true);
    if (cb) f.before = cb.count;

    // bỏ chọn hết rồi chọn đúng nhóm ★ cần thả
    const clr = bagButtons(bag).find(x => /^bo\s*chon/.test(normLabel(x)) && !x.disabled);
    if (clr && selCountOf(bag) > 0) { clr.click(); await waitFor(() => selCountOf(bag) === 0, 700, 30); }
    let n = selCountOf(bag);
    const picked = [];
    for (const c of bag.querySelectorAll('.fish-bag-chip')) {
      const m = /★\s*(\d)(?:\s*[–-]\s*(\d))?/.exec(c.textContent || c.getAttribute('aria-label') || '');
      let lo, hi, tag;
      if (m) { lo = Number(m[1]); hi = m[2] ? Number(m[2]) : lo; tag = `★${m[1]}${m[2] ? '–' + m[2] : ''}`; }
      else {
        const dr = (c.dataset && c.dataset.r) || c.getAttribute('data-r') || '';
        if (dr === '12') { lo = 1; hi = 2; tag = '★1–2'; } else if (/^\d$/.test(dr)) { lo = hi = Number(dr); tag = '★' + dr; } else continue;
      }
      const want = (relOn12 && hi <= 2) || (relOn3 && lo === 3 && hi === 3);
      if (!want || c.disabled) continue;
      const b0 = n;
      const n2 = await tapAndWatch(c, bag, b0, 'click');
      if (n2 < b0) { await tapAndWatch(c, bag, n2, 'click'); n = selCountOf(bag); } else n = Math.max(n, n2);
      if (n > b0) picked.push(tag);
    }
    if (!alive()) return;
    const want = [relOn12 && '★1–2', relOn3 && '★3'].filter(Boolean).join(' + ');
    if (n <= 0) {
      log(`Các nhóm trong giỏ: ${[...bag.querySelectorAll('.fish-bag-chip')].map(c => (c.textContent || '').trim().replace(/\s+/g, ' ') + (c.disabled ? '(tắt)' : '')).join(' | ') || '—'}.`);
      endBagFlow(`Không chọn được cá ${want} để thả.`, { sold: false, error: true }); return;
    }
    const rbtn = findReleaseButton(bag);
    if (!rbtn) { bagDiag('Thả cá'); endBagFlow('Không thấy nút "Thả về hồ".', { error: true }); return; }
    f.selected = n;
    log(`Thả ${n} con (${picked.join(', ')}) về hồ — bấm "${(rbtn.textContent || '').trim().replace(/\s+/g, ' ')}".`);
    const cardsBefore = findFishCards(bag).length;
    const textBefore = textSnapshot();
    rbtn.click();

    // xác nhận (nếu game hỏi) + chờ số cá GIẢM
    const t1 = performance.now();
    let confirmed = 0, left = null, done = false, lastFull = t1;
    const hudKnown = f.before != null;
    while (alive() && performance.now() - t1 < 3200) {
      let cur = quickBagCount();
      if (!cur && performance.now() - lastFull > 400) { lastFull = performance.now(); cur = readBagCount(true); }
      if (cur && hudKnown && cur.count < f.before) { left = cur.count; done = true; break; }
      if (!hudKnown && cardsBefore && isBagOpen() && findFishCards(bag).length < cardsBefore) { done = true; break; }
      const cd = findConfirmDialog(rbtn, { allowRelease: true });
      if (cd.present && cd.btn && confirmed < 3) {
        log(`Xác nhận «${cd.question.slice(0, 50)}» → bấm "${(cd.btn.textContent || '').trim().replace(/\s+/g, ' ')}".`);
        cd.btn.click(); confirmed++; await sleep(80); continue;
      }
      await sleep(30);
    }
    if (!alive()) return;
    if (!done) {
      let said = '';
      try {
        const fresh = [...textSnapshot()].filter(t => !textBefore.has(t) && !/^[\d\s.,:%/+\-–]+$/.test(t)).slice(0, 5);
        said = fresh.length ? ` Game báo: ${fresh.map(t => '«' + t.slice(0, 60) + '»').join(' ')}` : '';
      } catch (_) {}
      bagDiag('Thả cá không giảm số cá');
      endBagFlow(`Đã bấm thả nhưng số cá trong giỏ KHÔNG giảm.${said}`, { error: true });
      return;
    }
    await sleep(80);
    if (left == null) { const c2 = readBagCount(true); left = c2 ? c2.count : null; }
    const released = (f.before != null && left != null) ? Math.max(0, f.before - left) : n;
    stats.released += released;
    updateStats();
    endBagFlow(`Đã thả ${released} con về hồ${left != null ? `; giỏ còn ${left}` : ''}.`, { sold: true });
  }

  /* ---- Đọc điều kiện hiện tại (giờ · thời tiết · điểm câu) và ping ---- */
  function readConditions() {
    const o = { tod: '', weather: '', spot: '', tide: '' };
    try {
      const txt = (el) => ((el && el.textContent) || '').replace(/\s+/g, ' ').trim();
      const cond = DOC.querySelector('.fish-cond');
      if (cond) {
        const parts = txt(cond).split(/\s*[·•|]\s*/);
        o.tod = parts[0] || '';
        o.weather = parts.slice(1).join(' · ');
      }
      const tide = DOC.querySelector('.fish-tide');
      if (tide) o.tide = txt(tide);
      const spotText = (t) => t.replace(/^\s*điểm\s*câu\s*[:\-]?\s*/i, '').replace(/[▾▼⌄˅]\s*$/, '').trim();
      let sp = DOC.querySelector('.fish-spot');
      let st = sp ? spotText(txt(sp)) : '';
      if (!st || /^doi diem cau/.test(normalize(st))) {
        st = '';
        for (const e of DOC.querySelectorAll('button,span,div')) {
          if (e.children.length) continue;
          const t = txt(e);
          if (t.length < 40 && /^diem cau\s+\S/.test(normalize(t))) { st = spotText(t); break; }
        }
      }
      o.spot = isRealSpot(st) ? st : '';
    } catch (_) {}
    return o;
  }

  function readPing() {
    try {
      const nowT = performance.now();
      if ((!pingEl || !pingEl.isConnected) && nowT - pingScanAt > 5000) {
        pingScanAt = nowT; pingEl = null;
        for (const e of DOC.querySelectorAll('div,span')) {
          if (e.children.length === 0 && /^ping\s*\d+/i.test((e.textContent || '').trim())) { pingEl = e; break; }
        }
      }
      if (!pingEl) return null;
      const t = pingEl.textContent || '';
      const m = /ping\s*(\d+)\s*ms/i.exec(t);
      if (!m) return null;
      const f = /fps\s*(\d+)/i.exec(t);
      return { ping: Number(m[1]), fps: f ? Number(f[1]) : null };
    } catch (_) { return null; }
  }

  /* ---- Sổ tay cá tự học ---- */
  function loadDex() {
    try {
      const d = JSON.parse(PAGE.localStorage.getItem(DEX_KEY) || '{}');
      if (Array.isArray(d.catches)) dex.catches = d.catches.slice(-1500);
      if (Array.isArray(d.spots)) dex.spots = d.spots.filter(x => typeof x === 'string' && isRealSpot(x)).slice(0, 12);
      if (Array.isArray(d.book)) dex.book = d.book.slice(0, 200);
    } catch (_) {}
  }
  function saveDex() {
    try { PAGE.localStorage.setItem(DEX_KEY, JSON.stringify({ catches: dex.catches.slice(-1500), spots: dex.spots, book: dex.book })); } catch (_) {}
  }

  // Nhãn độ hiếm thấy trong game: PHỔ THÔNG < (TỐT) < QUÝ < HIẾM < CỰC HIẾM < HUYỀN THOẠI
  function rarRank(label) {
    const n = normalize(label);
    if (/huyen thoai|than thoai|truyen thuyet/.test(n)) return 6;
    if (/cuc pham|su thi|cuc hiem/.test(n)) return 5;
    if (/hiem/.test(n)) return 4;
    if (/quy/.test(n)) return 3;
    if (/tot|dep|kha|tinh/.test(n)) return 2;
    return 1;                                   // PHỔ THÔNG / thường / không ghi nhãn
  }
  const RAR_W = [0, 1, 2, 6, 14, 30, 60];
  const isRealSpot = (n) => !!n && !/^chon\b/.test(normalize(n));    // bỏ dòng giả "Chọn điểm câu"

  // Thẻ kết quả của game: «CÁ · HUYỀN THOẠI» «Cửu Vĩ Ngư» «6,26 kg · 85 cm»
  function parseCatchTexts(texts) {
    let ki = -1, kg = null, cm = null;
    for (let i = 0; i < texts.length; i++) {
      const m = /(\d[\d.,]*)\s*kg\b(?:\s*[·•\-–]\s*(\d+)\s*cm)?/i.exec(texts[i]);
      if (m) { kg = Number(m[1].replace(',', '.')); cm = m[2] ? Number(m[2]) : null; ki = i; break; }
    }
    if (ki < 0) return null;
    let name = '', rar = '';
    for (let i = ki - 1; i >= 0; i--) {
      const t = texts[i].trim();
      const nt = normalize(t);
      if (/^ca\s*[·•\-–:]\s*\S/.test(nt)) { rar = t.replace(/^[^·•\-–:]*[·•\-–:]\s*/, '').trim(); break; }
      if (!name && t.length >= 2 && t.length <= 40 && !/\d/.test(t) && !/^(khoe ca|nem ca|nem cau|xong|suc cau|thu can|cho ca)/.test(nt)) name = t;
    }
    return { name, rar, kg, cm };
  }

  function recordCatch(ctx, pc) {
    const c = { t: Date.now(), tod: (ctx && ctx.tod) || '', w: (ctx && ctx.weather) || '', spot: (ctx && isRealSpot(ctx.spot) ? ctx.spot : '') || '', name: pc.name || '?', rar: pc.rar || '', kg: pc.kg, cm: pc.cm };
    dex.catches.push(c);
    if (dex.catches.length > 1500) dex.catches.splice(0, dex.catches.length - 1500);
    if (c.spot && !dex.spots.includes(c.spot)) dex.spots.push(c.spot);
    saveDex();
    log(`📖 Ghi nhận: «${c.name}»${c.rar ? ' · ' + c.rar : ''}${c.kg != null ? ' · ' + c.kg + 'kg' : ''} — ${c.w || '?'} · ${c.spot || '?'}.`);
    renderInfo(true);
  }

  function copyText(text, okMsg) {
    const done = () => log(okMsg);
    try { PAGE.navigator.clipboard.writeText(text).then(done, () => { throw new Error('x'); }); return; } catch (_) {}
    try {
      const ta = DOC.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      DOC.body.appendChild(ta); ta.select(); DOC.execCommand('copy'); ta.remove(); done();
    } catch (e) { log('Không sao chép được: ' + (e && e.message || e)); }
  }

  /* ---- Bảng "Thông tin cá" (bật/tắt + kéo di chuyển) ---- */
  function applyInfoPos() {
    if (!infoRoot) return;
    const w = infoRoot.offsetWidth || 46;
    infoPos.right = clamp(Number(infoPos.right) || 0, 0, Math.max(0, PAGE.innerWidth - w));
    infoPos.top = clamp(Number(infoPos.top) || 0, 0, Math.max(0, PAGE.innerHeight - 46));
    infoRoot.style.right = infoPos.right + 'px';
    infoRoot.style.top = infoPos.top + 'px';
  }

  function makeDraggableOf(handle, rootEl, pos, apply, after, onEnd) {
    let active = false, drag = false, pid = null, sx = 0, sy = 0, sr = 0, st = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return;
      if (e.target !== handle && e.target.closest && e.target.closest('button')) return;
      active = true; drag = false; pid = e.pointerId; sx = e.clientX; sy = e.clientY;
      const r = rootEl.getBoundingClientRect();
      sr = PAGE.innerWidth - r.right; st = r.top;
      try { handle.setPointerCapture(pid); } catch (_) {}
    });
    handle.addEventListener('pointermove', (e) => {
      if (!active || e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!drag && Math.hypot(dx, dy) < 8) return;
      drag = true; pos.right = sr - dx; pos.top = st + dy; apply();
    });
    const end = (e) => {
      if (!active || (e && e.pointerId !== pid)) return;
      active = false;
      try { handle.releasePointerCapture(pid); } catch (_) {}
      if (drag) { onEnd(); saveCfg(); after(); }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function buildInfoUI() {
    if (!DOC.body || DOC.getElementById(INFO_ID)) return;
    loadDex(); loadBook();
    infoRoot = DOC.createElement('div');
    infoRoot.id = INFO_ID;
    infoRoot.innerHTML = `
      <style>
        #${INFO_ID} { position:fixed !important; z-index:2147483646 !important; isolation:isolate; pointer-events:auto; right:${infoPos.right}px; top:${infoPos.top}px; width:46px; height:46px; color:#f5f2ff; font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; touch-action:manipulation; }
        #${INFO_ID} * { box-sizing:border-box; }
        #${INFO_ID} .fish-fab { display:flex; align-items:center; justify-content:center; width:46px; height:46px; padding:0; border:1px solid #6aa7e0; border-radius:50%; background:rgba(16,30,45,.94); color:#eaf4ff; font-size:22px; box-shadow:0 3px 12px #0008; cursor:pointer; touch-action:none; user-select:none; }
        #${INFO_ID} .fish-fab.on { box-shadow:0 0 0 3px #6aa7e066, 0 3px 12px #0008; }
        #${INFO_ID} .fish-panel { position:absolute; right:0; top:calc(100% + 6px); width:min(300px, calc(100vw - 16px)); background:rgba(18,22,30,.97); border:1px solid #4b6e8e; border-radius:12px; padding:9px; box-shadow:0 8px 25px #0009; display:none; max-height:min(72vh, 540px); overflow:auto; }
        #${INFO_ID}.left .fish-panel { right:auto; left:0; }
        #${INFO_ID}.up .fish-panel { top:auto; bottom:calc(100% + 6px); }
        #${INFO_ID} .fish-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:800; font-size:13px; margin-bottom:6px; cursor:grab; touch-action:none; user-select:none; }
        #${INFO_ID} .fish-head .grip { opacity:.55; font-weight:400; }
        #${INFO_ID} button.fish-action { border:0; border-radius:8px; padding:7px 8px; color:#fff; background:#38404a; font-weight:700; flex:1; min-width:0; cursor:pointer; font-size:11.5px; }
        #${INFO_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:3px 8px !important; flex:0 0 auto !important; font-size:12px !important; }
        #${INFO_ID} .fish-row { display:flex; gap:6px; margin:5px 0; }
        #${INFO_ID} .ii-cond { background:#232a36; border-radius:8px; padding:7px 8px; font-size:12px; margin-bottom:6px; }
        #${INFO_ID} .ii-rec { background:#16382f; border:1px solid #2e7a62; border-radius:8px; padding:7px 8px; font-size:12px; margin-bottom:6px; }
        #${INFO_ID} .ii-spot { border-top:1px solid #2c3544; padding:5px 0; font-size:11.5px; }
        #${INFO_ID} .ii-spot b { color:#9fd0ff; }
        #${INFO_ID} .ii-cur { color:#7be0b8; }
        #${INFO_ID} .r6, #${INFO_ID} .r5 { color:#ffcf6b; font-weight:700; } #${INFO_ID} .r4 { color:#d79bff; font-weight:700; } #${INFO_ID} .r3 { color:#7fd0ff; font-weight:600; }
        #${INFO_ID} .ii-note { color:#aab4c4; font-size:10.5px; margin:4px 0; }
        #${INFO_ID} select { width:100%; padding:6px; border-radius:6px; border:1px solid #585766; background:#121219; color:#fff; font-size:12px; margin:4px 0; }
      </style>
      <button type="button" class="fish-fab" id="hh3di-fab" title="Thông tin cá: thời tiết · điểm câu · loại cá (chạm để mở, kéo để di chuyển)">🐟</button>
      <section class="fish-panel" id="hh3di-panel">
        <div class="fish-head" id="hh3di-head"><span>🐟 Thông tin cá <span class="grip">⠿ kéo</span></span><button class="fish-action fish-collapse" id="hh3di-hide" type="button">Ẩn</button></div>
        <div id="hh3di-body"></div>
        <div class="ii-note" id="hh3di-prog"></div>
        <label class="ii-note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="hh3di-autospot"> 🧭 Tự chuyển tới điểm câu gợi ý (thử nghiệm)</label>
        <div class="fish-row">
          <button type="button" class="fish-action" id="hh3di-spots" title="Mở danh sách điểm câu của game để ghi lại tên 4 điểm">📍 Quét điểm câu</button>
          <button type="button" class="fish-action" id="hh3di-book" title="Tự mở từng loài trong Sổ Cá, đọc nơi ở / giờ / thời tiết / kích thước. Bấm lần nữa để dừng.">📖 Quét Sổ Cá (đọc hết)</button>
        </div>
        <div class="fish-row">
          <button type="button" class="fish-action" id="hh3di-copy">📋 Sao chép dữ liệu</button>
          <button type="button" class="fish-action" id="hh3di-clear">🗑 Xóa dữ liệu</button>
        </div>
      </section>`;
    (DOC.fullscreenElement && DOC.fullscreenElement !== DOC.documentElement ? DOC.fullscreenElement : DOC.body).appendChild(infoRoot);
    applyInfoPos();

    infoPanel = infoRoot.querySelector('#hh3di-panel');
    infoBody = infoRoot.querySelector('#hh3di-body');
    const fab = infoRoot.querySelector('#hh3di-fab');
    const setOpen = (open) => {
      infoPanel.style.display = open ? 'block' : 'none';
      fab.classList.toggle('on', open);
      if (open) { renderInfo(true); placePanel(infoRoot, infoPanel); }
      saveCfg();
    };
    fab.addEventListener('click', () => { if (!infoDragEnded) setOpen(infoPanel.style.display !== 'block'); });
    infoRoot.querySelector('#hh3di-hide').addEventListener('click', () => setOpen(false));
    const afterDrag = () => placePanel(infoRoot, infoPanel);
    const onEnd = () => { infoDragEnded = true; setTimeout(() => { infoDragEnded = false; }, 150); };
    makeDraggableOf(fab, infoRoot, infoPos, applyInfoPos, afterDrag, onEnd);
    makeDraggableOf(infoRoot.querySelector('#hh3di-head'), infoRoot, infoPos, applyInfoPos, afterDrag, onEnd);

    infoRoot.querySelector('#hh3di-spots').addEventListener('click', scanSpots);
    infoRoot.querySelector('#hh3di-book').addEventListener('click', scanBookFull);
    const asp = infoRoot.querySelector('#hh3di-autospot');
    asp.checked = autoSpot;
    asp.addEventListener('change', e => { autoSpot = !!e.target.checked; saveCfg(); log(`🧭 Tự chuyển điểm câu: ${autoSpot ? 'BẬT' : 'TẮT'}.`); });
    infoRoot.querySelector('#hh3di-copy').addEventListener('click', () => {
      copyText(JSON.stringify({ spots: dex.spots, book: dex.book, catches: dex.catches.slice(-300) }), '📋 Đã sao chép dữ liệu sổ tay cá.');
    });
    infoRoot.querySelector('#hh3di-clear').addEventListener('click', () => {
      if (!PAGE.confirm || PAGE.confirm('Xóa toàn bộ dữ liệu sổ tay cá đã học?')) { dex.catches = []; dex.spots = []; saveDex(); renderInfo(true); log('🗑 Đã xóa dữ liệu sổ tay cá.'); }
    });
    if (!infoTimer) infoTimer = setInterval(() => { try { renderInfo(false); } catch (_) {} }, 1500);
    if (infoWantOpen) setOpen(true);
  }

  function renderInfo(force) {
    if (!infoBody || !infoPanel || infoPanel.style.display !== 'block') return;
    const cond = readConditions();
    const sig = [dex.catches.length, cond.tod, cond.weather, cond.spot, cond.tide, infoTarget, dex.spots.join('|'), bookDB.at, bookDB.species.length, Math.floor(Date.now() / 60000)].join('¦');
    if (!force && sig === infoSig) return;
    infoSig = sig;
    const esc = escapeHtml;
    const W = cond.weather;
    const spotOf = (c) => (isRealSpot(c.spot) ? c.spot : '');
    const inW = dex.catches.filter(c => !W || c.w === W);

    // theo điểm câu (trong thời tiết hiện tại)
    const bySpot = {};
    for (const c of inW) {
      const k = spotOf(c); if (!k) continue;
      const o = bySpot[k] || (bySpot[k] = { n: 0, score: 0 });
      o.n++; o.score += RAR_W[rarRank(c.rar)];
    }
    // theo loài (trong thời tiết hiện tại): ra ở những điểm nào
    const bySp = {};
    for (const c of inW) {
      const f = bySp[c.name] || (bySp[c.name] = { n: 0, rank: 0, rar: '', spots: {} });
      const rk = rarRank(c.rar);
      f.n++; if (rk >= f.rank) { f.rank = rk; f.rar = c.rar; }
      const k = spotOf(c) || '?'; f.spots[k] = (f.spots[k] || 0) + 1;
    }
    const spotNames = [...new Set([...dex.spots, ...Object.keys(bySpot)])].filter(isRealSpot);
    const MIN_N = 5;

    let html = `<div class="ii-cond">🕒 ${esc(cond.tod || '?')} · ☁ <b>${esc(W || '?')}</b>${cond.tide ? ' · 🌊 ' + esc(cond.tide) : ''}<br>📍 Đang câu ở: <b>${esc(cond.spot || '?')}</b></div>`;
    if (bookDB.species.length) {                       // có dữ liệu thật từ Sổ Cá → dùng nó
      html += bookHtml(cond) + `<div class="ii-note">Đã ghi ${dex.catches.length} lần câu của bạn.</div>`;
      infoBody.innerHTML = html;
      const bs = infoBody.querySelector('#hh3di-btarget');
      if (bs) bs.addEventListener('change', e => { infoTarget = e.target.value; renderInfo(true); });
      return;
    }

    // gợi ý
    const goodSpots = spotNames.filter(n => bySpot[n] && bySpot[n].n >= MIN_N).sort((a, b) => bySpot[b].score / bySpot[b].n - bySpot[a].score / bySpot[a].n);
    const rares = Object.entries(bySp).filter(([, v]) => v.rank >= 3).sort((a, b) => b[1].rank - a[1].rank || b[1].n - a[1].n);
    let rec = '';
    if (!dex.catches.length) rec = 'Chưa có dữ liệu. Cứ để tool câu: mỗi con cá được ghi lại cùng thời tiết và điểm câu.';
    else {
      if (rares.length) rec += '🌟 Đã ra cá hiếm ở thời tiết «' + esc(W || '?') + '»: ' + rares.slice(0, 3).map(([nm, v]) => `<span class="r${v.rank}">${esc(nm)}</span> <small>[${esc(v.rar)}]</small> ở ${Object.entries(v.spots).map(([k, n]) => esc(k) + ' ×' + n).join(', ')}`).join('; ') + '.<br>';
      if (goodSpots.length) rec += `Điểm ra cá tốt nhất lúc này: <b>${esc(goodSpots[0])}</b> (${bySpot[goodSpots[0]].n} lần).`;
      else {
        const have = spotNames.filter(n => bySpot[n]).map(n => `${esc(n)} ${bySpot[n].n}`).join(', ');
        rec += `Mới có ${inW.length} lần ghi ở thời tiết «${esc(W || '?')}»${have ? ' (' + have + ')' : ''} — cần ≥${MIN_N} lần mỗi điểm mới so sánh được. Điểm chưa thử: ${spotNames.filter(n => !bySpot[n]).map(esc).join(', ') || 'không còn'}.`;
      }
    }
    html += `<div class="ii-rec">💡 ${rec}</div>`;

    // cá nào ra ở điểm nào
    html += `<div class="ii-note">Cá đã câu được ở thời tiết «${esc(W || '?')}» — ra ở điểm nào:</div>`;
    const list = Object.entries(bySp).sort((a, b) => b[1].rank - a[1].rank || b[1].n - a[1].n).slice(0, 14);
    if (!list.length) html += '<div class="ii-note">(chưa có cá nào ở thời tiết này)</div>';
    for (const [nm, v] of list) {
      html += `<div class="ii-spot"><span class="r${v.rank}">${esc(nm)}</span>${v.rar ? ` <small>[${esc(v.rar)}]</small>` : ''} — ${Object.entries(v.spots).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k === cond.spot ? '<span class="ii-cur">' + esc(k) + '</span>' : esc(k === '?' ? 'không rõ' : k)} ×${n}`).join(', ')}</div>`;
    }
    if (spotNames.length) html += `<div class="ii-note">Các điểm câu: ${spotNames.map(n => esc(n) + (bySpot[n] ? ` (${bySpot[n].n})` : ' (chưa thử)')).join(' · ')}</div>`;

    // chọn cá mục tiêu → thời tiết + điểm hay ra cá đó
    const species = {};
    for (const c of dex.catches) {
      const f = species[c.name] || (species[c.name] = { n: 0, rank: 0, rar: '' });
      f.n++; const rk = rarRank(c.rar); if (rk >= f.rank) { f.rank = rk; f.rar = c.rar; }
    }
    const spNames = Object.keys(species).sort((a, b) => species[b].rank - species[a].rank || species[b].n - species[a].n);
    if (spNames.length) {
      html += '<div class="ii-note" style="margin-top:8px">🎯 Muốn câu loại cá nào?</div><select id="hh3di-target"><option value="">— chọn cá —</option>' +
        spNames.map(nm => `<option value="${esc(nm)}"${nm === infoTarget ? ' selected' : ''}>${esc(nm)}${species[nm].rar ? ' [' + esc(species[nm].rar) + ']' : ''} ×${species[nm].n}</option>`).join('') + '</select>';
      if (infoTarget && species[infoTarget]) {
        const combo = {};
        for (const c of dex.catches) if (c.name === infoTarget) { const k = `${c.w || '?'} · ${spotOf(c) || 'không rõ điểm'}`; combo[k] = (combo[k] || 0) + 1; }
        const lines = Object.entries(combo).sort((a, b) => b[1] - a[1]).slice(0, 6);
        html += '<div class="ii-spot">' + lines.map(([k, n]) => `${k.startsWith((W || '?') + ' ·') ? '<span class="ii-cur">▶ ' : '• <span>'}${esc(k)}</span> — ${n} lần`).join('<br>') + '</div>';
        const hit = lines.find(([k]) => k.startsWith((W || '?') + ' ·'));
        html += `<div class="ii-note">${hit ? `Thời tiết hiện tại khớp: hãy câu ở «${esc(hit[0].split(' · ').slice(1).join(' · '))}».` : 'Thời tiết hiện tại chưa từng ra loại cá này — chờ thời tiết ở dòng ▶ đầu tiên.'}</div>`;
      }
    }
    html += `<div class="ii-note">Đã ghi ${dex.catches.length} lần câu (dữ liệu tự học từ chính game của bạn; câu càng nhiều càng chính xác).</div>`;
    infoBody.innerHTML = html;
    const sel = infoBody.querySelector('#hh3di-target');
    if (sel) sel.addEventListener('change', e => { infoTarget = e.target.value; renderInfo(true); });
  }

  // (Thử nghiệm) mở danh sách điểm câu của game để ghi lại tên các điểm.
  async function scanSpots() {
    try {
      const pill = DOC.querySelector('.fish-spot') || [...DOC.querySelectorAll('button')].find(b => /diem cau/.test(normLabel(b)));
      if (!pill) { log('📍 Không thấy nút Điểm câu.'); return; }
      const before = textSnapshot();
      pill.click();
      await sleep(600);
      const fresh = [...textSnapshot()].filter(t => !before.has(t) && t.length <= 30 && !/\d/.test(t) && isRealSpot(t));
      log(`📍 Các lựa chọn điểm câu mới hiện ra: ${fresh.map(t => '«' + t + '»').join(' ') || '(không thấy)'}. Điểm hiện tại: «${readConditions().spot || '?'}».`);
      if (fresh.length >= 2 && fresh.length <= 6) { for (const t of fresh) if (!dex.spots.includes(t)) dex.spots.push(t); saveDex(); }
      try { pill.click(); } catch (_) {}
      await sleep(200);
      dismissPopups(null);
      renderInfo(true);
    } catch (e) { log('📍 Lỗi quét điểm câu: ' + (e && e.message || e)); }
  }

  // Mở Sổ Cá của game, ghi TOÀN BỘ chữ hiện ra (và vài mục chi tiết) vào log + sổ tay để gửi lại.
  async function scanBook() {
    try {
      const btn = [...DOC.querySelectorAll('button')].find(b => /so ca cua ban/.test(normLabel(b)));
      if (!btn) { log('📖 Không thấy nút "Sổ Cá của bạn".'); return; }
      const dump = (tag, arr) => {
        for (let k = 0; k < arr.length; k += 12) log(`📖 ${tag}${k ? ' (tiếp)' : ''}: ${arr.slice(k, k + 12).map(t => '«' + t.slice(0, 60) + '»').join(' ')}`);
      };
      const esc = () => { for (const t of [DOC, DOC.body]) { try { t.dispatchEvent(new PAGE.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (_) {} } };
      const before = textSnapshot();
      btn.click();
      await sleep(1200);
      const lines = [...textSnapshot()].filter(t => !before.has(t)).slice(0, 160);
      dex.book = lines.slice(0, 200);
      dump(`Sổ Cá ${lines.length} dòng`, lines);
      // mở vài mục cá cụ thể (nếu thấy tên trong Sổ) để xem điều kiện câu (thời tiết / điểm câu)
      const names = [...new Set(dex.catches.map(c => c.name))].slice(0, 12);
      let opened = 0;
      for (const nm of names) {
        if (opened >= 3) break;
        const el = [...DOC.querySelectorAll('button,[role="button"],li,div,span')].find(e => e.children.length <= 3 && ((e.textContent || '').trim() === nm) && !(root && root.contains(e)) && !(infoRoot && infoRoot.contains(e)));
        if (!el) continue;
        const target = el.closest('button,[role="button"],li,[class*="card" i],[class*="item" i]') || el;
        const b2 = textSnapshot();
        try { target.click(); } catch (_) { continue; }
        await sleep(800);
        const det = [...textSnapshot()].filter(t => !b2.has(t)).slice(0, 40);
        opened++;
        dump(`Chi tiết «${nm}»`, det);
        for (const t of det) if (!dex.book.includes(t) && dex.book.length < 200) dex.book.push(t);
        esc(); await sleep(300);
      }
      saveDex();
      dismissPopups(null); esc();
      log('📖 Xong. Bấm "Sao chép log" (trong menu 🎣 → Khác) rồi gửi lại để tool đọc được điều kiện câu của game.');
    } catch (e) { log('📖 Lỗi đọc Sổ Cá: ' + (e && e.message || e)); }
  }

  /* ------------------------------------------------------------------ *
   * 11c) Sổ Cá: tự mở từng loài, đọc hết quy luật (nơi ở · giờ · thời tiết · kích thước)
   * ------------------------------------------------------------------ */
  const BOOK_KEY = 'hh3d_fish_book_v1';
  const bookDB = { at: 0, species: [] };
  let bookBusy = false, bookAbort = false;
  let autoSpot = false, lastSpotSwitch = 0, spotFailUntil = 0;

  function loadBook() {
    try {
      const d = JSON.parse(PAGE.localStorage.getItem(BOOK_KEY) || '{}');
      if (Array.isArray(d.species)) { bookDB.species = d.species; bookDB.at = Number(d.at) || 0; }
    } catch (_) {}
  }
  function saveBook() { try { PAGE.localStorage.setItem(BOOK_KEY, JSON.stringify(bookDB)); } catch (_) {} }

  const rangesOf = (t) => {
    const out = [], re = /(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/g;
    let m;
    while ((m = re.exec(t || '')) !== null) out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
    return out;
  };
  const numVN = (x) => Number(String(x).replace(',', '.'));
  const inRange = (r, m) => (r[0] <= r[1] ? (m >= r[0] && m < r[1]) : (m >= r[0] || m < r[1]));
  const fmtMin = (m) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
  const nowMinutes = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

  // Đọc chữ trong khung chi tiết một loài (ví dụ: "Nơi ở: Bờ nông, Giữa hồ · Thời gian: bất kỳ · Thời tiết: Tuyết · Là biến thể hiếm của loài này").
  function parseBookDetail(lines, info) {
    const L = lines.map(t => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const flat = L.join(' ¦ ');
    const nf = normalize(flat);
    const same = nf.length === flat.length;
    const sp = {
      idx: info.idx, name: info.name || '', kind: '', rar: '', family: '', caught: null,
      kgMin: null, kgMax: null, cmMin: null, cmMax: null, spots: [], timeSpec: '', weather: [],
      variant: false, windows: [], windowsRaw: '', recKg: null, recBy: ''
    };
    for (const t of L) {                                           // "Cá · Quý · Họ Chép & Lý"
      if (sp.rar || /:/.test(t) || !/[·•]/.test(t)) continue;
      const p = t.split(/\s*[·•]\s*/);
      if (p.length >= 2 && p.length <= 4 && p[0].length <= 14) { sp.kind = p[0]; sp.rar = p[1] || ''; sp.family = p.slice(2).join(' · '); }
    }
    if (/chua cau duoc/.test(nf)) sp.caught = false; else if (/(^|\s)da cau\b|cau duoc \d+/.test(nf)) sp.caught = true;
    const ms = /kich thuoc:\s*([\d.,]+)\s*[–-]\s*([\d.,]+)\s*kg\s*[·•]\s*(\d+)\s*[–-]\s*(\d+)\s*cm/.exec(nf);
    if (ms) { sp.kgMin = numVN(ms[1]); sp.kgMax = numVN(ms[2]); sp.cmMin = Number(ms[3]); sp.cmMax = Number(ms[4]); }
    // lấy đoạn chữ ngay sau nhãn, dừng ở " · " hoặc " ¦ "
    const grab = (label, stop) => {
      const i = nf.indexOf(label); if (i < 0) return '';
      const rest = (same ? flat : nf).slice(i + label.length);      // lệch độ dài → dùng bản không dấu
      const cut = rest.search(stop || /\s[·•]\s|\s¦\s/);
      return (cut < 0 ? rest : rest.slice(0, cut)).trim();
    };
    const listOf = (t) => t.split(/\s*[,;/]\s*/).map(x => x.trim()).filter(Boolean);
    sp.spots = listOf(grab('noi o:')).filter(isRealSpot);
    sp.timeSpec = grab('thoi gian:');
    sp.weather = listOf(grab('thoi tiet:')).filter(x => !/^bat ky$/.test(normalize(x)));
    sp.variant = /bien the/.test(nf);
    sp.windowsRaw = grab('lan toi can cau:', /\s¦\s|$/);
    sp.windows = rangesOf(sp.windowsRaw);
    const rk = grab('ky luc', /\s¦\s|$/);
    const mr = /([\d.,]+)\s*kg\s*[·•]\s*(.+)$/.exec(rk);
    if (mr) { sp.recKg = numVN(mr[1]); sp.recBy = mr[2].trim(); }
    return sp;
  }

  const findBookButton = () => [...DOC.querySelectorAll('button,[role="button"]')].find(b => /so ca cua ban/.test(normLabel(b)) && !(root && root.contains(b))) || null;
  const hasImg = (c) => {
    if (c.querySelector('img,canvas,svg,[style*="background-image"]') || /url\(/.test((c.style && c.style.backgroundImage) || '')) return true;
    try {                                                         // hình nền đặt bằng CSS (class)
      if (/url\(/.test(PAGE.getComputedStyle(c).backgroundImage)) return true;
      for (const d of c.children) if (/url\(/.test(PAGE.getComputedStyle(d).backgroundImage)) return true;
    } catch (_) {}
    return false;
  };

  // Tìm lưới thẻ cá của Sổ Cá: phần tử có ≥6 con, mỗi con có hình + chữ ngắn.
  function findBookCards() {
    let best = null, bestN = 0;
    for (const el of DOC.querySelectorAll('div,ul,section,main')) {
      if (el.children.length < 6) continue;
      if (el.closest('#' + ROOT_ID) || el.closest('#' + INFO_ID) || el.closest('.fish-bag')) continue;
      let n = 0;
      for (const c of el.children) if (hasImg(c) && (c.textContent || '').trim().length <= 60) n++;
      if (n >= 6 && n > bestN && isVisible(el)) { best = el; bestN = n; }
    }
    return best ? [...best.children].filter(hasImg) : [];
  }

  // Khung chi tiết một loài = tổ tiên nhỏ nhất chứa dòng "Kích thước: ..." và các dòng liền quanh.
  function findDetailRoot() {
    const w = DOC.createTreeWalker(DOC.body, PAGE.NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const v = w.currentNode.nodeValue || '';
      if (v.length > 200 || v.indexOf(':') < 0 || !/kich thuoc\s*:/.test(normalize(v))) continue;
      const pe = w.currentNode.parentElement;
      if (!pe || pe.closest('#' + ROOT_ID) || pe.closest('#' + INFO_ID) || !isVisible(pe)) continue;
      let c = pe;
      for (let k = 0; k < 8 && c.parentElement && c.parentElement !== DOC.body; k++) {
        const up = c.parentElement;
        if ((up.textContent || '').length > 1500) break;
        c = up;
      }
      return c;
    }
    return null;
  }
  function textsOf(el) {
    const out = [];
    const w = DOC.createTreeWalker(el, PAGE.NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const t = (w.currentNode.nodeValue || '').replace(/\s+/g, ' ').trim(); if (t && t !== out[out.length - 1]) out.push(t); }
    return out;
  }

  async function closeBookDetail(detail) {
    const isClose = (b) => /^(x|×|✕|✖|dong|close)$/.test(normLabel(b)) || /close/i.test(String(b.className || ''));
    let c = detail, closed = false;
    for (let k = 0; k < 7 && c && !closed; k++, c = c.parentElement) {
      const b = [...c.querySelectorAll('button,[role="button"],[aria-label]')].find(x => !(root && root.contains(x)) && isClose(x) && isVisible(x));
      if (b) { b.click(); closed = true; }
    }
    if (!closed) for (const t of [DOC, DOC.body]) { try { t.dispatchEvent(new PAGE.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (_) {} }
    if (!await waitFor(() => !findDetailRoot(), 1200, 40)) {
      for (const t of [DOC, DOC.body]) { try { t.dispatchEvent(new PAGE.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (_) {} }
      await waitFor(() => !findDetailRoot(), 800, 40);
    }
  }

  function setBookProg(t) { const el = infoRoot && infoRoot.querySelector('#hh3di-prog'); if (el) el.textContent = t; }

  async function scanBookFull() {
    if (bookBusy) { bookAbort = true; log('📖 Đang dừng quét Sổ Cá…'); return; }
    if (running) { log('📖 Hãy bấm ■ Dừng (menu 🎣) trước khi quét Sổ Cá.'); setBookProg('Hãy dừng auto câu trước khi quét Sổ Cá.'); return; }
    bookBusy = true; bookAbort = false;
    const btnEl = infoRoot && infoRoot.querySelector('#hh3di-book');
    if (btnEl) btnEl.textContent = '⏹ Dừng quét';
    try {
      if (isBagOpen()) { try { closeBagFast(); } catch (_) {} await sleep(300); }
      const openBtn = findBookButton();
      if (!openBtn) { log('📖 Không thấy nút "Sổ Cá của bạn".'); return; }
      const opener = () => { const b = findBookButton(); if (b) b.click(); };
      opener();
      await waitFor(() => findBookCards().length >= 3, 3500, 250);
      let cards = findBookCards();
      if (!cards.length) { log('📖 Không nhận ra lưới thẻ cá trong Sổ Cá — ghi lại cấu trúc để chỉnh:'); await scanBook(); return; }
      const total = cards.length;
      log(`📖 Thấy ${total} mục trong Sổ Cá — đang mở từng mục để đọc…`);
      const out = [];
      let fail = 0;
      for (let i = 0; i < total && !bookAbort; i++) {
        if (!cards[i] || !cards[i].isConnected || !isVisible(cards[i])) {           // lưới bị đóng/đổi → mở lại
          opener(); await waitFor(() => findBookCards().length >= 3, 3000, 250);
          cards = findBookCards();
          if (!cards[i]) { log('📖 Mất lưới thẻ cá, dừng quét.'); break; }
        }
        const card = cards[i];
        const name = (card.textContent || '').replace(/\s+/g, ' ').trim();
        try { card.scrollIntoView({ block: 'center' }); } catch (_) {}
        card.click();
        let ok = await waitFor(() => !!findDetailRoot(), 1500, 40);
        if (!ok) { pointerTap(card); ok = await waitFor(() => !!findDetailRoot(), 1500, 40); }
        if (!ok) { fail++; if (fail >= 6 && out.length === 0) { log('📖 Bấm thẻ cá không mở được chi tiết — dừng quét.'); break; } continue; }
        await sleep(120);
        const detail = findDetailRoot();
        if (detail) {
          const sp = parseBookDetail(textsOf(detail), { idx: i, name });
          if (sp.kgMin != null || sp.spots.length || sp.rar) out.push(sp); else fail++;
          await closeBookDetail(detail);
        }
        if (i % 4 === 0 || i === total - 1) setBookProg(`Đang quét Sổ Cá: ${i + 1}/${total} (đã đọc ${out.length} loài)…`);
      }
      const seenKey = new Set();
      const uniq = out.filter(x => { const k = JSON.stringify([x.name, x.rar, x.family, x.caught, x.kgMin, x.kgMax, x.spots, x.timeSpec, x.weather, x.windows, x.recKg, x.recBy]); if (seenKey.has(k)) return false; seenKey.add(k); return true; });
      out.length = 0; out.push(...uniq);
      if (out.length) {
        bookDB.species = out; bookDB.at = Date.now(); saveBook();
        const unk = out.filter(x => x.caught === false).length;
        log(`📖 Đã đọc ${out.length}/${total} loài từ Sổ Cá (${unk} loài chưa câu được)${bookAbort ? ' — dừng giữa chừng' : ''}.`);
        setBookProg(`Đã đọc ${out.length}/${total} loài lúc ${fmtMin(nowMinutes())}.`);
      } else { log('📖 Không đọc được loài nào. Bấm "Sao chép log" gửi lại để chỉnh.'); setBookProg('Không đọc được loài nào.'); }
      // đóng Sổ Cá
      try { dismissPopups(null); } catch (_) {}
      for (const t of [DOC, DOC.body]) { try { t.dispatchEvent(new PAGE.KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })); } catch (_) {} }
      renderInfo(true);
    } catch (e) { log('📖 Lỗi quét Sổ Cá: ' + (e && e.message || e)); }
    finally { bookBusy = false; bookAbort = false; if (btnEl) btnEl.textContent = '📖 Quét Sổ Cá (đọc hết)'; }
  }

  /* ---- Dùng dữ liệu Sổ Cá: cá nào ra ngay lúc này / sắp tới ---- */
  function speciesNow(sp, cond, nowMin) {
    const W = normalize(cond.weather || ''), T = normalize(cond.tod || '');
    if (sp.weather && sp.weather.length) {
      const okW = sp.weather.some(x => { const n = normalize(x); return !n || /bat ky|moi|tat ca/.test(n) || (W && (W.includes(n) || n.includes(W))); });
      if (!okW) return false;
    }
    const ts = normalize(sp.timeSpec || '');
    if (ts && !/bat ky|moi luc|tat ca/.test(ts)) {
      const rs = rangesOf(sp.timeSpec);
      const okT = rs.length ? rs.some(r => inRange(r, nowMin)) : ts.split(/[,;/]|\bva\b|\bhoac\b/).some(p => { const q = p.trim(); return q && T && (T.includes(q) || q.includes(T)); });
      if (!okT) return false;
    }
    return true;
  }
  const bookNameOf = (s) => (s.name && !/^\?+$/.test(s.name.trim()) ? s.name : `??? ${s.family || ''}${s.kgMax != null ? ' ' + s.kgMin + '–' + s.kgMax + 'kg' : ''}`.trim());
  const bookScore = (s) => RAR_W[rarRank(s.rar)] * (s.caught === false ? 1.6 : 1) * (s.variant ? 1.3 : 1);
  const bookNotable = (s) => rarRank(s.rar) >= 3 || s.caught === false || s.variant;

  function bookSpotPlan(cond) {
    const nowMin = nowMinutes();
    const avail = bookDB.species.filter(s => speciesNow(s, cond, nowMin));
    const spots = [...new Set(bookDB.species.flatMap(s => s.spots))].filter(isRealSpot);
    const per = spots.map(name => {
      const list = avail.filter(s => !s.spots.length || s.spots.includes(name));
      const notable = list.filter(bookNotable).sort((a, b) => bookScore(b) - bookScore(a));
      return { name, list, notable, score: notable.reduce((x, s) => x + bookScore(s), 0) };
    }).sort((a, b) => b.score - a.score);
    return { avail, per, nowMin };
  }

  function recommendedSpot(cond) {
    const plan = bookSpotPlan(cond);
    const best = plan.per[0];
    if (!best || best.score <= 0) return null;
    return { name: best.name, why: `${best.notable.length} loài hiếm/mới có thể ra: ${best.notable.slice(0, 3).map(bookNameOf).join(', ')}` };
  }

  function bookHtml(cond) {
    const esc = escapeHtml, sps = bookDB.species;
    const tag = (s) => `<span class="r${rarRank(s.rar)}">${esc(bookNameOf(s))}</span>${s.rar ? ` <small>[${esc(s.rar)}]</small>` : ''}${s.variant ? ' <small>✦biến thể</small>' : ''}${s.caught === false ? ' <small>🆕chưa câu</small>' : ''}`;
    const plan = bookSpotPlan(cond);
    const age = bookDB.at ? new Date(bookDB.at) : null;
    const unk = sps.filter(s => s.caught === false).length;
    let h = `<div class="ii-note">📖 Sổ Cá: ${sps.length} loài${unk ? ` (còn <b>${unk}</b> loài chưa câu được)` : ''}${age ? ' · đọc lúc ' + fmtMin(age.getHours() * 60 + age.getMinutes()) : ''}</div>`;
    const best = plan.per[0];
    if (best && best.score > 0) {
      h += `<div class="ii-rec">💡 Lúc này (${esc(cond.tod || '?')}, ${esc(cond.weather || '?')}) nên câu ở <b>${esc(best.name)}</b> — có thể ra ${best.notable.slice(0, 4).map(tag).join(' · ')}.${cond.spot && normalize(cond.spot) !== normalize(best.name) ? ` <span class="ii-cur">Bạn đang ở «${esc(cond.spot)}».</span>` : ''}</div>`;
    } else h += `<div class="ii-rec">💡 Lúc này chưa có loài hiếm/mới nào ra theo thời tiết & giờ hiện tại — câu điểm nào cũng như nhau (chỉ ra cá thường).</div>`;
    h += '<div class="ii-note">Có thể ra ngay lúc này, theo điểm câu:</div>';
    for (const r of plan.per) {
      const commons = r.list.length - r.notable.length;
      h += `<div class="ii-spot"><b>${esc(r.name)}</b>${normalize(r.name) === normalize(cond.spot) ? ' <span class="ii-cur">(đang ở đây)</span>' : ''} — ${r.list.length} loài${r.notable.length ? '<br>' + r.notable.slice(0, 6).map(tag).join(' · ') + (r.notable.length > 6 ? ` +${r.notable.length - 6}` : '') : ''}${commons > 0 ? `<br><small>+${commons} cá thường</small>` : ''}</div>`;
    }
    // sắp tới: loài có khung giờ riêng (chưa ra lúc này)
    const upc = [];
    for (const s of sps) {
      if (!s.windows || !s.windows.length || speciesNow(s, cond, plan.nowMin)) continue;
      let dl = Infinity, w0 = null;
      for (const w of s.windows) { const d = ((w[0] - plan.nowMin) + 1440) % 1440; if (d < dl) { dl = d; w0 = w; } }
      if (w0) upc.push({ s, dl, w0 });
    }
    upc.sort((a, b) => a.dl - b.dl);
    if (upc.length) {
      h += '<div class="ii-note" style="margin-top:6px">⏰ Sắp tới (theo giờ máy bạn; điểm câu phải đúng):</div>';
      for (const u of upc.slice(0, 8)) h += `<div class="ii-spot">${fmtMin(u.w0[0])}–${fmtMin(u.w0[1])} <small>(sau ${u.dl >= 60 ? Math.floor(u.dl / 60) + 'g' : ''}${u.dl % 60}p)</small> — ${tag(u.s)}${u.s.weather.length ? ' · ' + esc(u.s.weather.join(', ')) : ''}<br><small>điểm: ${esc(u.s.spots.join(', ') || '?')}</small></div>`;
    }
    // lịch thời tiết suy ra từ khung giờ của các loài
    const wt = {};
    for (const s of sps) if (s.windows && s.windows.length && s.weather.length) for (const wn of s.weather) { const k = wn; const set = wt[k] || (wt[k] = new Set()); for (const w of s.windows) set.add(`${fmtMin(w[0])}–${fmtMin(w[1])}`); }
    const wk = Object.keys(wt);
    if (wk.length) h += `<div class="ii-note" style="margin-top:6px">🗓 Khung giờ thời tiết (suy ra từ Sổ Cá): ${wk.map(k => `<b>${esc(k)}</b> ${[...wt[k]].join(' · ')}`).join(' | ')}</div>`;
    // chọn loài để xem quy luật
    const order = sps.map((s, i) => i).sort((a, b) => rarRank(sps[b].rar) - rarRank(sps[a].rar) || (sps[b].caught === false) - (sps[a].caught === false));
    h += '<div class="ii-note" style="margin-top:8px">🎯 Xem quy luật của một loài:</div><select id="hh3di-btarget"><option value="">— chọn loài —</option>' +
      order.map(i => `<option value="${i}"${String(i) === infoTarget ? ' selected' : ''}>${esc(bookNameOf(sps[i]))}${sps[i].rar ? ' [' + esc(sps[i].rar) + ']' : ''}${sps[i].caught === false ? ' 🆕' : ''}</option>`).join('') + '</select>';
    const t = infoTarget !== '' && sps[Number(infoTarget)];
    if (t) {
      h += `<div class="ii-spot">${tag(t)}<br>Họ: ${esc(t.family || '?')} · ${t.kgMin != null ? t.kgMin + '–' + t.kgMax + ' kg · ' + t.cmMin + '–' + t.cmMax + ' cm' : ''}<br>Nơi ở: <b>${esc(t.spots.join(', ') || '?')}</b><br>Thời gian: ${esc(t.timeSpec || '?')} · Thời tiết: ${esc(t.weather.join(', ') || 'bất kỳ')}${t.windowsRaw ? `<br><small>${esc(t.windowsRaw)}</small>` : ''}${t.recKg != null ? `<br><small>Kỷ lục hồ: ${t.recKg} kg · ${esc(t.recBy)}</small>` : ''}<br>${speciesNow(t, cond, plan.nowMin) ? '<span class="ii-cur">▶ Có thể ra ngay lúc này.</span>' : 'Chưa ra lúc này.'}</div>`;
    }
    return h;
  }

  /* ---- (Thử nghiệm) tự chuyển điểm câu theo gợi ý ---- */
  const findSpotPill = () => DOC.querySelector('.fish-spot') || [...DOC.querySelectorAll('button')].find(b => /diem cau/.test(normLabel(b)) && !(root && root.contains(b))) || null;
  async function selectSpot(name) {
    const pill = findSpotPill();
    if (!pill) return false;
    const want = normalize(name);
    pill.click();
    await sleep(450);
    let opt = null;
    for (const e of DOC.querySelectorAll('button,li,div,span,a')) {
      if (e === pill || pill.contains(e) || (root && root.contains(e)) || (infoRoot && infoRoot.contains(e)) || e.children.length > 2) continue;
      if (normalize(e.textContent || '') !== want || !isVisible(e)) continue;
      opt = e.closest('button,[role="button"],li') || e; break;
    }
    if (!opt) { try { pill.click(); } catch (_) {} return false; }
    opt.click();
    await sleep(600);
    const ok = normalize(readConditions().spot) === want;
    if (!ok) { try { dismissPopups(null); } catch (_) {} }
    return ok;
  }
  async function maybeSwitchSpot() {
    if (!autoSpot || !bookDB.species.length) return false;
    const nowT = Date.now();
    if (nowT < spotFailUntil || nowT - lastSpotSwitch < 120000) return false;
    const cond = readConditions();
    const rec = recommendedSpot(cond);
    if (!rec || normalize(rec.name) === normalize(cond.spot)) return false;
    lastSpotSwitch = nowT;
    log(`🧭 Chuyển điểm câu «${cond.spot || '?'}» → «${rec.name}» (${rec.why}).`);
    const ok = await selectSpot(rec.name);
    if (!ok) { spotFailUntil = nowT + 300000; log('🧭 Không chuyển được điểm câu → tạm dừng thử 5 phút.'); }
    return ok;
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
    try {
      if (DOC.body && uiFails < 3) {
        if (!DOC.getElementById(ROOT_ID)) tryInitUI();
        else if (!DOC.getElementById(INFO_ID)) buildInfoUI();
      }
    } catch (_) {}
  }, 2000);

  // Game bật toàn màn hình → phần tử ngoài vùng fullscreen bị ẩn; chuyển panel vào đó.
  DOC.addEventListener('fullscreenchange', () => {
    try {
      const host = DOC.fullscreenElement && DOC.fullscreenElement !== DOC.documentElement ? DOC.fullscreenElement : DOC.body;
      if (root && host && root.parentNode !== host) host.appendChild(root);
      if (infoRoot && host && infoRoot.parentNode !== host) host.appendChild(infoRoot);
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
          var text = 'HH3D 1.4.0 [' + stage + ']\n' + navigator.userAgent + '\n' + location.href + '\n' + msg;
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

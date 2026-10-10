// ==UserScript==
// @name         HH3D - Tiên Giới Câu Cá Auto (Beta)
// @namespace    hh3d-tien-gioi-fishing
// @version      0.1.9
// @description  Tool câu cá Tiên Giới: Tự chọn điểm câu, hỗ trợ debug tọa độ, tùy chỉnh thời gian giữ nút.
// @author       OpenAI
// @match        *://hoathinh3d.you/game*
// @match        *://hoathinh3d.de/game*
// @include      *://hoathinh3d.*/game*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const ROOT_ID = 'hh3d-fishing-tool-root';
  if (document.getElementById(ROOT_ID)) return;

  const CFG = {
    capacity: 24,
    sellAt: 22,
    pollMs: 600,
    castWaitTimeoutMs: 90_000,
    reelTimeoutMs: 45_000,
    actionCooldownMs: 1_200,
    castTransitionTimeoutMs: 12_000,
    resultGraceMs: 6_500,
    maxHoldMs: 30_000,
    maxInterfaceMisses: 12,
    tapXPercent: 43, // Mặc định theo hình của bạn
    tapYPercent: 40,
    castHoldDurationMs: 2000,
  };

  let running = false;
  let autoSell = true;
  let phase = 'idle';
  let phaseSince = 0;
  let lastActionAt = 0;
  let holdStartedAt = 0;
  let reelStartedAt = 0;
  let interfaceMisses = 0;
  let castRetryCount = 0;
  let bagFlow = null;
  let loopHandle = null;
  let heldTarget = null;
  let logLines = [];
  let loopBusy = false;

  const normalize = (s) => String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
    .replace(/\u00A0/g, ' ')
    .toLowerCase().replace(/\s+/g, ' ').trim();

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <style>
      #${ROOT_ID} { position:fixed !important; z-index:2147483647 !important; isolation:isolate; pointer-events:auto; right:9px; top:88px; width:min(310px, calc(100vw - 18px)); color:#f5f2ff; font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif; }
      #${ROOT_ID} * { box-sizing:border-box; }
      #${ROOT_ID} .fish-fab { display:block; margin-left:auto; border:1px solid #5bcaaf; border-radius:22px; background:#102a2d; color:#eafffa; padding:12px 15px; font-size:15px; font-weight:900; box-shadow:0 4px 15px #0008; }
      #${ROOT_ID} .fish-panel { margin-top:7px; background:rgba(20,20,27,.97); border:1px solid #4b8e84; border-radius:13px; padding:11px; box-shadow:0 8px 25px #0009; display:none; max-height:62vh; overflow:auto; }
      #${ROOT_ID} .fish-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-weight:800; font-size:14px; margin-bottom:8px; }
      #${ROOT_ID} .fish-head small { font-size:10px; font-weight:600; color:#99d6c9; }
      #${ROOT_ID} .fish-status { padding:8px; border-radius:8px; background:#282832; margin-bottom:8px; overflow-wrap:anywhere; }
      #${ROOT_ID} .fish-status strong { color:#74e2c4; }
      #${ROOT_ID} .fish-row { display:flex; gap:6px; margin:6px 0; }
      #${ROOT_ID} button.fish-action { border:0; border-radius:8px; padding:9px 8px; color:#fff; background:#38404a; font-weight:750; flex:1; min-width:0; }
      #${ROOT_ID} button.fish-start { background:#087f68; }
      #${ROOT_ID} button.fish-stop { background:#a33c4b; }
      #${ROOT_ID} button.fish-sell { background:#7d5a14; }
      #${ROOT_ID} button.fish-test { background:#6a4c9c; }
      #${ROOT_ID} button.fish-test-btn { background:#2b6a9c; }
      #${ROOT_ID} button.fish-small { padding:7px 8px; font-size:11px; }
      #${ROOT_ID} label { display:flex; align-items:center; gap:7px; margin:7px 0; color:#e4dff0; font-size:11px; }
      #${ROOT_ID} input[type=checkbox] { width:17px; height:17px; accent-color:#42c7a3; }
      #${ROOT_ID} .fish-slider-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
      #${ROOT_ID} .fish-slider-row input[type=range] { flex:1; accent-color:#42c7a3; }
      #${ROOT_ID} .fish-slider-row span { width:35px; text-align:right; }
      #${ROOT_ID} .fish-count-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
      #${ROOT_ID} .fish-count-row input { width:64px; min-width:64px; padding:6px; border-radius:6px; border:1px solid #585766; background:#121219; color:#fff; }
      #${ROOT_ID} .fish-note { color:#c3bfce; font-size:11px; margin-top:8px; }
      #${ROOT_ID} .fish-log { white-space:pre-wrap; font-size:10px; color:#d4d0df; background:#111117; border-radius:8px; padding:7px; margin-top:8px; max-height:110px; overflow:auto; }
      #${ROOT_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:4px 8px !important; flex:0 0 auto !important; }
      .hh3d-debug-dot { position:fixed; width:20px; height:20px; background:red; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:0.8; transition:opacity 0.5s; }
      .hh3d-debug-btn { position:fixed; width:30px; height:30px; border:3px solid yellow; border-radius:50%; z-index:2147483647; pointer-events:none; transform:translate(-50%, -50%); opacity:0.8; transition:opacity 0.5s; }
    </style>
    <button type="button" class="fish-fab" id="hh3df-fab">🎣 Câu Cá</button>
    <section class="fish-panel" id="hh3df-panel">
      <div class="fish-head"><span>🎣 Tiên Giới · Câu Cá Auto <small>BETA 0.1.9</small></span><button class="fish-action fish-collapse" id="hh3df-hide" type="button">Ẩn</button></div>
      <div class="fish-status" id="hh3df-status">Trạng thái: <strong>Sẵn sàng</strong></div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-start" id="hh3df-start">▶ Bắt đầu</button>
        <button type="button" class="fish-action fish-stop" id="hh3df-stop">■ Dừng</button>
      </div>
      <label><input type="checkbox" id="hh3df-autosell" checked> Tự bán cá thường khi giỏ đạt 22/24</label>
      
      <div style="margin-top:10px; font-weight:bold; color:#74e2c4; font-size:11px;">Cấu hình vị trí chạm hồ (Debug):</div>
      <div class="fish-slider-row">
        <span>Ngang:</span> <input type="range" id="hh3df-tap-x" min="0" max="100" value="${CFG.tapXPercent}"> <span id="hh3df-tap-x-val">${CFG.tapXPercent}%</span>
      </div>
      <div class="fish-slider-row">
        <span>Dọc:</span> <input type="range" id="hh3df-tap-y" min="0" max="100" value="${CFG.tapYPercent}"> <span id="hh3df-tap-y-val">${CFG.tapYPercent}%</span>
      </div>
      <div class="fish-count-row">
        <span>Giữ nút (ms):</span><input type="number" id="hh3df-hold-ms" min="0" max="5000" step="50" value="${CFG.castHoldDurationMs}" />
      </div>

      <div class="fish-row">
        <button type="button" class="fish-action fish-sell" id="hh3df-sell">🧺 Bán cá thường ngay</button>
      </div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-small" id="hh3df-check">🔎 Kiểm tra</button>
        <button type="button" class="fish-action fish-test" id="hh3df-test-cast">🎣 Test Câu</button>
        <button type="button" class="fish-action fish-small" id="hh3df-clear">Xóa Log</button>
      </div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-test-btn" id="hh3df-test-canvas">🌊 Test Chạm Hồ</button>
        <button type="button" class="fish-action fish-test-btn" id="hh3df-test-button">🔘 Test Nút</button>
      </div>
      <div class="fish-note">Bấm "Test Chạm Hồ" để xem chấm đỏ. Bấm "Test Nút" để xem vòng tròn vàng. Nếu game không phản hồi, có thể game chặn click ảo (Anti-cheat).</div>
      <div class="fish-log" id="hh3df-log">Chưa có hoạt động.</div>
    </section>`;

  function mountTool() {
    const existing = document.getElementById(ROOT_ID);
    if (existing && existing !== root) return;
    if (!root.isConnected) {
      const host = document.body || document.documentElement;
      if (host) host.appendChild(root);
    }
    if (root.isConnected) {
      root.style.setProperty('position', 'fixed', 'important');
      root.style.setProperty('z-index', '2147483647', 'important');
      root.style.setProperty('pointer-events', 'auto', 'important');
    }
  }
  mountTool();
  document.addEventListener('DOMContentLoaded', mountTool, { once: true });
  const mountObserver = new MutationObserver(() => { if (!root.isConnected) mountTool(); });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });

  const $ = (sel) => root.querySelector(sel);
  const fab = $('#hh3df-fab');
  const panel = $('#hh3df-panel');
  const statusEl = $('#hh3df-status');
  const logEl = $('#hh3df-log');
  const tapXSlider = $('#hh3df-tap-x');
  const tapYSlider = $('#hh3df-tap-y');
  const tapXVal = $('#hh3df-tap-x-val');
  const tapYVal = $('#hh3df-tap-y-val');
  const holdMsInput = $('#hh3df-hold-ms');

  function setStatus(message, strong = '') {
    statusEl.innerHTML = `Trạng thái: <strong>${escapeHtml(strong || message)}</strong>${strong ? `<div style="margin-top:3px">${escapeHtml(message)}</div>` : ''}`;
  }

  function log(message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    logLines.unshift(`[${time}] ${message}`);
    logLines = logLines.slice(0, 10);
    logEl.textContent = logLines.join('\n');
  }

  function showDebugDot(x, y, isButton = false) {
    const dot = document.createElement('div');
    dot.className = isButton ? 'hh3d-debug-btn' : 'hh3d-debug-dot';
    dot.style.left = x + 'px';
    dot.style.top = y + 'px';
    document.body.appendChild(dot);
    setTimeout(() => { dot.style.opacity = '0'; setTimeout(() => dot.remove(), 500); }, 1500);
  }

  async function simulateTapAt(x, y) {
    showDebugDot(x, y, false);
    root.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    root.style.pointerEvents = 'auto';

    if (!el) { log(`Không tìm thấy phần tử tại (${x}, ${y}).`); return false; }
    const target = el.tagName === 'CANVAS' ? el : (el.closest('canvas') || el);
    
    const rect = target.getBoundingClientRect();
    const offsetX = x - rect.left;
    const offsetY = y - rect.top;
    log(`Chạm <${target.tagName}> tại (${Math.round(x)}, ${Math.round(y)}) | Offset: (${Math.round(offsetX)}, ${Math.round(offsetY)})`);

    try {
      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, offsetX: offsetX, offsetY: offsetY, pageX: x, pageY: y, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'touch' };
      if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      await new Promise(r => setTimeout(r, 100));
      opts.buttons = 0;
      if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerup', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      target.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) { log(`Lỗi chạm: ${e.message}`); return false; }
  }

  async function holdElement(el, duration) {
    if (!el || !el.isConnected) return false;
    try {
      const rect = el.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      showDebugDot(x, y, true); // Hiện vòng tròn vàng cho nút

      const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, screenX: x, screenY: y, offsetX: x - rect.left, offsetY: y - rect.top, pageX: x, pageY: y, button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'touch' };

      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      await new Promise(r => setTimeout(r, duration));
      opts.buttons = 0;
      if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return true;
    } catch (e) { log(`Lỗi giữ nút: ${e.message}`); return false; }
  }

  // --- CÁC HÀM TIỆN ÍCH (Giữ nguyên từ bản trước) ---
  function pageText() { if (!document.body) return ''; const parts = []; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); while (walker.nextNode()) { const node = walker.currentNode; const parent = node.parentElement; if (!parent || parent.closest(`#${ROOT_ID}`)) continue; let hidden = false; for (let el = parent; el && el !== document.body; el = el.parentElement) { const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { hidden = true; break; } } if (!hidden) parts.push(node.nodeValue || ''); } return parts.join(' '); }
  function visible(el) { if (!(el instanceof Element) || !el.isConnected) return false; if (el.closest(`#${ROOT_ID}`)) return false; const rect = el.getBoundingClientRect(); if (rect.width < 2 || rect.height < 2) return false; for (let parent = el; parent && parent !== document.documentElement; parent = parent.parentElement) { const style = getComputedStyle(parent); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false; } return true; }
  function labelOf(el) { const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.innerText || el.textContent || ''; return String(raw).replace(/\s+/g, ' ').trim(); }
  function getClickableAncestor(el) { let current = el; while (current && current !== document.body) { if (current.matches('button,a,[role="button"],[onclick],input[type="button"],input[type="submit"],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"])')) return current; const style = getComputedStyle(current); if (style.cursor === 'pointer' || current.onclick || current.getAttribute('onclick') || current.getAttribute('role') === 'button') return current; current = current.parentElement; } return el; }
  function findClickable(regex) { const selectors = 'button,a,[role="button"],[onclick],input[type="button"],input[type="submit"],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"]),div,span'; const matches = Array.from(document.querySelectorAll(selectors)).filter((el) => { if (!visible(el)) return false; const text = normalize(labelOf(el)); if (!text || text.length > 80 || !regex.test(text)) return false; if (el.matches('button:disabled,input:disabled,[aria-disabled="true"]')) return false; return true; }); const clickableMatches = matches.map(el => getClickableAncestor(el)); const uniqueMatches = [...new Set(clickableMatches)]; uniqueMatches.sort((a, b) => { const rank = (el) => el.matches('button,a,[role="button"],input[type="button"],input[type="submit"]') ? 0 : el.matches('[onclick],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"])') ? 1 : 2; const rankDiff = rank(a) - rank(b); if (rankDiff) return rankDiff; const cursorA = getComputedStyle(a).cursor === 'pointer' ? 0 : 1; const cursorB = getComputedStyle(b).cursor === 'pointer' ? 0 : 1; if (cursorA !== cursorB) return cursorA - cursorB; return (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (b.getBoundingClientRect().width * b.getBoundingClientRect().height); }); return uniqueMatches[0] || null; }
  function findHoldButton() { return findClickable(/^(giu|giữ)(\s+can)?$/); }
  function fishingControls() { return { cast: findClickable(/nem cau/), hold: findHoldButton(), waiting: findClickable(/cho ca/), withdraw: findClickable(/thu can/) }; }
  function readBagCountFromDOM() { const text = normalize(pageText()); const re = /gio(?:\s+ca)?\s*(\d{1,3})\s*\/\s*(\d{1,3})/g; let match; while ((match = re.exec(text)) !== null) { const count = Number(match[1]), capacity = Number(match[2]); if (capacity >= 1 && capacity <= 1000 && count >= 0 && count <= capacity) return { count, capacity, source: 'dom' }; } return null; }
  function readBagCount() { const actual = readBagCountFromDOM(); if (actual) return actual; const raw = $('#hh3df-manual-count')?.value; if (raw !== undefined && raw !== '') { const count = Number(raw); if (Number.isInteger(count) && count >= 0 && count <= CFG.capacity) return { count, capacity: CFG.capacity, source: 'manual' }; } return null; }
  function resultVisible() { const text = normalize(pageText()); return /ca\s*[·•]\s*(pho thong|quy|hiem|huyen thoai|than thoai)/i.test(text) || /moi\s*[·•]?\s*ca\s*[·•]\s*pho thong/i.test(text) || (/do khung/.test(text) && /\bkg\b/.test(text)) || /ban da cau duoc|cau ca thanh cong|ket qua cau ca/i.test(text); }
  function biteVisible() { const text = normalize(pageText()); return /dinh roi|ca can cau|ca can moi|can cau roi/i.test(text); }
  function challengeVisible() { const text = normalize(pageText()); return /captcha|xac minh ban khong phai robot|verify you are human|kiem tra an ninh|xac minh tai khoan|ma xac nhan/i.test(text); }
  function beginHold(target) { if (!target || !visible(target)) return false; if (heldTarget === target && target.isConnected) return true; releaseHeldTarget(); try { const rect = target.getBoundingClientRect(); const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2; const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y, view: window }; if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerdown', opts)); target.dispatchEvent(new MouseEvent('mousedown', opts)); heldTarget = target; holdStartedAt = Date.now(); lastActionAt = holdStartedAt; log(`Bắt đầu giữ nút: "${labelOf(target)}"`); return true; } catch (e) { log(`Lỗi bắt đầu giữ cần: ${e.message}`); releaseHeldTarget(); return false; } }
  function releaseHeldTarget() { if (!heldTarget) return; try { const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 }; if (typeof PointerEvent === 'function' && heldTarget.isConnected) heldTarget.dispatchEvent(new PointerEvent('pointerup', opts)); if (heldTarget.isConnected) heldTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window })); } catch (_) {} log(`Đã nhả nút: "${labelOf(heldTarget)}"`); heldTarget = null; holdStartedAt = 0; }
  function enterResult(now, reason, countCatch = true) { if (phase === 'result') return; const priorPhase = phase; releaseHeldTarget(); if (countCatch && ['casting', 'waiting_bite', 'reeling'].includes(priorPhase)) noteCatchForManualCount(); phase = 'result'; phaseSince = now; castRetryCount = 0; log(reason); setStatus('Lượt câu đã kết thúc; chờ bảng kết quả đóng.', 'Đợi kết quả'); }
  function stop(reason) { running = false; releaseHeldTarget(); bagFlow = null; phase = 'idle'; phaseSince = 0; castRetryCount = 0; if (loopHandle) { clearInterval(loopHandle); loopHandle = null; } setStatus(reason || 'Đã dừng', 'Đã dừng'); log(reason || 'Đã dừng tool.'); }
  function noteCatchForManualCount() { if (readBagCountFromDOM()) return; const raw = $('#hh3df-manual-count')?.value; if (raw === undefined || raw === '') { log('Lượt câu đã kết thúc nhưng game không cho đọc số giỏ; nhập số cá hiện tại để theo dõi ngưỡng 22/24.'); return; } const current = Number(raw); if (Number.isInteger(current) && current >= 0 && current < CFG.capacity) { $('#hh3df-manual-count').value = current + 1; log(`Đã cập nhật bộ đếm thủ công: ${current} → ${current + 1}/${CFG.capacity}.`); } }

  function start() { if (running) return; running = true; autoSell = $('#hh3df-autosell').checked; phase = 'idle'; phaseSince = Date.now(); interfaceMisses = 0; castRetryCount = 0; bagFlow = null; setStatus('Đang kiểm tra giao diện trước khi ném câu…', 'Đang chạy'); log('Bắt đầu.'); if (loopHandle) clearInterval(loopHandle); loopHandle = setInterval(tick, CFG.pollMs); tick(); }

  async function performCastSequence() {
    const controls = fishingControls();
    if (!controls.cast) return false;
    const tapX = (parseInt(tapXSlider.value, 10) / 100) * window.innerWidth;
    const tapY = (parseInt(tapYSlider.value, 10) / 100) * window.innerHeight;
    const holdMs = parseInt(holdMsInput.value, 10) || 100;
    setStatus(`Đang chạm hồ...`, 'Đang ném câu');
    log(`Bước 1: Chạm hồ tại X=${tapXSlider.value}%, Y=${tapYSlider.value}%`);
    await simulateTapAt(tapX, tapY);
    await new Promise(r => setTimeout(r, 500));
    setStatus(`Đang giữ nút Ném câu...`, 'Đang ném câu');
    log(`Bước 2: Giữ nút "Ném câu" trong ${holdMs}ms.`);
    await holdElement(controls.cast, holdMs);
    lastActionAt = Date.now(); return true;
  }

  // Bag flow logic (Rút gọn)
  function isBagOpen() { const text = normalize(pageText()); return /linh thach/.test(text) && /chon ca thuong|bo chon|tha ve ho/.test(text) && /gio ca/.test(text); }
  function startBagFlow(reason = 'manual', stopAfter = false) { if (bagFlow) return; const bag = readBagCount(); bagFlow = { stage: 'open', before: bag?.count ?? null, beforeSource: bag?.source ?? null, capacity: bag?.capacity ?? CFG.capacity, startedAt: Date.now(), reason, stopAfter, stageAt: Date.now(), selected: null }; phase = 'bag'; log(reason === 'auto' ? 'Giỏ đạt ngưỡng; mở giỏ.' : 'Mở giỏ để bán.'); }
  function closeBagModal() { const closeCandidates = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]')).filter((el) => { if (!visible(el) || el.closest(`#${ROOT_ID}`)) return false; const label = normalize(labelOf(el)); return /^(x|×|✕|dong|close|thoat)$/.test(label) || /close|dong/.test(normalize(el.getAttribute('aria-label') || '') + ' ' + normalize(el.getAttribute('title') || '')); }); if (closeCandidates.length) { const btn = getClickableAncestor(closeCandidates[0]); if (btn && visible(btn)) { btn.click(); return true; } } const nav = findClickable(/gio ca(?:\s*\d+\s*\/\s*\d+)?/); if (nav) { nav.click(); return true; } return false; }
  async function tickBagFlow() {
    if (!bagFlow) return; const f = bagFlow; const now = Date.now();
    if (now - f.startedAt > 30_000) { bagFlow = null; if (running) stop('Đã dừng an toàn: thao tác giỏ cá không hoàn tất.'); return; }
    if (f.stage === 'open') { if (isBagOpen()) { f.stage = 'select'; f.stageAt = now; return; } const nav = findClickable(/gio ca(?:\s*\d+\s*\/\s*\d+)?/); if (nav) { nav.click(); f.stage = 'wait_open'; f.stageAt = now; setStatus('Đang mở Giỏ cá…', 'Xử lý giỏ'); } else if (now - f.stageAt > 2_500) { if (!f.manualOpenPrompted) { f.manualOpenPrompted = true; setStatus('Anh mở Giỏ cá trực tiếp; tool sẽ chờ nhận diện.', 'Cần mở giỏ thủ công'); log('Chờ anh mở giỏ bằng tay.'); } } return; }
    if (f.stage === 'wait_open') { if (isBagOpen()) { f.stage = 'select'; f.stageAt = now; return; } if (now - f.stageAt > 4_500) { bagFlow = null; if (running) stop('Không nhận diện được bảng Giỏ cá.'); } return; }
    if (f.stage === 'select') { const selector = findClickable(/chon ca thuong(?:\s*\(\s*\d+\s*\))?/); if (!selector) { bagFlow = null; if (running) stop('Không tìm thấy nút “Chọn cá thường”.'); return; } const label = normalize(labelOf(selector)); const numberMatch = label.match(/chon ca thuong\s*\(\s*(\d+)\s*\)/); const n = numberMatch ? Number(numberMatch[1]) : null; if (n === 0) { bagFlow = null; closeBagModal(); if (running) stop('Không có cá thường để bán.'); return; } selector.click(); f.selected = n; f.stage = 'wait_selected'; f.stageAt = now; setStatus('Đã chọn cá thường…', 'Xử lý giỏ'); return; }
    if (f.stage === 'wait_selected') { const sale = findClickable(/ban\s+\d+\s+con(?:\s*\+\s*[\d.,]+)?/); if (sale) { const text = normalize(labelOf(sale)); const countMatch = text.match(/ban\s+(\d+)\s+con/); const selectedCount = countMatch ? Number(countMatch[1]) : 0; if (selectedCount <= 0) { bagFlow = null; closeBagModal(); if (running) stop('Số cá được chọn không rõ.'); return; } sale.click(); f.stage = 'wait_sale'; f.stageAt = now; f.selling = selectedCount; setStatus(`Đang bán ${selectedCount} cá…`, 'Đang bán'); return; } if (now - f.stageAt > 3_000) { bagFlow = null; closeBagModal(); if (running) stop('Không thấy nút bán.'); } return; }
    if (f.stage === 'wait_sale') { const text = normalize(pageText()); if (/ban.*ca.*(xac nhan|ban chac|dong y)|xac nhan ban/.test(text)) { const confirm = findClickable(/^(xac nhan|dong y|ban ngay)$/); if (confirm && now - f.stageAt > 500) { confirm.click(); f.stageAt = now; log('Đã bấm xác nhận bán cá.'); return; } } const current = readBagCount(); const saleSuccessText = /ban thanh cong|da ban .*ca|ban .*ca thanh cong|thanh cong.*linh thach/.test(text); if (current && f.before !== null && current.source === 'dom' && current.count < f.before) { const sold = f.before - current.count; const shouldStopAfter = f.stopAfter; bagFlow = null; closeBagModal(); phase = 'idle'; phaseSince = now; log(`Bán xong ${sold} cá thường; giỏ còn ${current.count}/${current.capacity}.`); if (shouldStopAfter) { stop(`Bán xong. Giỏ còn ${current.count}/${current.capacity}.`); return; } setStatus(`Bán xong. Giỏ còn ${current.count}/${current.capacity}.`, 'Đã bán xong'); return; } if (f.beforeSource === 'manual' && saleSuccessText && Number.isInteger(f.selling) && f.selling > 0) { const updated = Math.max(0, Number($('#hh3df-manual-count').value || f.before || 0) - f.selling); $('#hh3df-manual-count').value = updated; const shouldStopAfter = f.stopAfter; bagFlow = null; closeBagModal(); phase = 'idle'; phaseSince = now; log(`Đã bán ${f.selling} cá; bộ đếm cập nhật còn ${updated}/${CFG.capacity}.`); if (shouldStopAfter) { stop(`Đã bán xong. Bộ đếm còn ${updated}/${CFG.capacity}.`); return; } setStatus(`Đã bán xong. Bộ đếm còn ${updated}/${CFG.capacity}.`, 'Đã bán xong'); return; } if (now - f.stageAt > 6_500) { bagFlow = null; if (running) stop('Chưa xác minh được số lượng giỏ sau khi bán.'); } }
  }

  async function tick() {
    if (!running || loopBusy) return; loopBusy = true;
    try {
      autoSell = $('#hh3df-autosell').checked;
      if (challengeVisible()) { stop('Game đang yêu cầu xác minh/CAPTCHA. Tool đã dừng.'); return; }
      if (bagFlow) { await tickBagFlow(); return; }
      const now = Date.now(); const bag = readBagCount(); const controls = fishingControls(); const isResult = resultVisible(); const bite = biteVisible();
      if (isResult) { if (phase !== 'result') enterResult(now, 'Nhận diện được chữ/thẻ kết quả cá trên giao diện.'); else if (now - phaseSince > 9_000) { stop('Thẻ kết quả vẫn còn hiển thị sau 9 giây. Tool đã dừng.'); } return; }
      if (phase === 'result') { if (now - phaseSince < CFG.resultGraceMs) return; phase = 'idle'; phaseSince = now; castRetryCount = 0; log('Hết thời gian chờ kết quả; kiểm tra giỏ rồi mới bắt đầu lượt tiếp theo.'); }
      if (autoSell && bag && bag.capacity === CFG.capacity && bag.count >= CFG.sellAt && phase === 'idle') { startBagFlow('auto'); return; }
      if (phase === 'idle') { if (now - lastActionAt < CFG.actionCooldownMs) return; if (controls.cast) { await performCastSequence(); phase = 'casting'; phaseSince = now; interfaceMisses = 0; setStatus('Đã gửi thao tác ném câu...', 'Đang ném câu'); } else { interfaceMisses++; setStatus('Chưa nhận diện được nút “Ném câu”.', 'Chưa nhận diện được nút'); if (interfaceMisses >= CFG.maxInterfaceMisses) stop('Không tìm thấy nút “Ném câu”. Tool đã dừng.'); } return; }
      if (phase === 'casting') {
        const holdLabel = controls.hold ? normalize(labelOf(controls.hold)) : '';
        const isRealHoldBtn = holdLabel === 'giu' || holdLabel === 'giu can' || holdLabel.startsWith('giu ');
        if (isRealHoldBtn || (bite && isRealHoldBtn)) { phase = 'reeling'; phaseSince = now; reelStartedAt = now; holdStartedAt = 0; setStatus('Đã nhận diện giao diện kéo cá...', 'Đang kéo cá'); log(`Đã phát hiện trạng thái minigame: nút "${labelOf(controls.hold)}" xuất hiện.`); castRetryCount = 0; return; }
        if (controls.waiting || controls.withdraw) { phase = 'waiting_bite'; phaseSince = now; setStatus('Game đã nhận ném câu; đang chờ cá cắn…', 'Đang chờ cá'); log('Đã xác nhận trạng thái sau khi ném câu: Chờ cá/Thu cần.'); castRetryCount = 0; return; }
        if (!controls.cast) { phase = 'waiting_bite'; phaseSince = now; log('Nút Ném câu biến mất sau thao tác; chờ tín hiệu cá cắn.'); castRetryCount = 0; return; }
        if (now - phaseSince > CFG.castTransitionTimeoutMs) { if (castRetryCount < 3) { castRetryCount++; log(`Game chưa chuyển trạng thái sau khi ném câu (thử lại lần ${castRetryCount}/3).`); phase = 'idle'; phaseSince = now; lastActionAt = now - CFG.actionCooldownMs; } else { stop('Game không chuyển trạng thái sau khi ném câu quá 3 lần. Tool dừng.'); } } return;
      }
      if (phase === 'waiting_bite') {
        const holdLabel = controls.hold ? normalize(labelOf(controls.hold)) : '';
        const isRealHoldBtn = holdLabel === 'giu' || holdLabel === 'giu can' || holdLabel.startsWith('giu ');
        if (isRealHoldBtn || (bite && isRealHoldBtn)) { phase = 'reeling'; phaseSince = now; reelStartedAt = now; holdStartedAt = 0; setStatus('Cá đã cắn; đang giữ nút theo minigame.', 'Đang kéo cá'); log(`Chuyển sang kéo cá: nút "${labelOf(controls.hold)}" xuất hiện.`); return; }
        if (bite && !isRealHoldBtn && now - phaseSince > 2_500) { stop('Có dấu hiệu cá cắn nhưng chưa tìm được nút Giữ.'); return; }
        if (now - phaseSince > CFG.castWaitTimeoutMs) { stop('Đợi cá quá lâu mà không nhận diện được tín hiệu cắn câu.'); return; }
        if (Math.floor((now - phaseSince) / 10_000) !== Math.floor((now - phaseSince - CFG.pollMs) / 10_000)) { setStatus(`Đã ném câu; đang chờ cá (${Math.floor((now - phaseSince) / 1000)} giây)…`, 'Đang chờ cá'); } return;
      }
      if (phase === 'reeling') {
        if (now - reelStartedAt > CFG.reelTimeoutMs || (holdStartedAt && now - holdStartedAt > CFG.maxHoldMs)) { stop('Giai đoạn kéo cá vượt thời gian giới hạn.'); return; }
        const currentControls = fishingControls(); const castStillVisible = !!currentControls.cast && normalize(labelOf(currentControls.cast)).includes('nem cau');
        if (castStillVisible) { if (heldTarget) { log(`Phát hiện nút "Ném câu" vẫn hiện. Nhả nút và chờ kết quả.`); releaseHeldTarget(); } enterResult(now, 'Minigame kết thúc hoặc không bắt đầu.', true); return; }
        const holdLabel = currentControls.hold ? normalize(labelOf(currentControls.hold)) : '';
        const isRealHoldBtn = holdLabel === 'giu' || holdLabel === 'giu can' || holdLabel.startsWith('giu ');
        const holdIsMinigame = isRealHoldBtn && !currentControls.waiting && !currentControls.withdraw && !castStillVisible;
        if (holdIsMinigame) { if (!heldTarget || !heldTarget.isConnected || heldTarget !== currentControls.hold) { if (beginHold(currentControls.hold)) { setStatus(`Đang giữ nút "${labelOf(currentControls.hold)}" liên tục trong minigame.`, 'Đang kéo cá'); } } return; }
        if (currentControls.waiting || currentControls.withdraw) { releaseHeldTarget(); if (now - reelStartedAt > 1_500) enterResult(now, 'Giao diện kéo đã kết thúc.', true); return; }
        if (!currentControls.hold && now - phaseSince > 3_000) { stop('Nút “Giữ” biến mất nhưng không thấy trạng thái kết thúc.'); }
      }
    } catch (e) { console.error('[HH3D Fishing] Error:', e); stop(`Lỗi runtime: ${e?.message || 'không rõ'}.`); } finally { loopBusy = false; }
  }

  // --- GẮN SỰ KIỆN UI ---
  tapXSlider.addEventListener('input', (e) => { tapXVal.textContent = e.target.value + '%'; });
  tapYSlider.addEventListener('input', (e) => { tapYVal.textContent = e.target.value + '%'; });
  fab.addEventListener('click', () => { panel.style.display = panel.style.display === 'block' ? 'none' : 'block'; });
  $('#hh3df-hide').addEventListener('click', () => { panel.style.display = 'none'; });
  $('#hh3df-start').addEventListener('click', start);
  $('#hh3df-stop').addEventListener('click', () => stop('Đã dừng theo yêu cầu.'));
  $('#hh3df-autosell').addEventListener('change', (e) => { autoSell = !!e.target.checked; log(`Tự bán cá thường: ${autoSell ? 'BẬT' : 'TẮT'}.`); });
  $('#hh3df-sell').addEventListener('click', () => { if (bagFlow) return; const wasRunning = running; if (!running) { running = true; phase = 'idle'; castRetryCount = 0; if (loopHandle) clearInterval(loopHandle); loopHandle = setInterval(tick, CFG.pollMs); } startBagFlow('manual', !wasRunning); if (!wasRunning) setStatus('Đang xử lý bán cá thường; sau khi xong tool sẽ dừng.', 'Bán cá thủ công'); });
  $('#hh3df-check').addEventListener('click', () => { const c = fishingControls(); const tests = [ ['Ném câu', c.cast], ['Giữ', c.hold], ['Chờ cá', c.waiting], ['Thu cần', c.withdraw] ]; const found = tests.map(([name, control]) => control ? `✓ ${name} [${control.tagName}] "${labelOf(control).substring(0, 20)}"` : `— ${name}`).join('\n'); log('Kiểm tra giao diện:\n' + found); setStatus('Đã kiểm tra. Xem nhật ký.', 'Kiểm tra xong'); });
  $('#hh3df-test-cast').addEventListener('click', async () => { log('Bắt đầu Test Câu đầy đủ (Chạm hồ -> Giữ nút)...'); const success = await performCastSequence(); if (success) log('Đã gửi thao tác. Quan sát chấm đỏ/vàng và phản hồi của game.'); else log('Không tìm thấy nút "Ném câu" để test.'); });
  
  $('#hh3df-test-canvas').addEventListener('click', async () => {
    const tapX = (parseInt(tapXSlider.value, 10) / 100) * window.innerWidth;
    const tapY = (parseInt(tapYSlider.value, 10) / 100) * window.innerHeight;
    log(`Test Chạm Hồ tại X=${tapXSlider.value}%, Y=${tapYSlider.value}%`);
    await simulateTapAt(tapX, tapY);
    log('Đã chạm hồ. Nếu game không hiện hiệu ứng gì, có thể game chặn click ảo.');
  });

  $('#hh3df-test-button').addEventListener('click', async () => {
    const castBtn = findClickable(/nem cau/);
    if (castBtn) {
      log('Test giữ nút "Ném câu" trong 1000ms...');
      await holdElement(castBtn, 1000);
      log('Đã giữ nút. Nếu nhân vật không ném cần, có thể game chặn click ảo.');
    } else log('Không tìm thấy nút "Ném câu".');
  });

  $('#hh3df-clear').addEventListener('click', () => { logLines = []; logEl.textContent = 'Đã xóa nhật ký.'; });

  log('Tool v0.1.9 đã nạp. Bấm "Test Chạm Hồ" và "Test Nút" để kiểm tra phản hồi của game.');
  setStatus('Sẵn sàng. Chỉnh tọa độ chạm hồ trước khi Bắt đầu.', 'Sẵn sàng');
  window.addEventListener('pagehide', () => { running = false; releaseHeldTarget(); if (loopHandle) clearInterval(loopHandle); });
})();

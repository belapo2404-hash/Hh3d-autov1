// ==UserScript==
// @name         HH3D - Tiên Giới Câu Cá Auto (Beta)
// @namespace    hh3d-tien-gioi-fishing
// @version      0.1.3
// @description  Tool câu cá Tiên Giới: bám trạng thái Ném câu/Chờ cá/Giữ, giữ cá quý và hỗ trợ bán cá thường ở 22/24.
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
    pollMs: 550,
    castWaitTimeoutMs: 90_000,
    reelTimeoutMs: 14_000,
    actionCooldownMs: 1_000,
    castTransitionTimeoutMs: 3_000,
    resultGraceMs: 6_500,
    maxHoldMs: 10_000,
    maxInterfaceMisses: 12,
  };

  let running = false;
  let autoSell = true;
  let phase = 'idle'; // idle | casting | waiting_bite | reeling | result | bag
  let phaseSince = 0;
  let lastActionAt = 0;
  let holdStartedAt = 0;
  let reelStartedAt = 0;
  let interfaceMisses = 0;
  let bagFlow = null;
  let loopHandle = null;
  let heldTarget = null;
  let logLines = [];
  let loopBusy = false;

  const normalize = (s) => String(s ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'd')
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
      #${ROOT_ID} button.fish-small { padding:7px 8px; font-size:11px; }
      #${ROOT_ID} label { display:flex; align-items:center; gap:7px; margin:7px 0; color:#e4dff0; }
      #${ROOT_ID} input[type=checkbox] { width:17px; height:17px; accent-color:#42c7a3; }
      #${ROOT_ID} .fish-count-row { display:flex; align-items:center; gap:8px; margin:7px 0; color:#e4dff0; font-size:11px; }
      #${ROOT_ID} .fish-count-row input { width:64px; min-width:64px; padding:6px; border-radius:6px; border:1px solid #585766; background:#121219; color:#fff; }
      #${ROOT_ID} .fish-note { color:#c3bfce; font-size:11px; margin-top:8px; }
      #${ROOT_ID} .fish-log { white-space:pre-wrap; font-size:10px; color:#d4d0df; background:#111117; border-radius:8px; padding:7px; margin-top:8px; max-height:110px; overflow:auto; }
      #${ROOT_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:4px 8px !important; flex:0 0 auto !important; }
    </style>
    <button type="button" class="fish-fab" id="hh3df-fab">🎣 Câu Cá</button>
    <section class="fish-panel" id="hh3df-panel">
      <div class="fish-head"><span>🎣 Tiên Giới · Câu Cá Auto <small>BETA 0.1.3</small></span><button class="fish-action fish-collapse" id="hh3df-hide" type="button">Ẩn</button></div>
      <div class="fish-status" id="hh3df-status">Trạng thái: <strong>Sẵn sàng</strong></div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-start" id="hh3df-start">▶ Bắt đầu</button>
        <button type="button" class="fish-action fish-stop" id="hh3df-stop">■ Dừng</button>
      </div>
      <label><input type="checkbox" id="hh3df-autosell" checked> Tự bán cá thường khi giỏ đạt 22/24</label>
      <div class="fish-count-row"><span>Số cá hiện tại nếu không tự đọc được:</span><input type="number" id="hh3df-manual-count" min="0" max="24" step="1" inputmode="numeric" placeholder="0–24" /></div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-sell" id="hh3df-sell">🧺 Bán cá thường ngay</button>
      </div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-small" id="hh3df-check">🔎 Kiểm tra giao diện</button>
        <button type="button" class="fish-action fish-small" id="hh3df-clear">Xóa nhật ký</button>
      </div>
      <div class="fish-note">Cá viền tím, vàng, đỏ/hồng cần được giữ lại. Tool ưu tiên nút “Chọn cá thường”. Nếu game không cho đọc số cá, nhập số lượng đang thấy trên màn hình. Khi gặp CAPTCHA/xác minh hoặc không xác nhận được thao tác, tool sẽ dừng.</div>
      <div class="fish-log" id="hh3df-log">Chưa có hoạt động.</div>
    </section>`;
  function mountTool() {
    const existing = document.getElementById(ROOT_ID);
    if (existing && existing !== root) return;
    if (!root.isConnected) {
      const host = document.body || document.documentElement;
      if (host) host.appendChild(root);
    }
    // Reassert visibility in case the game UI changes stacking/inline styles.
    if (root.isConnected) {
      root.style.setProperty('position', 'fixed', 'important');
      root.style.setProperty('z-index', '2147483647', 'important');
      root.style.setProperty('pointer-events', 'auto', 'important');
    }
  }
  mountTool();
  document.addEventListener('DOMContentLoaded', mountTool, { once: true });
  const mountObserver = new MutationObserver(() => {
    if (!root.isConnected) mountTool();
  });
  mountObserver.observe(document.documentElement, { childList: true, subtree: true });

  const $ = (sel) => root.querySelector(sel);
  const fab = $('#hh3df-fab');
  const panel = $('#hh3df-panel');
  const statusEl = $('#hh3df-status');
  const logEl = $('#hh3df-log');
  const manualCountEl = $('#hh3df-manual-count');
  function saveManualCount(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0 || n > CFG.capacity) return false;
    manualCountEl.value = String(n);
    return true;
  }

  function setStatus(message, strong = '') {
    statusEl.innerHTML = `Trạng thái: <strong>${escapeHtml(strong || message)}</strong>${strong ? `<div style="margin-top:3px">${escapeHtml(message)}</div>` : ''}`;
  }

  function log(message) {
    const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
    logLines.unshift(`[${time}] ${message}`);
    logLines = logLines.slice(0, 8);
    logEl.textContent = logLines.join('\n');
  }

  function pageText() {
    if (!document.body) return '';
    // Loại nội dung panel của chính tool để status/log không tự kích hoạt bộ nhận diện.
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      if (!parent || parent.closest(`#${ROOT_ID}`)) continue;
      let hidden = false;
      for (let el = parent; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) { hidden = true; break; }
      }
      if (!hidden) parts.push(node.nodeValue || '');
    }
    return parts.join(' ');
  }

  function visible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (el.closest(`#${ROOT_ID}`)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    for (let parent = el; parent && parent !== document.documentElement; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    }
    return true;
  }

  function labelOf(el) {
    const raw = el.getAttribute('aria-label') || el.getAttribute('title') || el.value || el.innerText || el.textContent || '';
    return String(raw).replace(/\s+/g, ' ').trim();
  }

  function isActionable(el) {
    if (el.matches('button,a,[role="button"],[onclick],input[type="button"],input[type="submit"],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"])')) return true;
    // Some game controls are React divs without an onclick attribute; accept only those styled as interactive.
    return ['DIV', 'SPAN'].includes(el.tagName) && getComputedStyle(el).cursor === 'pointer';
  }

  function findClickable(regex) {
    const selectors = 'button,a,[role="button"],[onclick],input[type="button"],input[type="submit"],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"]),div,span';
    const matches = Array.from(document.querySelectorAll(selectors)).filter((el) => {
      if (!visible(el) || !isActionable(el)) return false;
      const text = normalize(labelOf(el));
      if (!text || text.length > 80 || !regex.test(text)) return false;
      if (el.matches('button:disabled,input:disabled,[aria-disabled="true"]')) return false;
      return true;
    });
    const rank = (el) => el.matches('button,a,[role="button"],input[type="button"],input[type="submit"]') ? 0 :
      el.matches('[onclick],.btn,.cursor-pointer,[tabindex]:not([tabindex="-1"])') ? 1 : 2;
    matches.sort((a, b) => {
      const rankDiff = rank(a) - rank(b);
      if (rankDiff) return rankDiff;
      const la = normalize(labelOf(a)).length, lb = normalize(labelOf(b)).length;
      if (la !== lb) return la - lb;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) - (rb.width * rb.height);
    });
    return matches[0] || null;
  }

  function findHoldButton() {
    // Match the actual interactive control labelled “Giữ”, not any text that merely contains this word.
    return findClickable(/(^|[^a-z])giu([^a-z]|$)/);
  }

  function fishingControls() {
    return {
      cast: findClickable(/nem cau/),
      hold: findHoldButton(),
      waiting: findClickable(/cho ca/),
      withdraw: findClickable(/thu can/),
    };
  }

  function clickElement(el) {
    if (!el || !visible(el)) return false;
    try {
      el.click();
      lastActionAt = Date.now();
      return true;
    } catch (e) {
      log(`Không bấm được nút: ${e.message}`);
      return false;
    }
  }

  function readBagCountFromDOM() {
    const text = normalize(pageText());
    const re = /gio(?:\s+ca)?\s*(\d{1,3})\s*\/\s*(\d{1,3})/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const count = Number(match[1]), capacity = Number(match[2]);
      if (capacity >= 1 && capacity <= 1000 && count >= 0 && count <= capacity) return { count, capacity, source: 'dom' };
    }
    return null;
  }

  function readBagCount() {
    const actual = readBagCountFromDOM();
    if (actual) return actual;
    const raw = manualCountEl?.value;
    if (raw !== undefined && raw !== '') {
      const count = Number(raw);
      if (Number.isInteger(count) && count >= 0 && count <= CFG.capacity) return { count, capacity: CFG.capacity, source: 'manual' };
    }
    return null;
  }

  function noteCatchForManualCount() {
    if (readBagCountFromDOM()) return;
    const raw = manualCountEl?.value;
    if (raw === undefined || raw === '') {
      log('Lượt câu đã kết thúc nhưng game không cho đọc số giỏ; nhập số cá hiện tại để theo dõi ngưỡng 22/24.');
      return;
    }
    const current = Number(raw);
    if (Number.isInteger(current) && current >= 0 && current < CFG.capacity) {
      saveManualCount(current + 1);
      log(`Đã cập nhật bộ đếm thủ công: ${current} → ${current + 1}/${CFG.capacity} (ước tính theo lượt câu hoàn tất).`);
    }
  }

  function resultVisible() {
    const text = normalize(pageText());
    return /ca\s*[·•]\s*(pho thong|quy|hiem|huyen thoai|than thoai)/i.test(text) ||
      /moi\s*[·•]?\s*ca\s*[·•]\s*pho thong/i.test(text) ||
      (/do khung/.test(text) && /\bkg\b/.test(text)) ||
      /ban da cau duoc|cau ca thanh cong|ket qua cau ca/i.test(text);
  }

  function biteVisible() {
    const text = normalize(pageText());
    return /dinh roi|ca can cau|ca can moi|can cau roi/i.test(text);
  }

  function challengeVisible() {
    const text = normalize(pageText());
    return /captcha|xac minh ban khong phai robot|verify you are human|kiem tra an ninh|xac minh tai khoan|ma xac nhan/i.test(text);
  }

  function beginHold(target) {
    if (!target || !visible(target)) return false;
    if (heldTarget === target && target.isConnected) return true;
    releaseHeldTarget();
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0, buttons: 1 };
      if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerdown', opts));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
      heldTarget = target;
      holdStartedAt = Date.now();
      lastActionAt = holdStartedAt;
      return true;
    } catch (e) {
      log(`Lỗi bắt đầu giữ cần: ${e.message}`);
      releaseHeldTarget();
      return false;
    }
  }

  function releaseHeldTarget() {
    if (!heldTarget) return;
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0 };
      if (typeof PointerEvent === 'function' && heldTarget.isConnected) heldTarget.dispatchEvent(new PointerEvent('pointerup', opts));
      if (heldTarget.isConnected) heldTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window }));
    } catch (_) {}
    heldTarget = null;
    holdStartedAt = 0;
  }

  function enterResult(now, reason, countCatch = true) {
    if (phase === 'result') return;
    const priorPhase = phase;
    releaseHeldTarget();
    if (countCatch && ['casting', 'waiting_bite', 'reeling'].includes(priorPhase)) noteCatchForManualCount();
    phase = 'result';
    phaseSince = now;
    log(reason);
    setStatus('Lượt câu đã kết thúc; chờ bảng kết quả đóng trước khi câu tiếp.', 'Đợi kết quả');
  }

  function stop(reason) {
    running = false;
    releaseHeldTarget();
    bagFlow = null;
    phase = 'idle';
    phaseSince = 0;
    if (loopHandle) {
      clearInterval(loopHandle);
      loopHandle = null;
    }
    setStatus(reason || 'Đã dừng', 'Đã dừng');
    log(reason || 'Đã dừng tool.');
  }

  function start() {
    if (running) return;
    running = true;
    autoSell = $('#hh3df-autosell').checked;
    phase = 'idle';
    phaseSince = Date.now();
    interfaceMisses = 0;
    bagFlow = null;
    setStatus('Đang kiểm tra giao diện trước khi ném câu…', 'Đang chạy');
    log('Bắt đầu. Chỉ thao tác qua các nút giao diện nhận diện được.');
    if (loopHandle) clearInterval(loopHandle);
    loopHandle = setInterval(tick, CFG.pollMs);
    tick();
  }

  function isBagOpen() {
    const text = normalize(pageText());
    return /linh thach/.test(text) && /chon ca thuong|bo chon|tha ve ho/.test(text) && /gio ca/.test(text);
  }

  function startBagFlow(reason = 'manual', stopAfter = false) {
    if (bagFlow) return;
    const bag = readBagCount();
    bagFlow = { stage: 'open', before: bag?.count ?? null, beforeSource: bag?.source ?? null, capacity: bag?.capacity ?? CFG.capacity, startedAt: Date.now(), reason, stopAfter, stageAt: Date.now(), selected: null };
    phase = 'bag';
    log(reason === 'auto' ? 'Giỏ đạt ngưỡng; mở giỏ để chọn cá thường.' : 'Mở giỏ để bán cá thường theo yêu cầu.');
  }

  function closeBagModal() {
    const closeCandidates = Array.from(document.querySelectorAll('button,[role="button"],[aria-label],[title]')).filter((el) => {
      if (!visible(el) || el.closest(`#${ROOT_ID}`)) return false;
      const label = normalize(labelOf(el));
      return /^(x|×|✕|dong|close|thoat)$/.test(label) || /close|dong/.test(normalize(el.getAttribute('aria-label') || '') + ' ' + normalize(el.getAttribute('title') || ''));
    });
    if (closeCandidates.length && clickElement(closeCandidates[0])) return true;
    const nav = findClickable(/gio ca(?:\s*\d+\s*\/\s*\d+)?/);
    return clickElement(nav);
  }

  async function tickBagFlow() {
    if (!bagFlow) return;
    const f = bagFlow;
    const now = Date.now();
    if (now - f.startedAt > 30_000) {
      bagFlow = null;
      if (running) stop('Đã dừng an toàn: thao tác giỏ cá không hoàn tất trong thời gian chờ.');
      return;
    }

    if (f.stage === 'open') {
      if (isBagOpen()) {
        f.stage = 'select'; f.stageAt = now;
        return;
      }
      const nav = findClickable(/gio ca(?:\s*\d+\s*\/\s*\d+)?/);
      if (nav) {
        if (!clickElement(nav)) {
          bagFlow = null; if (running) stop('Không mở được Giỏ cá; tool đã dừng để tránh thao tác sai.'); return;
        }
        f.stage = 'wait_open'; f.stageAt = now;
        setStatus('Đang mở Giỏ cá…', 'Xử lý giỏ');
      } else if (now - f.stageAt > 2_500) {
        if (!f.manualOpenPrompted) {
          f.manualOpenPrompted = true;
          setStatus('Không đọc được nút Giỏ cá từ DOM. Anh mở Giỏ cá trực tiếp; tool sẽ chờ nhận diện bảng chọn cá thường.', 'Cần mở giỏ thủ công');
          log('Nút Giỏ cá có thể được vẽ trong canvas; chờ anh mở giỏ bằng tay, không bấm tọa độ đoán mò.');
        }
      }
      return;
    }

    if (f.stage === 'wait_open') {
      if (isBagOpen()) { f.stage = 'select'; f.stageAt = now; return; }
      if (now - f.stageAt > 4_500) {
        bagFlow = null; if (running) stop('Không nhận diện được bảng Giỏ cá; không bán để tránh bán nhầm.');
      }
      return;
    }

    if (f.stage === 'select') {
      const selector = findClickable(/chon ca thuong(?:\s*\(\s*\d+\s*\))?/);
      if (!selector) {
        bagFlow = null;
        if (running) stop('Không tìm thấy nút “Chọn cá thường”; đã dừng và không bán cá.');
        return;
      }
      const label = normalize(labelOf(selector));
      const numberMatch = label.match(/chon ca thuong\s*\(\s*(\d+)\s*\)/);
      const n = numberMatch ? Number(numberMatch[1]) : null;
      if (n === 0) {
        bagFlow = null;
        closeBagModal();
        if (running) stop('Không có cá thường để bán. Đã giữ nguyên cá trong giỏ và dừng câu để tránh đầy giỏ.');
        return;
      }
      if (!clickElement(selector)) {
        bagFlow = null; if (running) stop('Không chọn được cá thường; không thực hiện bán.'); return;
      }
      f.selected = n;
      f.stage = 'wait_selected'; f.stageAt = now;
      setStatus('Đã yêu cầu chọn cá thường; chờ cập nhật lựa chọn…', 'Xử lý giỏ');
      return;
    }

    if (f.stage === 'wait_selected') {
      const sale = findClickable(/ban\s+\d+\s+con(?:\s*\+\s*[\d.,]+)?/);
      if (sale) {
        const text = normalize(labelOf(sale));
        const countMatch = text.match(/ban\s+(\d+)\s+con/);
        const selectedCount = countMatch ? Number(countMatch[1]) : 0;
        if (selectedCount <= 0) {
          bagFlow = null; closeBagModal();
          if (running) stop('Số cá được chọn không rõ; không bán.');
          return;
        }
        if (!clickElement(sale)) {
          bagFlow = null; if (running) stop('Không bấm được nút bán; tool đã dừng.'); return;
        }
        f.stage = 'wait_sale'; f.stageAt = now; f.selling = selectedCount;
        setStatus(`Đã yêu cầu bán ${selectedCount} cá thường; kiểm tra kết quả…`, 'Đang bán');
        log(`Yêu cầu game bán ${selectedCount} cá thường bằng nút tích hợp sẵn.`);
        return;
      }
      if (now - f.stageAt > 3_000) {
        bagFlow = null; closeBagModal();
        if (running) stop('Không thấy nút bán sau khi chọn cá thường; đã dừng, chưa thử bán lại.');
      }
      return;
    }

    if (f.stage === 'wait_sale') {
      const text = normalize(pageText());
      // Chỉ xác nhận khi game thực sự hiện một hộp thoại xác nhận bán.
      if (/ban.*ca.*(xac nhan|ban chac|dong y)|xac nhan ban/.test(text)) {
        const confirm = findClickable(/^(xac nhan|dong y|ban ngay)$/);
        if (confirm && now - f.stageAt > 500) {
          clickElement(confirm); f.stageAt = now;
          log('Đã bấm xác nhận trong hộp thoại bán cá do game hiển thị.');
          return;
        }
      }
      const current = readBagCount();
      const saleSuccessText = /ban thanh cong|da ban .*ca|ban .*ca thanh cong|thanh cong.*linh thach/.test(text);
      if (current && f.before !== null && current.source === 'dom' && current.count < f.before) {
        const sold = f.before - current.count;
        log(`Game đã cập nhật giỏ ${f.before}/${current.capacity} → ${current.count}/${current.capacity}.`);
        const shouldStopAfter = f.stopAfter;
        bagFlow = null;
        closeBagModal();
        phase = 'idle'; phaseSince = now;
        log(`Bán xong ${sold} cá thường; giỏ còn ${current.count}/${current.capacity}.`);
        if (shouldStopAfter) { stop(`Bán xong ${sold} cá thường; giỏ còn ${current.count}/${current.capacity}.`); return; }
        setStatus(`Bán xong ${sold} cá thường; giỏ còn ${current.count}/${current.capacity}.`, 'Đã bán xong');
        return;
      }
      if (f.beforeSource === 'manual' && saleSuccessText && Number.isInteger(f.selling) && f.selling > 0) {
        const updated = Math.max(0, Number(manualCountEl.value || f.before || 0) - f.selling);
        saveManualCount(updated);
        const shouldStopAfter = f.stopAfter;
        bagFlow = null;
        closeBagModal();
        phase = 'idle'; phaseSince = now;
        log(`Bán được ${f.selling} cá theo thông báo thành công; bộ đếm thủ công cập nhật còn ${updated}/${CFG.capacity}.`);
        if (shouldStopAfter) { stop(`Đã bán theo xác nhận của game; bộ đếm còn ${updated}/${CFG.capacity}.`); return; }
        setStatus(`Game báo bán thành công; bộ đếm còn ${updated}/${CFG.capacity}.`, 'Đã bán xong');
        return;
      }
      if (now - f.stageAt > 6_500) {
        bagFlow = null;
        if (running) stop('Chưa xác minh được số lượng giỏ sau khi bán. Tool không thử bán lần hai để tránh thao tác trùng.');
      }
    }
  }

  async function tick() {
    if (!running || loopBusy) return;
    loopBusy = true;
    try {
      autoSell = $('#hh3df-autosell').checked;
      if (challengeVisible()) {
        stop('Game đang yêu cầu xác minh/CAPTCHA. Tool đã dừng; hãy tự hoàn tất xác minh nếu muốn tiếp tục.');
        return;
      }
      if (bagFlow) {
        await tickBagFlow();
        return;
      }

      const now = Date.now();
      const bag = readBagCount();
      const controls = fishingControls();
      const isResult = resultVisible();
      const bite = biteVisible();

      if (isResult) {
        if (phase !== 'result') enterResult(now, 'Nhận diện được chữ/thẻ kết quả cá trên giao diện.');
        else if (now - phaseSince > 9_000) {
          stop('Thẻ kết quả vẫn còn hiển thị sau 9 giây. Tool đã dừng để anh đóng kết quả thủ công, tránh ném câu chồng lên thẻ cá.');
        }
        return;
      }

      if (phase === 'result') {
        // If the result was drawn on canvas, it may not be readable as DOM text; leave a grace period.
        if (now - phaseSince < CFG.resultGraceMs) return;
        phase = 'idle';
        phaseSince = now;
        log('Hết thời gian chờ kết quả; kiểm tra giỏ rồi mới bắt đầu lượt tiếp theo.');
      }

      // Ưu tiên bán ở 22/24 trước khi ném câu tiếp theo.
      if (autoSell && bag && bag.capacity === CFG.capacity && bag.count >= CFG.sellAt && phase === 'idle') {
        startBagFlow('auto');
        return;
      }

      if (phase === 'idle') {
        if (now - lastActionAt < CFG.actionCooldownMs) return;
        if (controls.cast) {
          if (clickElement(controls.cast)) {
            phase = 'casting';
            phaseSince = now;
            interfaceMisses = 0;
            setStatus('Đã yêu cầu ném câu; xác nhận game chuyển sang trạng thái chờ cá…', 'Đang ném câu');
            log('Đã bấm nút “Ném câu”; chờ nút đổi sang “Chờ cá/Thu cần”.');
          }
        } else {
          interfaceMisses++;
          setStatus('Chưa nhận diện được nút “Ném câu” trong DOM; bấm Kiểm tra giao diện để xem.', 'Chưa nhận diện được nút');
          if (interfaceMisses >= CFG.maxInterfaceMisses) stop('Không tìm thấy nút “Ném câu” sau nhiều lần kiểm tra. Có thể game vẽ nút trong canvas; tool đã dừng thay vì bấm đoán.');
        }
        return;
      }

      if (phase === 'casting') {
        const holdIsMinigame = !!controls.hold && !controls.waiting && !controls.withdraw && !controls.cast;
        if (controls.waiting || controls.withdraw) {
          phase = 'waiting_bite';
          phaseSince = now;
          setStatus('Game đã nhận ném câu; đang chờ cá cắn…', 'Đang chờ cá');
          log('Đã xác nhận trạng thái sau khi ném câu: Chờ cá/Thu cần.');
          return;
        }
        if (bite && controls.hold || holdIsMinigame) {
          phase = 'reeling';
          phaseSince = now;
          reelStartedAt = now;
          holdStartedAt = 0;
          setStatus('Đã nhận diện giao diện kéo cá; bắt đầu giữ nút “Giữ”.', 'Đang kéo cá');
          log('Đã phát hiện trạng thái minigame: nút “Giữ” xuất hiện và nút chờ/thu cần biến mất.');
          return;
        }
        if (!controls.cast) {
          phase = 'waiting_bite';
          phaseSince = now;
          log('Nút Ném câu biến mất sau thao tác; chờ tín hiệu cá cắn.');
          return;
        }
        if (now - phaseSince > CFG.castTransitionTimeoutMs) {
          stop('Game không chuyển trạng thái sau khi bấm Ném câu. Có thể nút chưa nhận thao tác hoặc thẻ kết quả còn mở; tool dừng để tránh bấm chồng.');
        }
        return;
      }

      if (phase === 'waiting_bite') {
        const holdIsMinigame = !!controls.hold && !controls.waiting && !controls.withdraw && !controls.cast;
        if ((bite && controls.hold && !controls.waiting && !controls.withdraw && !controls.cast) || holdIsMinigame) {
          phase = 'reeling';
          phaseSince = now;
          reelStartedAt = now;
          holdStartedAt = 0;
          setStatus('Cá đã cắn; đang giữ nút theo minigame.', 'Đang kéo cá');
          log('Chuyển sang kéo cá: nút Giữ xuất hiện sau khi trạng thái chờ cá biến mất.');
          return;
        }
        if (bite && !controls.hold && now - phaseSince > 2_500) {
          stop('Có dấu hiệu cá cắn nhưng chưa tìm được nút Giữ tương tác; dừng để không bấm nhầm.');
          return;
        }
        if (now - phaseSince > CFG.castWaitTimeoutMs) {
          stop('Đợi cá quá lâu mà không nhận diện được tín hiệu cắn câu. Tool đã dừng để không ném chồng lượt.');
          return;
        }
        if (Math.floor((now - phaseSince) / 10_000) !== Math.floor((now - phaseSince - CFG.pollMs) / 10_000)) {
          setStatus(`Đã ném câu; đang chờ cá (${Math.floor((now - phaseSince) / 1000)} giây)…`, 'Đang chờ cá');
        }
        return;
      }

      if (phase === 'reeling') {
        if (now - reelStartedAt > CFG.reelTimeoutMs || (holdStartedAt && now - holdStartedAt > CFG.maxHoldMs)) {
          stop('Giai đoạn kéo cá vượt thời gian giới hạn; đã nhả nút và dừng để tránh giữ/bấm vô hạn.');
          return;
        }
        const currentControls = fishingControls();
        const holdIsMinigame = !!currentControls.hold && !currentControls.waiting && !currentControls.withdraw && !currentControls.cast;
        if (holdIsMinigame) {
          if (!heldTarget || !heldTarget.isConnected || heldTarget !== currentControls.hold) {
            if (beginHold(currentControls.hold)) {
              setStatus('Đang giữ nút “Giữ” liên tục trong minigame; tự nhả khi kết thúc.', 'Đang kéo cá');
              log('Bắt đầu/khôi phục trạng thái giữ nút theo UI minigame.');
            }
          }
          return;
        }
        // Khi minigame biến mất và nút Ném câu quay lại, coi lượt kéo đã kết thúc; chờ kết quả/grace period.
        if (currentControls.cast && !currentControls.waiting && !currentControls.withdraw) {
          enterResult(now, 'Minigame kết thúc và nút “Ném câu” quay lại; chờ kết quả cá.', true);
          return;
        }
        if (currentControls.waiting || currentControls.withdraw) {
          releaseHeldTarget();
          if (now - reelStartedAt > 1_500) enterResult(now, 'Giao diện kéo đã kết thúc, game quay về trạng thái chờ.', true);
          return;
        }
        if (!currentControls.hold && now - phaseSince > 3_000) {
          stop('Nút “Giữ” biến mất nhưng không thấy trạng thái kết thúc rõ ràng; đã nhả nút và dừng an toàn.');
        }
      }
    } catch (e) {
      console.error('[HH3D Fishing] Error:', e);
      stop(`Lỗi runtime: ${e?.message || 'không rõ'}. Tool đã dừng an toàn.`);
    } finally {
      loopBusy = false;
    }
  }

  function inspectInterface() {
    const c = fishingControls();
    const tests = [
      ['Ném câu', c.cast],
      ['Giữ (nút tương tác)', c.hold],
      ['Chờ cá', c.waiting],
      ['Thu cần', c.withdraw],
      ['Giỏ cá', findClickable(/gio ca(?:\s*\d+\s*\/\s*\d+)?/)],
      ['Chọn cá thường', findClickable(/chon ca thuong/)],
      ['Bán cá', findClickable(/ban\s+\d+\s+con/)],
    ];
    const found = tests.map(([name, control]) => `${control ? '✓' : '—'} ${name}`).join('\n');
    const bag = readBagCount();
    const bagSource = bag ? (bag.source === 'manual' ? ' (đã nhập thủ công)' : ' (đọc từ trang)') : '';
    const result = `${found}\n${bag ? `✓ Giỏ: ${bag.count}/${bag.capacity}${bagSource}` : '— Chưa đọc được số lượng giỏ; nhập số hiện tại nếu cần theo dõi 22/24'}\n${resultVisible() ? '✓ Có chữ kết quả trong DOM' : '— Kết quả có thể được vẽ trên canvas'}\n${biteVisible() ? '✓ Có chữ báo cá cắn trong DOM' : '— Không thấy chữ cá cắn trong DOM; dùng chuyển trạng thái nút'}`;
    log('Kiểm tra giao diện:\n' + result);
    setStatus('Đã kiểm tra. Xem nhật ký để biết các nút nhận diện được.', 'Kiểm tra xong');
  }

  fab.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
  $('#hh3df-hide').addEventListener('click', () => { panel.style.display = 'none'; });
  $('#hh3df-start').addEventListener('click', start);
  $('#hh3df-stop').addEventListener('click', () => stop('Đã dừng theo yêu cầu của anh.'));
  manualCountEl.addEventListener('change', () => {
    const raw = manualCountEl.value;
    if (raw === '') return;
    if (!saveManualCount(raw)) {
      manualCountEl.value = '';
      log('Số cá thủ công phải là số nguyên từ 0 đến 24.');
    } else { log(`Đã đặt số cá thủ công: ${manualCountEl.value}/24. Bộ đếm không tự lưu qua lần tải trang để tránh dùng số cũ.`); }
  });
  $('#hh3df-autosell').addEventListener('change', (e) => {
    autoSell = !!e.target.checked;
    log(`Tự bán cá thường: ${autoSell ? 'BẬT (ngưỡng 22/24)' : 'TẮT'}.`);
  });
  $('#hh3df-sell').addEventListener('click', () => {
    if (bagFlow) return;
    const wasRunning = running;
    if (!running) {
      // Chạy riêng quy trình bán một lần, không tự ném câu.
      running = true;
      phase = 'idle';
      if (loopHandle) clearInterval(loopHandle);
      loopHandle = setInterval(tick, CFG.pollMs);
    }
    startBagFlow('manual', !wasRunning);
    if (!wasRunning) setStatus('Đang xử lý bán cá thường; sau khi xong tool sẽ dừng.', 'Bán cá thủ công');
  });
  $('#hh3df-check').addEventListener('click', inspectInterface);
  $('#hh3df-clear').addEventListener('click', () => { logLines = []; logEl.textContent = 'Đã xóa nhật ký.'; });

  // Keep the beta conservative: all unexpected states end in a visible stop rather than repeated actions.

  log('Tool v0.1.3 đã nạp. Kiểm tra giao diện trước khi bắt đầu; nếu không đọc được giỏ, nhập số cá đang thấy trên màn hình.');
  setStatus('Sẵn sàng. Kiểm tra giao diện trước lượt đầu tiên.', 'Sẵn sàng');

  window.addEventListener('pagehide', () => {
    running = false;
    releaseHeldTarget();
    if (loopHandle) clearInterval(loopHandle);
  });
})();

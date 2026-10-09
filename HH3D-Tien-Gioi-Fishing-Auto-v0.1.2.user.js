// ==UserScript==
// @name         HH3D - Tiên Giới Câu Cá Auto (Beta)
// @namespace    hh3d-tien-gioi-fishing
// @version      0.1.2
// @description  Tool câu cá Tiên Giới: tự ném câu/kéo khi nhận diện được nút DOM, bán cá thường ở ngưỡng 22/24, bảo vệ cá quý.
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
    holdMs: 520,
    reelPulseEveryMs: 950,
    maxInterfaceMisses: 12,
  };

  let running = false;
  let autoSell = true;
  let phase = 'idle'; // idle | waiting_bite | reeling | result | bag
  let phaseSince = 0;
  let lastActionAt = 0;
  let lastPulseAt = 0;
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
      #${ROOT_ID} .fish-note { color:#c3bfce; font-size:11px; margin-top:8px; }
      #${ROOT_ID} .fish-log { white-space:pre-wrap; font-size:10px; color:#d4d0df; background:#111117; border-radius:8px; padding:7px; margin-top:8px; max-height:110px; overflow:auto; }
      #${ROOT_ID} .fish-collapse { background:transparent !important; border:1px solid #555 !important; padding:4px 8px !important; flex:0 0 auto !important; }
    </style>
    <button type="button" class="fish-fab" id="hh3df-fab">🎣 Câu Cá</button>
    <section class="fish-panel" id="hh3df-panel">
      <div class="fish-head"><span>🎣 Tiên Giới · Câu Cá Auto <small>BETA 0.1.2</small></span><button class="fish-action fish-collapse" id="hh3df-hide" type="button">Ẩn</button></div>
      <div class="fish-status" id="hh3df-status">Trạng thái: <strong>Sẵn sàng</strong></div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-start" id="hh3df-start">▶ Bắt đầu</button>
        <button type="button" class="fish-action fish-stop" id="hh3df-stop">■ Dừng</button>
      </div>
      <label><input type="checkbox" id="hh3df-autosell" checked> Tự bán cá thường khi giỏ đạt 22/24</label>
      <div class="fish-row">
        <button type="button" class="fish-action fish-sell" id="hh3df-sell">🧺 Bán cá thường ngay</button>
      </div>
      <div class="fish-row">
        <button type="button" class="fish-action fish-small" id="hh3df-check">🔎 Kiểm tra giao diện</button>
        <button type="button" class="fish-action fish-small" id="hh3df-clear">Xóa nhật ký</button>
      </div>
      <div class="fish-note">Cá viền tím, vàng, đỏ/hồng cần được giữ lại. Tool dùng nút “Chọn cá thường” có sẵn trong game; không tự bán nếu không nhận diện chắc chắn. Khi gặp CAPTCHA/xác minh hoặc lỗi, tool sẽ dừng.</div>
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
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return true;
  }

  function labelOf(el) {
    return [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.value]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  }

  function findClickable(regex) {
    const selectors = 'button,a,[role="button"],[onclick],input[type="button"],input[type="submit"],.cursor-pointer,.btn,div,span';
    const all = Array.from(document.querySelectorAll(selectors));
    const matches = all.filter((el) => {
      if (!visible(el)) return false;
      const text = normalize(labelOf(el));
      if (!text || text.length > 100) return false;
      if (!regex.test(text)) return false;
      if (el.matches('button:disabled,input:disabled,[aria-disabled="true"]')) return false;
      return true;
    });
    matches.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const aa = ra.width * ra.height, ab = rb.width * rb.height;
      if (aa !== ab) return aa - ab;
      const aClickable = a.matches('button,a,[role="button"],[onclick],input,.btn,.cursor-pointer') ? 0 : 1;
      const bClickable = b.matches('button,a,[role="button"],[onclick],input,.btn,.cursor-pointer') ? 0 : 1;
      return aClickable - bClickable;
    });
    return matches[0] || null;
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

  function readBagCount() {
    const text = normalize(pageText());
    const re = /gio(?:\s+ca)?\s*(\d{1,3})\s*\/\s*(\d{1,3})/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const count = Number(match[1]), capacity = Number(match[2]);
      if (capacity >= 1 && capacity <= 1000 && count >= 0 && count <= capacity) return { count, capacity };
    }
    return null;
  }

  function resultVisible() {
    const text = normalize(pageText());
    return /ca\s*[·•]\s*(pho thong|quy|hiem|huyen thoai|than thoai)/i.test(text) ||
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

  function clickHoldPulse(target) {
    if (!target || !visible(target)) return false;
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0 };
      if (typeof PointerEvent === 'function') {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
      }
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window }));
      heldTarget = target;
      window.setTimeout(() => {
        try {
          if (typeof PointerEvent === 'function') target.dispatchEvent(new PointerEvent('pointerup', opts));
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window }));
          // Một click cuối để hỗ trợ giao diện chỉ lắng nghe click thay vì sự kiện giữ.
          if (visible(target)) target.click();
        } catch (_) {}
        if (heldTarget === target) heldTarget = null;
      }, CFG.holdMs);
      lastActionAt = Date.now();
      return true;
    } catch (e) {
      log(`Lỗi thao tác kéo cần: ${e.message}`);
      return false;
    }
  }

  function releaseHeldTarget() {
    if (!heldTarget) return;
    try {
      const opts = { bubbles: true, cancelable: true, composed: true, pointerType: 'touch', isPrimary: true, button: 0 };
      if (typeof PointerEvent === 'function') heldTarget.dispatchEvent(new PointerEvent('pointerup', opts));
      heldTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, buttons: 0, view: window }));
    } catch (_) {}
    heldTarget = null;
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
    bagFlow = { stage: 'open', before: bag?.count ?? null, capacity: bag?.capacity ?? CFG.capacity, startedAt: Date.now(), reason, stopAfter, stageAt: Date.now(), selected: null };
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
    if (now - f.startedAt > 18_000) {
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
      } else if (now - f.stageAt > 3_000) {
        bagFlow = null; if (running) stop('Không tìm thấy nút Giỏ cá trên giao diện.');
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
      if (current && f.before !== null && current.count < f.before) {
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
      const isResult = resultVisible();
      const bite = biteVisible();

      if (isResult) {
        if (phase !== 'result') {
          releaseHeldTarget();
          phase = 'result'; phaseSince = now;
          log('Nhận diện bảng kết quả cá; chờ giao diện trở lại trạng thái câu.');
          setStatus('Đã câu được cá; chờ đóng bảng kết quả…', 'Đợi kết quả');
        }
        return;
      }

      if (phase === 'result') {
        if (now - phaseSince > 900) {
          phase = 'idle'; phaseSince = now;
          log('Bảng kết quả đã biến mất; sẵn sàng cho lượt tiếp theo.');
        }
        return;
      }

      // Ưu tiên bán ở 22/24 trước khi ném câu tiếp theo.
      if (autoSell && bag && bag.capacity === CFG.capacity && bag.count >= CFG.sellAt && phase === 'idle') {
        startBagFlow('auto');
        return;
      }

      if (phase === 'idle') {
        if (now - lastActionAt < CFG.actionCooldownMs) return;
        const cast = findClickable(/nem cau/);
        if (cast) {
          if (clickElement(cast)) {
            phase = 'waiting_bite'; phaseSince = now;
            interfaceMisses = 0;
            setStatus('Đã ném câu; đang chờ tín hiệu cá cắn…', 'Đang chờ cá');
            log('Đã bấm nút “Ném câu”.');
          }
        } else {
          interfaceMisses++;
          setStatus('Chưa nhận diện được nút “Ném câu” trong DOM; bấm Kiểm tra giao diện để xem.', 'Chưa nhận diện được nút');
          if (interfaceMisses >= CFG.maxInterfaceMisses) stop('Không tìm thấy nút “Ném câu” sau nhiều lần kiểm tra. Có thể game vẽ nút trong canvas; tool đã dừng thay vì bấm đoán.');
        }
        return;
      }

      if (phase === 'waiting_bite') {
        const hold = findClickable(/giu/);
        if (bite || hold) {
          if (!hold) {
            if (now - phaseSince > 2_500) stop('Đã nhận diện tín hiệu cá cắn nhưng không tìm thấy nút “Giữ”; dừng để tránh thao tác sai.');
            return;
          }
          phase = 'reeling'; phaseSince = now; reelStartedAt = now; lastPulseAt = 0;
          setStatus('Cá đã cắn câu; đang thử điều khiển nút “Giữ”…', 'Đang kéo cá');
          log('Nhận diện tín hiệu cá cắn và nút “Giữ”.');
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
        if (now - reelStartedAt > CFG.reelTimeoutMs) {
          stop('Giai đoạn kéo cá vượt thời gian giới hạn; tool dừng để tránh spam thao tác.');
          return;
        }
        const hold = findClickable(/giu/);
        if (!bite && !hold) {
          // Nếu nút Ném câu đã quay lại, minigame có thể đã kết thúc nhưng kết quả chưa được đọc.
          const castAgain = findClickable(/nem cau/);
          if (castAgain) {
            releaseHeldTarget();
            phase = 'idle'; phaseSince = now;
            log('Nút “Ném câu” đã trở lại; kết thúc pha kéo và kiểm tra giỏ.');
            return;
          }
        }
        if (!hold) {
          if (now - phaseSince > 3_000) stop('Nút “Giữ” biến mất khi đang kéo; tool đã dừng chờ kiểm tra thủ công.');
          return;
        }
        if (now - lastPulseAt >= CFG.reelPulseEveryMs) {
          if (clickHoldPulse(hold)) {
            lastPulseAt = now;
            setStatus('Đang điều khiển nút “Giữ”; sẽ tự dừng nếu không nhận diện được kết quả.', 'Đang kéo cá');
          }
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
    const tests = [
      ['Ném câu', /nem cau/],
      ['Giữ', /giu/],
      ['Giỏ cá', /gio ca/],
      ['Chọn cá thường', /chon ca thuong/],
      ['Bán cá', /ban\s+\d+\s+con/],
    ];
    const found = tests.map(([name, re]) => `${findClickable(re) ? '✓' : '—'} ${name}`).join('\n');
    const bag = readBagCount();
    const result = `${found}\n${bag ? `✓ Giỏ: ${bag.count}/${bag.capacity}` : '— Chưa đọc được số lượng giỏ'}\n${resultVisible() ? '✓ Đang hiển thị bảng kết quả' : '— Không thấy bảng kết quả'}\n${biteVisible() ? '✓ Nhận diện tín hiệu cá cắn trong DOM' : '— Chưa thấy tín hiệu cá cắn trong DOM'}`;
    log('Kiểm tra giao diện:\n' + result);
    setStatus('Đã kiểm tra. Xem nhật ký để biết các nút nhận diện được.', 'Kiểm tra xong');
  }

  fab.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
  });
  $('#hh3df-hide').addEventListener('click', () => { panel.style.display = 'none'; });
  $('#hh3df-start').addEventListener('click', start);
  $('#hh3df-stop').addEventListener('click', () => stop('Đã dừng theo yêu cầu của anh.'));
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

  // Nếu người dùng chỉ bấm bán cá thường ngay, dừng sau khi hoàn tất thay vì tiếp tục câu.
  const originalTickBagFlow = tickBagFlow;
  // Keep the beta conservative: all unexpected states end in a visible stop rather than repeated actions.

  log('Tool đã nạp. Mở bảng 🎣, bấm “Kiểm tra giao diện”, rồi mới “Bắt đầu”.');
  setStatus('Sẵn sàng. Hãy kiểm tra giao diện trước lượt đầu tiên.', 'Sẵn sàng');

  window.addEventListener('pagehide', () => {
    running = false;
    releaseHeldTarget();
    if (loopHandle) clearInterval(loopHandle);
  });
})();

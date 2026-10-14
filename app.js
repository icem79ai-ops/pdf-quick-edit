'use strict';

/* ============================================================
   PDF Quick Edit v0.2
   - WYSIWYG preview (เห็นผลจริงทันที) + auto-size ฉลาด + ปรับเองได้
   - จัดแนวนอน/สี/กลบพื้น + ลากย้าย/ปรับขนาดกล่อง
   - Undo/Redo + บันทึกงานอัตโนมัติ (IndexedDB) + หมุน/ลบหน้า
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* ---------------- utils ---------------- */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
const LINE_H = 1.3;
const PAD = 2;
const FONT_FAMILY = 'SarabunEmb';

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function bytesToB64(bytes) { let s = ''; const u = new Uint8Array(bytes); const CH = 0x8000; for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); return btoa(s); }
function hexToRgb01(hex) { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [0, 0, 0]; const n = parseInt(m[1], 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
function fmtTime(ts) { try { return new Date(ts).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
let toastTimer = null;
function toast(msg, ms) { const el = $('toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms || 2600); }
let uid = 1; const newId = () => 'e' + (uid++);

/* ---------------- IndexedDB (autosave) ---------------- */
function idbOpen() {
  return new Promise((res, rej) => {
    let r;
    try { r = indexedDB.open('pdfquickedit', 1); } catch (e) { return rej(e); }
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error || new Error('idb'));
  });
}
async function idbPut(key, val) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').put(val, key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); }
async function idbGet(key) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction('sessions', 'readonly'); const rq = tx.objectStore('sessions').get(key); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); }); }
async function idbDel(key) { const db = await idbOpen(); return new Promise((res, rej) => { const tx = db.transaction('sessions', 'readwrite'); tx.objectStore('sessions').delete(key); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }

/* ---------------- state ---------------- */
const state = {
  pdf: null,
  bytes: null,
  fileName: '',
  pageNum: 1,
  pageCount: 0,
  scale: 1.0,
  rotation: 0,          // view-only rotation
  mode: 'find',
  viewport: null,
  pageW: 612, pageH: 792,
  edits: [],            // {id,page,x,y,w,h,text,size(null=auto),align,color,fillMode,fillColor}
  pending: null,        // {page,x,y,w,h}
  selectedId: null,
  lastProps: { size: null, align: 'left', color: '#000000', fillMode: 'white', fillColor: '#ffffff' },
  pageOps: { rotate: {}, deleted: [] },
  history: [], hIdx: -1,
  font: null,
  textItems: [],
  baseName: 'document'
};

/* ---------------- font ---------------- */
function injectFontFace() {
  if (!window.SARABUN_B64) return;
  try {
    const st = document.createElement('style');
    st.textContent = `@font-face{font-family:'${FONT_FAMILY}';src:url(data:font/ttf;base64,${window.SARABUN_B64}) format('truetype');font-weight:400;font-style:normal;font-display:block;}`;
    document.head.appendChild(st);
    if (document.fonts && document.fonts.load) document.fonts.load(`16px ${FONT_FAMILY}`).catch(() => {});
  } catch (e) { console.warn('font-face', e); }
}

async function loadFont() {
  if (state.font) return state.font;
  let bytes = null;
  if (window.SARABUN_B64) bytes = b64ToBytes(window.SARABUN_B64);
  else { const r = await fetch('lib/Sarabun-Regular.ttf'); bytes = new Uint8Array(await r.arrayBuffer()); }
  state.font = await state.pdfDocLib.embedFont(bytes, { subset: true });
  return state.font;
}

/* ---------------- measure + fit ---------------- */
let measureCtx = null;
function measureText(text, sizePt) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = sizePt + 'px ' + FONT_FAMILY + ', sans-serif';
  return measureCtx.measureText(text).width;
}

// คืนขนาด (PDF points). manual != null → ใช้ค่าผู้ใช้. เริ่มจาก "พอดีความสูง" แล้วย่อเฉพาะเมื่อล้นความกว้าง
function fitSize(text, boxW, boxH, manual) {
  if (manual != null) return manual;
  const maxW = Math.max(boxW - PAD * 2, 3);
  const maxH = Math.max(boxH - PAD * 2, 3);
  const lines = String(text).split('\n');
  const n = Math.max(lines.length, 1);
  let size = Math.min(maxH / (n * LINE_H) * 1.06, maxH, 72);
  size = Math.max(size, 3);
  for (let i = 0; i < 500; i++) {
    let over = false;
    for (const l of lines) { if (l && measureText(l, size) > maxW) { over = true; break; } }
    if (!over) break;
    size -= 0.25; if (size <= 3) { size = 3; break; }
  }
  return Math.round(size * 100) / 100;
}

/* ---------------- coordinate mapping ---------------- */
function screenFromPdfRect(r) {
  const vp = state.viewport; if (!vp) return null;
  const p1 = vp.convertToViewportPoint(r.x, r.y + r.h);         // top-left (PDF y-up)
  const p2 = vp.convertToViewportPoint(r.x + r.w, r.y);
  const left = Math.min(p1[0], p2[0]), top = Math.min(p1[1], p2[1]);
  return { left, top, w: Math.abs(p2[0] - p1[0]), h: Math.abs(p2[1] - p1[1]) };
}
function pdfPointFromClient(clientX, clientY) {
  const r = $('pdfCanvas').getBoundingClientRect();
  return state.viewport.convertToPdfPoint(clientX - r.left, clientY - r.top);
}
function pdfRectFromClient(x1, y1, x2, y2) {
  const a = pdfPointFromClient(x1, y1), b = pdfPointFromClient(x2, y2);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}
function pageBounds() { return { w: state.pageW, h: state.pageH }; }

/* ---------------- render ---------------- */
let renderToken = 0;
async function renderPage() {
  if (!state.pdf) return;
  const token = ++renderToken;
  const page = await state.pdf.getPage(state.pageNum);
  if (token !== renderToken) return;
  const totalRot = ((page.rotate || 0) + (state.rotation || 0)) % 360;
  const vp = page.getViewport({ scale: state.scale, rotation: totalRot });
  state.viewport = vp;
  const view = page.view; // [x0,y0,x1,y1]
  state.pageW = view[2] - view[0];
  state.pageH = view[3] - view[1];

  const canvas = $('pdfCanvas'), ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vp.width, vp.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  if (token !== renderToken) return;

  const wrap = $('canvasWrap');
  wrap.style.width = vp.width + 'px';
  wrap.style.height = vp.height + 'px';

  buildTextLayer(page, vp);
  renderWys();
  renderOverlays();
  updateDocControls();
}

function buildTextLayer(page, vp) {
  const layer = $('textLayer');
  layer.innerHTML = '';
  layer.style.width = vp.width + 'px';
  layer.style.height = vp.height + 'px';
  state.textItems = [];
  return page.getTextContent().then((tc) => {
    const Util = pdfjsLib.Util;
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue;
      const tx = Util.transform(vp.transform, item.transform);
      const fontH = Math.hypot(tx[2], tx[3]) || 8;
      const w = item.width * vp.scale;
      const left = tx[4], baseline = tx[5];
      const top = baseline - fontH;
      const el = document.createElement('div');
      el.className = 'tl-item';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.width = Math.max(w, 2) + 'px';
      el.style.height = (fontH * 1.18) + 'px';
      el.dataset.text = item.str;
      el.addEventListener('click', () => onTextClick(el));
      layer.appendChild(el);
      state.textItems.push({ text: item.str, el });
    }
  }).catch(() => {});
}

/* WYSIWYG layer — จำลองผลลัพธ์จริง */
function renderWys() {
  const layer = $('wysLayer');
  layer.innerHTML = '';
  if (!state.viewport) return;
  const items = state.edits.filter((e) => e.page === state.pageNum);
  if (state.pending && state.pending.page === state.pageNum) {
    items.push(Object.assign({ _pending: true, text: '' }, state.pending, state.lastProps));
  }
  for (const e of items) {
    const s = screenFromPdfRect(e); if (!s) continue;
    const box = document.createElement('div');
    box.className = 'wys-box';
    box.style.left = s.left + 'px'; box.style.top = s.top + 'px';
    box.style.width = s.w + 'px'; box.style.height = s.h + 'px';
    if (e.fillMode === 'none') box.style.background = 'transparent';
    else box.style.background = (e.fillMode === 'custom' ? e.fillColor : '#ffffff');
    if (!e.text) {
      box.classList.add('empty');
      layer.appendChild(box);
      continue;
    }
    const size = fitSize(e.text, e.w, e.h, e.size);
    const txt = document.createElement('div');
    txt.className = 'wys-text';
    txt.style.color = e.color;
    txt.style.fontSize = (size * state.scale) + 'px';
    txt.style.lineHeight = (size * LINE_H * state.scale) + 'px';
    txt.style.padding = (PAD * state.scale) + 'px';
    txt.style.textAlign = e.align;
    txt.textContent = e.text;
    box.appendChild(txt);
    layer.appendChild(box);
  }
}

/* กรอบควบคุม + จุดจับ + กล่องวาด/รอเพิ่ม */
function renderOverlays() {
  const ov = $('editOverlay');
  ov.innerHTML = '';
  const dl = $('drawLayer');

  if (state.pending) {
    const s = screenFromPdfRect(state.pending);
    if (s) {
      const d = document.createElement('div');
      d.className = 'pending-rect';
      d.style.left = s.left + 'px'; d.style.top = s.top + 'px'; d.style.width = s.w + 'px'; d.style.height = s.h + 'px';
      ov.appendChild(d);
    }
  }

  state.edits.filter((e) => e.page === state.pageNum).forEach((e) => {
    const s = screenFromPdfRect(e); if (!s) return;
    const d = document.createElement('div');
    d.className = 'edit-rect' + (e.id === state.selectedId ? ' sel' : '');
    d.style.left = s.left + 'px'; d.style.top = s.top + 'px'; d.style.width = s.w + 'px'; d.style.height = s.h + 'px';
    d.dataset.id = e.id;
    const num = document.createElement('span');
    num.className = 'num'; num.textContent = state.edits.indexOf(e) + 1;
    d.appendChild(num);
    if (e.id === state.selectedId && state.mode === 'edit') {
      for (const pos of ['nw', 'ne', 'sw', 'se']) {
        const h = document.createElement('div');
        h.className = 'handle ' + pos; h.dataset.handle = pos; h.dataset.id = e.id;
        d.appendChild(h);
      }
    }
    ov.appendChild(d);
  });
}

/* ---------------- interactions ---------------- */
function onTextClick(el) {
  if (state.mode !== 'find') return;
  const rr = el.getBoundingClientRect();
  const rect = pdfRectFromClient(rr.left, rr.top, rr.right, rr.bottom);
  const p = pageBounds();
  state.pending = {
    page: state.pageNum,
    x: clamp(rect.x, 0, p.w), y: clamp(rect.y, 0, p.h),
    w: clamp(rect.w, 4, p.w), h: clamp(rect.h, 4, p.h)
  };
  state.selectedId = null;
  $('searchInfo').textContent = '';
  openPanelForTarget();
  renderWys(); renderOverlays();
  $('newText').focus();
}

/* draw mode: drag to create box */
function setupDraw() {
  const dl = $('drawLayer');
  let start = null, box = null;
  dl.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'draw' || !state.viewport) return;
    ev.preventDefault();
    dl.setPointerCapture(ev.pointerId);
    start = { x: ev.clientX, y: ev.clientY };
    box = document.createElement('div');
    box.className = 'draw-rect';
    dl.appendChild(box);
  });
  dl.addEventListener('pointermove', (ev) => {
    if (!start || !box) return;
    const l = Math.min(start.x, ev.clientX), t = Math.min(start.y, ev.clientY);
    const w = Math.abs(ev.clientX - start.x), h = Math.abs(ev.clientY - start.y);
    const cr = $('pdfCanvas').getBoundingClientRect();
    box.style.left = (l - cr.left) + 'px'; box.style.top = (t - cr.top) + 'px';
    box.style.width = w + 'px'; box.style.height = h + 'px';
  });
  dl.addEventListener('pointerup', (ev) => {
    if (!start) return;
    const rect = pdfRectFromClient(start.x, start.y, ev.clientX, ev.clientY);
    start = null; if (box) box.remove(); box = null;
    if (rect.w < 6 || rect.h < 5) return;
    const p = pageBounds();
    state.pending = { page: state.pageNum, x: clamp(rect.x, 0, p.w), y: clamp(rect.y, 0, p.h), w: rect.w, h: rect.h };
    state.selectedId = null;
    openPanelForTarget();
    renderWys(); renderOverlays();
    $('newText').focus();
  });
}

/* edit mode: select / move / resize */
function setupEditInteractions() {
  const ov = $('editOverlay');
  let drag = null;

  ov.addEventListener('pointerdown', (ev) => {
    if (state.mode !== 'edit') return;
    const handle = ev.target.dataset && ev.target.dataset.handle;
    const rectEl = ev.target.closest ? ev.target.closest('.edit-rect') : null;
    if (!rectEl) return;
    const id = rectEl.dataset.id;
    const e = state.edits.find((x) => x.id === id); if (!e) return;
    ev.preventDefault();
    ev.stopPropagation();
    ov.setPointerCapture(ev.pointerId);
    selectEdit(id);
    drag = {
      id, handle: handle || 'move',
      start: { x: e.x, y: e.y, w: e.w, h: e.h },
      startPt: pdfPointFromClient(ev.clientX, ev.clientY),
      moved: false
    };
  });

  ov.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    const e = state.edits.find((x) => x.id === drag.id); if (!e) return;
    const cur = pdfPointFromClient(ev.clientX, ev.clientY);
    const dx = cur.x - drag.startPt.x, dy = cur.y - drag.startPt.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 0.8) return;
    drag.moved = true;
    const st = drag.start;
    if (drag.handle === 'move') {
      e.x = st.x + dx; e.y = st.y + dy;
    } else {
      let x1, y1, x2, y2;
      if (drag.handle === 'nw') { x1 = st.x + dx; y1 = st.y + dy; x2 = st.x + st.w; y2 = st.y + st.h; }
      else if (drag.handle === 'ne') { x1 = st.x; y1 = st.y + dy; x2 = st.x + st.w + dx; y2 = st.y + st.h; }
      else if (drag.handle === 'sw') { x1 = st.x + dx; y1 = st.y; x2 = st.x + st.w; y2 = st.y + st.h + dy; }
      else { x1 = st.x; y1 = st.y; x2 = st.x + st.w + dx; y2 = st.y + st.h + dy; }
      e.x = Math.min(x1, x2); e.y = Math.min(y1, y2);
      e.w = Math.max(Math.abs(x2 - x1), 4); e.h = Math.max(Math.abs(y2 - y1), 4);
    }
    renderWys(); renderOverlays();
  });

  const end = () => {
    if (drag && drag.moved) { commit(); autosaveSoon(); updateEditList(); openPanelForTarget(); }
    drag = null;
  };
  ov.addEventListener('pointerup', end);
  ov.addEventListener('pointercancel', end);
}

/* ---------------- selection + panel ---------------- */
function selectEdit(id) {
  state.selectedId = id;
  state.pending = null;
  if (state.mode !== 'edit') setMode('edit', false);
  openPanelForTarget();
  renderWys(); renderOverlays(); updateEditList();
}
function getTarget() {
  if (state.selectedId) return state.edits.find((e) => e.id === state.selectedId) || null;
  return null;
}
function openPanelForTarget() {
  const t = getTarget();
  const hasPending = !!state.pending;
  const panel = $('editPanel');
  panel.hidden = !(t || hasPending);
  if (!t && !hasPending) return;
  const p = t || state.lastProps;
  $('editPanelTitle').textContent = t ? 'แก้ไขกล่อง ' + (state.edits.indexOf(t) + 1) : 'ข้อความใหม่';
  $('newText').value = t ? t.text : '';
  $('sizeAuto').checked = (t ? t.size : state.lastProps.size) == null;
  const sz = (t ? t.size : state.lastProps.size) || 12;
  $('sizeRange').value = sz; $('sizeNum').value = sz;
  $('sizeRow').hidden = $('sizeAuto').checked;
  setAlignUI(t ? t.align : state.lastProps.align);
  $('textColor').value = t ? t.color : state.lastProps.color;
  $('fillMode').value = t ? t.fillMode : state.lastProps.fillMode;
  $('fillColor').value = t ? t.fillColor : state.lastProps.fillColor;
  $('fillColor').hidden = $('fillMode').value !== 'custom';
  $('addEditBtn').disabled = !hasPending;
  $('selectedRow').hidden = !t;
  $('addEditBtn').hidden = !hasPending;
  $('cancelSelBtn').hidden = !(t || hasPending);
  $('selectionInfo').textContent = t
    ? ('หน้า ' + t.page + ' • x' + t.x.toFixed(0) + ' y' + t.y.toFixed(0) + ' • ' + t.w.toFixed(0) + '×' + t.h.toFixed(0))
    : (state.pending ? ('กล่องใหม่ หน้า ' + state.pending.page) : '');
}
function setAlignUI(a) {
  document.querySelectorAll('#alignSeg button').forEach((b) => b.classList.toggle('on', b.dataset.align === a));
}

/* ---------------- apply property changes ---------------- */
function applyProps(patch) {
  const t = getTarget();
  if (t) {
    Object.assign(t, patch);
    renderWys(); autosaveSoon();
    commitSoon();
  } else {
    Object.assign(state.lastProps, patch);
    if (state.pending) renderWys();
  }
}

/* ---------------- edits CRUD ---------------- */
function addEdit() {
  if (!state.pending) return;
  const e = Object.assign({ id: newId(), text: $('newText').value }, state.pending, state.lastProps);
  if (!e.text.trim()) { toast('พิมพ์ข้อความก่อนครับ'); return; }
  state.edits.push(e);
  state.pending = null;
  state.selectedId = e.id;
  commit(); autosaveSoon();
  renderWys(); renderOverlays(); updateEditList();
  openPanelForTarget();
  toast('เพิ่มการแก้ไขแล้ว');
}
function deleteEdit(id) {
  commit();
  state.edits = state.edits.filter((e) => e.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  autosaveSoon();
  renderWys(); renderOverlays(); updateEditList(); openPanelForTarget();
}
function duplicateEdit(id) {
  const e = state.edits.find((x) => x.id === id); if (!e) return;
  commit();
  const c = Object.assign({}, e, { id: newId(), x: e.x + 12, y: e.y - 12 });
  state.edits.push(c);
  state.selectedId = c.id;
  autosaveSoon();
  renderWys(); renderOverlays(); updateEditList(); openPanelForTarget();
}
function updateEditList() {
  const ul = $('editList');
  ul.innerHTML = '';
  $('editCount').textContent = state.edits.length;
  state.edits.forEach((e, i) => {
    const li = document.createElement('li');
    if (e.id === state.selectedId) li.classList.add('sel');
    const lab = document.createElement('span');
    lab.className = 'edit-label';
    const shown = (e.text || '(กล่องเปล่า)').replace(/\n/g, ' ⏎ ');
    lab.textContent = (i + 1) + '. [น.' + e.page + '] ' + shown;
    lab.title = shown;
    lab.onclick = () => { state.pageNum = e.page; renderPage(); selectEdit(e.id); };
    const del = document.createElement('button');
    del.className = 'btn'; del.textContent = '✕'; del.title = 'ลบ';
    del.onclick = (ev) => { ev.stopPropagation(); deleteEdit(e.id); };
    li.appendChild(lab); li.appendChild(del);
    ul.appendChild(li);
  });
}

/* ---------------- pages panel ---------------- */
function updatePagesList() {
  const ul = $('pagesList');
  ul.innerHTML = '';
  $('pageCount').textContent = state.pageCount;
  for (let n = 1; n <= state.pageCount; n++) {
    const li = document.createElement('li');
    const isDel = state.pageOps.deleted.includes(n);
    const rot = state.pageOps.rotate[n] || 0;
    const lab = document.createElement('span');
    lab.className = 'pnum';
    lab.innerHTML = isDel ? '<del>หน้า ' + n + '</del>' : ('หน้า ' + n) + (rot ? ' <span class="badge">⟳' + rot + '°</span>' : '');
    lab.onclick = () => { state.pageNum = n; renderPage(); };
    if (isDel) li.style.opacity = .55;
    const rotBtn = document.createElement('button');
    rotBtn.className = 'btn neutral'; rotBtn.textContent = '⟳'; rotBtn.title = 'หมุนหน้านี้ 90° (ถาวรในไฟล์)';
    rotBtn.onclick = () => { commit(); state.pageOps.rotate[n] = ((rot || 0) + 90) % 360; autosaveSoon(); updatePagesList(); };
    const delBtn = document.createElement('button');
    delBtn.className = 'btn'; delBtn.textContent = isDel ? '↺' : '🗑';
    delBtn.title = isDel ? 'กู้คืนหน้านี้' : 'ลบหน้านี้ (ถาวรในไฟล์)';
    delBtn.onclick = () => {
      commit();
      if (isDel) state.pageOps.deleted = state.pageOps.deleted.filter((x) => x !== n);
      else {
        if (state.pageOps.deleted.length >= state.pageCount - 1) { toast('ต้องเหลืออย่างน้อย 1 หน้า'); return; }
        state.pageOps.deleted.push(n);
      }
      autosaveSoon(); updatePagesList();
    };
    li.appendChild(lab); li.appendChild(rotBtn); li.appendChild(delBtn);
    ul.appendChild(li);
  }
}

/* ---------------- history ---------------- */
function snapshot() { return JSON.stringify({ edits: state.edits, pageOps: state.pageOps }); }
function initHistory() { state.history = [snapshot()]; state.hIdx = 0; updateUndoUI(); }
function commit() {
  const s = snapshot();
  if (state.history[state.hIdx] === s) return;
  state.history = state.history.slice(0, state.hIdx + 1);
  state.history.push(s);
  if (state.history.length > 80) state.history.shift();
  state.hIdx = state.history.length - 1;
  updateUndoUI();
}
const commitSoon = debounce(() => { commit(); }, 500);
function applySnapshot(s) {
  const o = JSON.parse(s);
  state.edits = o.edits; state.pageOps = o.pageOps;
  if (state.selectedId && !state.edits.find((e) => e.id === state.selectedId)) state.selectedId = null;
  renderWys(); renderOverlays(); updateEditList(); updatePagesList();
}
function undo() { if (state.hIdx <= 0) return; state.hIdx--; applySnapshot(state.history[state.hIdx]); updateUndoUI(); autosaveSoon(); }
function redo() { if (state.hIdx >= state.history.length - 1) return; state.hIdx++; applySnapshot(state.history[state.hIdx]); updateUndoUI(); autosaveSoon(); }
function updateUndoUI() { $('undoBtn').disabled = state.hIdx <= 0; $('redoBtn').disabled = state.hIdx >= state.history.length - 1; }

/* ---------------- autosave ---------------- */
const autosaveSoon = debounce(() => { autosave(); }, 1200);
let idbWorks = true;
async function autosave() {
  if (!idbWorks || !state.bytes || !state.fileName) return;
  try {
    await idbPut('last', {
      fileName: state.fileName, baseName: state.baseName, bytes: state.bytes,
      edits: state.edits, pageOps: state.pageOps, pageNum: state.pageNum,
      scale: state.scale, rotation: state.rotation, lastProps: state.lastProps, ts: Date.now()
    });
    $('saveStatus').textContent = 'บันทึกอัตโนมัติล่าสุด ' + fmtTime(Date.now());
  } catch (e) { idbWorks = false; $('saveStatus').textContent = 'บันทึกอัตโนมัติใช้ไม่ได้ (โหลด/บันทึกงานเป็นไฟล์แทน)'; }
}

/* ---------------- open / restore ---------------- */
async function openBytes(bytes, fileName, restore) {
  state.bytes = bytes;
  state.fileName = fileName;
  state.baseName = (fileName || 'document').replace(/\.pdf$/i, '');
  state.pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  state.pageCount = state.pdf.numPages;
  state.pageNum = state.pageNum && state.pageNum <= state.pageCount ? state.pageNum : 1;
  $('emptyState').hidden = true;
  $('canvasWrap').hidden = false;
  $('docControls').hidden = false;
  $('saveBtn').disabled = false;
  $('fileName').textContent = fileName || '';
  $('pageCount').textContent = state.pageCount;
  if (!restore) { state.edits = []; state.pageOps = { rotate: {}, deleted: [] }; state.selectedId = null; state.pending = null; state.pageNum = 1; state.rotation = 0; }
  initHistory();
  updatePagesList(); updateEditList();
  $('editPanel').hidden = true;
  await renderPage();
  autosaveSoon();
}

async function openFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('กรุณาเลือกไฟล์ .pdf'); return; }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name, false);
    toast('เปิดไฟล์แล้ว — ลาก/คลิกเพื่อเริ่มแก้ไข');
  } catch (e) { console.error(e); toast('เปิดไฟล์ไม่สำเร็จ: ' + e.message); }
}

async function checkRestore() {
  try {
    const s = await idbGet('last');
    if (s && s.bytes && s.fileName) {
      const n = (s.edits || []).length;
      $('restorePanel').hidden = false;
      $('restoreInfo').textContent = 'ไฟล์: ' + s.fileName + '\nการแก้ไข: ' + n + ' จุด • ' + fmtTime(s.ts);
      $('restoreBtn').onclick = async () => {
        try {
          Object.assign(state, {
            edits: s.edits || [], pageOps: s.pageOps || { rotate: {}, deleted: [] },
            pageNum: s.pageNum || 1, scale: s.scale || 1, rotation: s.rotation || 0,
            lastProps: s.lastProps || state.lastProps
          });
          await openBytes(s.bytes, s.fileName, true);
          $('restorePanel').hidden = true;
          toast('กู้คืนงานแล้ว');
        } catch (e) { toast('กู้คืนไม่สำเร็จ: ' + e.message); }
      };
      $('discardBtn').onclick = async () => {
        $('restorePanel').hidden = true;
        try { await idbDel('last'); } catch {}
      };
    }
  } catch (e) { idbWorks = false; }
}

/* ---------------- export ---------------- */
async function savePdf() {
  if (!state.bytes) return;
  const btn = $('saveBtn'); btn.disabled = true; btn.textContent = 'กำลังสร้าง…';
  try {
    const { PDFDocument, rgb, degrees } = state.pdfDocLib;
    const doc = await PDFDocument.load(state.bytes);
    doc.registerFontkit(window.fontkit);
    const font = await loadFont();

    // 1) หมุนหน้า (ตามเลขหน้าเดิม)
    const pages = doc.getPages();
    for (const k of Object.keys(state.pageOps.rotate)) {
      const n = parseInt(k, 10); if (!pages[n - 1]) continue;
      const cur = pages[n - 1].getRotation().angle || 0;
      pages[n - 1].setRotation(degrees(((cur + state.pageOps.rotate[k]) % 360 + 360) % 360));
    }

    // 2) วาดข้อความก่อน (ทุกหน้ายังอยู่ → ใช้เลขหน้าเดิมได้ตรง ไม่ติด stale cache ของ getPages หลัง removePage)
    let drawn = 0;
    for (const e of state.edits) {
      if (state.pageOps.deleted.includes(e.page)) continue;
      const pg = pages[e.page - 1];
      if (!pg || !e.text) continue;
      const fc = hexToRgb01(e.fillMode === 'custom' ? e.fillColor : '#ffffff');
      if (e.fillMode !== 'none') {
        pg.drawRectangle({ x: e.x, y: e.y, w: e.w, h: e.h, color: rgb(fc[0], fc[1], fc[2]) });
      }
      const size = fitSize(e.text, e.w, e.h, e.size);
      const tc = hexToRgb01(e.color);
      const lines = e.text.split('\n');
      let yy = e.y + e.h - PAD - size * 0.9;
      for (const line of lines) {
        let xx = e.x + PAD;
        const lw = line ? font.widthOfTextAtSize(line, size) : 0;
        if (e.align === 'center') xx = e.x + (e.w - lw) / 2;
        else if (e.align === 'right') xx = e.x + e.w - PAD - lw;
        if (line) pg.drawText(line, { x: xx, y: yy, size, font, color: rgb(tc[0], tc[1], tc[2]) });
        yy -= size * LINE_H;
      }
      drawn++;
    }

    // 3) ลบหน้า (จากมากไปน้อย) หลังวาดเสร็จ
    const dels = state.pageOps.deleted.slice().sort((a, b) => b - a);
    for (const n of dels) if (pages[n - 1]) doc.removePage(n - 1);

    const out = await doc.save();
    const blob = new Blob([out], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = state.baseName + '-edited.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('ดาวน์โหลดแล้ว: ' + drawn + ' การแก้ไข' + (dels.length ? ' • ลบ ' + dels.length + ' หน้า' : ''));
  } catch (e) {
    console.error(e); toast('สร้าง PDF ไม่สำเร็จ: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'ดาวน์โหลด PDF ใหม่';
  }
}

/* ---------------- session json ---------------- */
function exportSession() {
  if (!state.bytes) { toast('เปิดไฟล์ก่อนครับ'); return; }
  const o = {
    app: 'pdf-quick-edit', version: 2, fileName: state.fileName, baseName: state.baseName,
    pageNum: state.pageNum, scale: state.scale, rotation: state.rotation,
    edits: state.edits, pageOps: state.pageOps, lastProps: state.lastProps,
    pdfB64: bytesToB64(state.bytes)
  };
  const blob = new Blob([JSON.stringify(o)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = state.baseName + '-work.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('บันทึกงานเป็นไฟล์แล้ว');
}
async function importSession(file) {
  try {
    const o = JSON.parse(await file.text());
    if (!o.pdfB64) throw new Error('ไฟล์งานไม่ครบ');
    Object.assign(state, {
      edits: o.edits || [], pageOps: o.pageOps || { rotate: {}, deleted: [] },
      pageNum: o.pageNum || 1, scale: o.scale || 1, rotation: o.rotation || 0,
      lastProps: o.lastProps || state.lastProps, baseName: o.baseName || 'document'
    });
    await openBytes(b64ToBytes(o.pdfB64), o.fileName || 'document.pdf', true);
    toast('เปิดงานแล้ว');
  } catch (e) { toast('เปิดงานไม่สำเร็จ: ' + e.message); }
}

/* ---------------- controls / mode ---------------- */
function updateDocControls() {
  $('pageLabel').textContent = state.pageNum + '/' + state.pageCount;
  $('zoomLabel').textContent = Math.round(state.scale * 100) + '%';
}
function setMode(m, updateRadio) {
  state.mode = m;
  document.body.dataset.mode = m;
  if (updateRadio !== false) document.querySelectorAll('input[name="mode"]').forEach((r) => r.checked = r.value === m);
  const hints = {
    find: 'คลิกที่ข้อความบนหน้าเพื่อเลือกกล่อง แล้วพิมพ์ข้อความใหม่',
    draw: 'ลากเมาส์บนหน้าเพื่อวาดกรอบ แล้วพิมพ์ข้อความใหม่',
    edit: 'คลิกกล่องสีส้มเพื่อเลือก • ลากเพื่อย้าย • ลากจุดมุมเพื่อปรับขนาด'
  };
  $('modeHint').textContent = hints[m] || '';
  if (m !== 'find') $('searchInfo').textContent = '';
  renderWys(); renderOverlays();
}
function setScale(s) { state.scale = clamp(s, 0.25, 4); renderPage(); }
function fitWidth() { const vp = state.viewport; if (!vp) return; const target = $('viewer').clientWidth - 44; setScale(target / (vp.width / state.scale)); }
function fitPage() { const vp = state.viewport; if (!vp) return; const w = $('viewer').clientWidth - 44, h = $('viewer').clientHeight - 44; setScale(Math.min(w / (vp.width / state.scale), h / (vp.height / state.scale))); }
function goPage(n) { n = clamp(n, 1, state.pageCount); if (n === state.pageNum) return; state.pageNum = n; renderPage(); }

/* ---------------- search ---------------- */
function doSearch(q) {
  state.textItems.forEach((it) => it.el.classList.remove('hit'));
  const info = $('searchInfo');
  if (!q || q.length < 1) { info.textContent = ''; return; }
  const ql = q.toLowerCase();
  const hits = state.textItems.filter((it) => it.text.toLowerCase().includes(ql));
  hits.forEach((it) => it.el.classList.add('hit'));
  info.textContent = hits.length ? ('พบ ' + hits.length + ' จุดในหน้านี้ — คลิกที่ข้อความเพื่อแก้') : 'ไม่พบในหน้านี้ (ลองเปลี่ยนหน้า)';
}

/* ---------------- keyboard ---------------- */
function isTyping() { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); }
document.addEventListener('keydown', (ev) => {
  if (ev.ctrlKey || ev.metaKey) {
    if (ev.key === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); }
    else if (ev.key === 'y' || (ev.key === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); }
    else if (ev.key === 's') { ev.preventDefault(); savePdf(); }
    return;
  }
  if (isTyping()) return;
  if (ev.key === 'ArrowLeft') goPage(state.pageNum - 1);
  else if (ev.key === 'ArrowRight') goPage(state.pageNum + 1);
  else if (ev.key === '+' || ev.key === '=') setScale(state.scale * 1.2);
  else if (ev.key === '-') setScale(state.scale / 1.2);
  else if (ev.key.toLowerCase() === 'p') togglePreview();
});

function togglePreview() {
  document.body.classList.toggle('previewing');
  const on = document.body.classList.contains('previewing');
  $('previewBtn').textContent = on ? '👁 กำลังดูผลจริง' : '👁 ดูผลจริง';
}

/* ---------------- wiring ---------------- */
function wire() {
  $('openBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { openFile(e.target.files[0]); e.target.value = ''; };
  $('saveBtn').onclick = savePdf;

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => setMode(r.value)));

  $('searchInput').addEventListener('input', debounce((e) => doSearch(e.target.value.trim()), 180));

  $('prevPage').onclick = () => goPage(state.pageNum - 1);
  $('nextPage').onclick = () => goPage(state.pageNum + 1);
  $('zoomIn').onclick = () => setScale(state.scale * 1.2);
  $('zoomOut').onclick = () => setScale(state.scale / 1.2);
  $('fitWidth').onclick = fitWidth;
  $('fitPage').onclick = fitPage;
  $('viewRotate').onclick = () => { state.rotation = (state.rotation + 90) % 360; renderPage(); };
  $('undoBtn').onclick = undo;
  $('redoBtn').onclick = redo;
  $('previewBtn').onclick = togglePreview;

  // property panel
  $('newText').addEventListener('input', () => { applyProps({ text: $('newText').value }); });
  $('sizeAuto').addEventListener('change', () => {
    $('sizeRow').hidden = $('sizeAuto').checked;
    if ($('sizeAuto').checked) applyProps({ size: null });
    else applyProps({ size: parseFloat($('sizeNum').value) || 12 });
    openPanelForTarget();
  });
  const onSize = (v) => { const s = clamp(parseFloat(v) || 12, 4, 72); $('sizeRange').value = s; $('sizeNum').value = s; applyProps({ size: s }); };
  $('sizeRange').addEventListener('input', (e) => onSize(e.target.value));
  $('sizeNum').addEventListener('input', (e) => onSize(e.target.value));
  document.querySelectorAll('#alignSeg button').forEach((b) => b.addEventListener('click', () => { setAlignUI(b.dataset.align); applyProps({ align: b.dataset.align }); }));
  $('textColor').addEventListener('input', (e) => applyProps({ color: e.target.value }));
  $('fillMode').addEventListener('change', (e) => { $('fillColor').hidden = e.target.value !== 'custom'; applyProps({ fillMode: e.target.value }); });
  $('fillColor').addEventListener('input', (e) => applyProps({ fillColor: e.target.value }));
  $('addEditBtn').onclick = addEdit;
  $('cancelSelBtn').onclick = () => { state.pending = null; state.selectedId = null; $('editPanel').hidden = true; renderWys(); renderOverlays(); updateEditList(); };
  $('deleteEditBtn').onclick = () => { if (state.selectedId) deleteEdit(state.selectedId); };
  $('dupEditBtn').onclick = () => { if (state.selectedId) duplicateEdit(state.selectedId); };

  // session
  $('exportSessionBtn').onclick = exportSession;
  $('importSessionBtn').onclick = () => $('sessionInput').click();
  $('sessionInput').onchange = (e) => { if (e.target.files[0]) importSession(e.target.files[0]); e.target.value = ''; };

  // drag & drop
  const viewer = $('viewer');
  ['dragenter', 'dragover'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((t) => viewer.addEventListener(t, (e) => { e.preventDefault(); viewer.classList.remove('dragover'); }));
  viewer.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });

  setupDraw();
  setupEditInteractions();
}

/* ---------------- init ---------------- */
(async function init() {
  state.pdfDocLib = PDFLib;
  injectFontFace();
  wire();
  setMode('find');
  checkRestore();
})();

'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

const $ = (id) => document.getElementById(id);

const state = {
  pdfjsDoc: null,
  originalBytes: null,
  fontBytes: null,
  fileName: '',
  pageNum: 1,
  scale: 1.25,
  rotation: 0,
  mode: 'find',
  edits: [],
  pending: null,
  textItems: [],
  renderTask: null,
  idSeq: 1,
};

const canvas = $('pdfCanvas');
const ctx = canvas.getContext('2d');
const canvasWrap = $('canvasWrap');
const textLayer = $('textLayer');
const drawLayer = $('drawLayer');
const editOverlay = $('editOverlay');
let viewportNow = null;

/* ================= font ================= */

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function loadFont() {
  if (state.fontBytes) return state.fontBytes;
  // ฝัง base64 มาใน lib/sarabun-font.js — ใช้ไฟล์นี้เป็นหลักเพราะ
  // เปิดแบบดับเบิลคลิก (file://) เบราว์เซอร์ห้าม fetch() ไฟล์ในเครื่อง
  if (typeof SARABUN_B64 === 'string' && SARABUN_B64.length > 0) {
    state.fontBytes = b64ToArrayBuffer(SARABUN_B64);
    return state.fontBytes;
  }
  const res = await fetch('lib/Sarabun-Regular.ttf');
  if (!res.ok) throw new Error('โหลดฟอนต์ Sarabun ไม่สำเร็จ');
  state.fontBytes = await res.arrayBuffer();
  return state.fontBytes;
}

/* ================= file open ================= */

async function openFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.pdf')) {
    alert('กรุณาเลือกไฟล์ PDF เท่านั้น');
    return;
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: buf.slice() }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      alert('ไฟล์นี้มีรหัสผ่านป้องกัน — เปิดด้วยโปรแกรมอื่นก่อน แล้วลองใหม่');
    } else {
      alert('เปิดไฟล์ไม่สำเร็จ: ' + (err && err.message ? err.message : err));
    }
    return;
  }
  state.pdfjsDoc = doc;
  state.originalBytes = buf;
  state.fileName = file.name;
  state.pageNum = 1;
  state.rotation = 0;
  state.scale = 1.25;
  state.edits = [];
  state.pending = null;
  $('emptyState').hidden = true;
  canvasWrap.hidden = false;
  $('docControls').hidden = false;
  $('fileName').textContent = file.name;
  $('newText').value = '';
  loadFont().catch((e) => console.warn(e));
  updateEditList();
  updatePendingUI();
  await renderPage();
}

/* ================= render ================= */

async function renderPage() {
  if (!state.pdfjsDoc) return;
  if (state.renderTask) {
    try { state.renderTask.cancel(); } catch (_) {}
    state.renderTask = null;
  }
  const page = await state.pdfjsDoc.getPage(state.pageNum);
  const viewport = page.getViewport({ scale: state.scale, rotation: state.rotation });
  viewportNow = viewport;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasWrap.style.width = viewport.width + 'px';
  canvasWrap.style.height = viewport.height + 'px';

  const task = page.render({ canvasContext: ctx, viewport });
  state.renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    if (e && e.name === 'RenderingCancelledException') return;
    console.error(e);
  }
  state.renderTask = null;

  await buildTextLayer(page, viewport);
  refreshOverlays();
  updatePageLabel();
  runSearch();
}

async function buildTextLayer(page, viewport) {
  textLayer.innerHTML = '';
  state.textItems = [];
  const tc = await page.getTextContent();
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const tr = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontH = Math.hypot(tr[2], tr[3]);
    if (!(fontH > 1)) continue;
    const left = tr[4];
    const top = tr[5] - fontH;
    const w = Math.max(item.width * viewport.scale, 2);
    const h = fontH;
    const div = document.createElement('div');
    div.className = 'tl-item';
    div.style.left = left + 'px';
    div.style.top = top + 'px';
    div.style.width = w + 'px';
    div.style.height = h + 'px';
    div.textContent = item.str;
    div.title = item.str;
    div.addEventListener('click', (ev) => {
      if (state.mode !== 'find') return;
      ev.stopPropagation();
      selectScreenRect(left, top, w, h, page.pageNumber);
    });
    textLayer.appendChild(div);
    state.textItems.push({ div, str: item.str, page: page.pageNumber });
  }
}

/* ================= page / zoom / rotate ================= */

function updatePageLabel() {
  $('pageLabel').textContent = state.pageNum + '/' + (state.pdfjsDoc ? state.pdfjsDoc.numPages : '–');
  $('zoomLabel').textContent = Math.round(state.scale * 100) + '%';
}

async function gotoPage(n) {
  if (!state.pdfjsDoc) return;
  state.pageNum = Math.min(Math.max(1, n), state.pdfjsDoc.numPages);
  await renderPage();
}

/* ================= search ================= */

function runSearch() {
  const q = $('searchInput').value.trim().toLowerCase();
  let n = 0;
  for (const it of state.textItems) {
    const hit = q !== '' && it.str.toLowerCase().includes(q);
    it.div.classList.toggle('hit', hit);
    if (hit) n++;
  }
  const info = $('searchInfo');
  if (!q) { info.textContent = ''; return; }
  info.textContent = n
    ? 'พบ ' + n + ' รายการในหน้านี้ — คลิกที่ข้อความไฮไลต์เพื่อเลือกแก้'
    : 'ไม่พบในหน้านี้ (ค้นเฉพาะหน้าที่เปิดอยู่)';
}

/* ================= selection ================= */

function selectScreenRect(left, top, w, h, pageNumber) {
  if (!viewportNow) return;
  const [x1, y1] = viewportNow.convertToPdfPoint(left, top);
  const [x2, y2] = viewportNow.convertToPdfPoint(left + w, top + h);
  state.pending = {
    page: pageNumber,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
  refreshOverlays();
  updatePendingUI();
  $('newText').focus();
}

function updatePendingUI() {
  const info = $('selectionInfo');
  const add = $('addEditBtn');
  if (state.pending) {
    info.textContent =
      'เลือกแล้ว: หน้า ' + state.pending.page +
      ' — กว้าง ' + state.pending.w.toFixed(0) + ' × สูง ' + state.pending.h.toFixed(0) + ' pt' +
      ' — พิมพ์ข้อความใหม่ด้านล่าง แล้วกด "เพิ่มการแก้ไข"';
    add.disabled = $('newText').value.trim() === '';
  } else {
    info.textContent = state.mode === 'draw'
      ? 'ลากเมาส์บนหน้าเพื่อวาดกรอบบริเวณที่ต้องการแก้'
      : 'คลิกบนข้อความในเอกสาร หรือค้นหาจากช่องด้านบนแล้วเลือกผลลัพธ์';
    add.disabled = true;
  }
}

/* ================= draw mode ================= */

let drawing = null;

drawLayer.addEventListener('pointerdown', (e) => {
  if (state.mode !== 'draw' || !viewportNow) return;
  drawLayer.setPointerCapture(e.pointerId);
  const r = canvasWrap.getBoundingClientRect();
  drawing = { x: e.clientX - r.left, y: e.clientY - r.top, w: 0, h: 0 };
  const div = document.createElement('div');
  div.className = 'draw-rect';
  div.id = 'liveDraw';
  editOverlay.appendChild(div);
  updateLiveDraw();
});

drawLayer.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const r = canvasWrap.getBoundingClientRect();
  drawing.w = (e.clientX - r.left) - drawing.x;
  drawing.h = (e.clientY - r.top) - drawing.y;
  updateLiveDraw();
});

drawLayer.addEventListener('pointerup', () => {
  if (!drawing) return;
  const d = drawing;
  drawing = null;
  const live = $('liveDraw');
  if (live) live.remove();
  const left = d.w >= 0 ? d.x : d.x + d.w;
  const top = d.h >= 0 ? d.y : d.y + d.h;
  const w = Math.abs(d.w);
  const h = Math.abs(d.h);
  if (w < 6 || h < 6) return;
  selectScreenRect(left, top, w, h, state.pageNum);
});

function updateLiveDraw() {
  const div = $('liveDraw');
  if (!div || !drawing) return;
  const left = drawing.w >= 0 ? drawing.x : drawing.x + drawing.w;
  const top = drawing.h >= 0 ? drawing.y : drawing.y + drawing.h;
  div.style.left = left + 'px';
  div.style.top = top + 'px';
  div.style.width = Math.abs(drawing.w) + 'px';
  div.style.height = Math.abs(drawing.h) + 'px';
}

/* ================= overlays ================= */

function pdfRectToScreen(r) {
  if (!viewportNow) return null;
  const [vx, vy] = viewportNow.convertToViewportPoint(r.x, r.y + r.h);
  const [vx2, vy2] = viewportNow.convertToViewportPoint(r.x + r.w, r.y);
  return {
    left: Math.min(vx, vx2),
    top: Math.min(vy, vy2),
    w: Math.abs(vx2 - vx),
    h: Math.abs(vy2 - vy),
  };
}

function refreshOverlays() {
  editOverlay.innerHTML = '';
  if (!viewportNow) return;
  state.edits
    .filter((e) => e.page === state.pageNum)
    .forEach((e, i) => {
      const s = pdfRectToScreen(e);
      if (!s) return;
      const d = document.createElement('div');
      d.className = 'edit-rect';
      d.style.left = s.left + 'px';
      d.style.top = s.top + 'px';
      d.style.width = s.w + 'px';
      d.style.height = s.h + 'px';
      d.textContent = String(i + 1);
      editOverlay.appendChild(d);
    });
  if (state.pending && state.pending.page === state.pageNum) {
    const s = pdfRectToScreen(state.pending);
    if (s) {
      const d = document.createElement('div');
      d.className = 'pending-rect';
      d.style.left = s.left + 'px';
      d.style.top = s.top + 'px';
      d.style.width = s.w + 'px';
      d.style.height = s.h + 'px';
      editOverlay.appendChild(d);
    }
  }
}

/* ================= edits list ================= */

function updateEditList() {
  const ul = $('editList');
  ul.innerHTML = '';
  $('editCount').textContent = state.edits.length;
  $('saveBtn').disabled = state.edits.length === 0;
  state.edits.forEach((e, idx) => {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'edit-label';
    const short = e.text.length > 32 ? e.text.slice(0, 32) + '…' : e.text;
    label.textContent = '#' + (idx + 1) + ' หน้า ' + e.page + ': «' + short.replace(/\n/g, ' ') + '»';
    label.title = 'คลิกเพื่อไปที่หน้านี้';
    label.addEventListener('click', () => gotoPage(e.page));
    const del = document.createElement('button');
    del.className = 'btn small';
    del.textContent = 'ลบ';
    del.addEventListener('click', () => {
      state.edits.splice(idx, 1);
      updateEditList();
      refreshOverlays();
    });
    li.append(label, del);
    ul.appendChild(li);
  });
}

function addEdit() {
  const text = $('newText').value;
  if (!state.pending || !text.trim()) return;
  state.edits.push({
    id: state.idSeq++,
    page: state.pending.page,
    x: state.pending.x,
    y: state.pending.y,
    w: state.pending.w,
    h: state.pending.h,
    text: text.replace(/\r\n/g, '\n'),
  });
  state.pending = null;
  $('newText').value = '';
  updateEditList();
  updatePendingUI();
  refreshOverlays();
}

/* ================= save (pdf-lib) ================= */

async function savePdf() {
  if (!state.originalBytes || state.edits.length === 0) return;
  const btn = $('saveBtn');
  btn.disabled = true;
  btn.textContent = 'กำลังสร้างไฟล์…';
  try {
    await loadFont();
    const doc = await PDFLib.PDFDocument.load(state.originalBytes);
    if (typeof fontkit !== 'undefined') doc.registerFontkit(fontkit);
    const font = await doc.embedFont(state.fontBytes);
    const { rgb } = PDFLib;
    for (const e of state.edits) {
      const page = doc.getPage(e.page - 1);
      page.drawRectangle({
        x: e.x,
        y: e.y,
        width: e.w,
        height: e.h,
        color: rgb(1, 1, 1),
      });
      drawFittedText(page, e, font, rgb(0, 0, 0));
    }
    const out = await doc.save();
    downloadBytes(out, makeOutName(state.fileName));
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    if (msg.indexOf('encrypted') !== -1) {
      msg = 'ไฟล์มีการเข้ารหัส — เปิดบันทึกใหม่แบบไม่มีรหัสผ่านก่อน';
    }
    alert('สร้างไฟล์ไม่สำเร็จ: ' + msg);
  } finally {
    btn.textContent = 'ดาวน์โหลด PDF ใหม่';
    btn.disabled = state.edits.length === 0;
  }
}

function drawFittedText(page, e, font, color) {
  const pad = 2;
  const maxW = Math.max(e.w - pad * 2, 4);
  const maxH = Math.max(e.h - pad * 2, 4);
  const lines = e.text.split('\n');
  let size = Math.min(maxH, 26);
  while (size > 4) {
    let widthOk = true;
    for (const l of lines) {
      if (!l) continue;
      if (font.widthOfTextAtSize(l, size) > maxW) { widthOk = false; break; }
    }
    const heightOk = lines.length * size * 1.3 <= maxH + size * 0.4;
    if (widthOk && heightOk) break;
    size -= 0.5;
  }
  const lh = size * 1.3;
  let y = e.y + e.h - pad - size * 0.9;
  for (const l of lines) {
    if (l) {
      page.drawText(l, { x: e.x + pad, y: Math.max(y, e.y + pad), size, font, color });
    }
    y -= lh;
  }
}

function downloadBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

function makeOutName(name) {
  const i = name.lastIndexOf('.');
  return (i > 0 ? name.slice(0, i) : name) + '-edited.pdf';
}

/* ================= wiring ================= */

$('openBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});

$('prevPage').addEventListener('click', () => gotoPage(state.pageNum - 1));
$('nextPage').addEventListener('click', () => gotoPage(state.pageNum + 1));

$('zoomIn').addEventListener('click', async () => {
  state.scale = Math.min(state.scale * 1.25, 5);
  await renderPage();
});
$('zoomOut').addEventListener('click', async () => {
  state.scale = Math.max(state.scale / 1.25, 0.4);
  await renderPage();
});
$('rotateBtn').addEventListener('click', async () => {
  state.rotation = (state.rotation + 90) % 360;
  await renderPage();
});

let searchTimer = null;
$('searchInput').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

$('newText').addEventListener('input', updatePendingUI);
$('addEditBtn').addEventListener('click', addEdit);
$('cancelSelBtn').addEventListener('click', () => {
  state.pending = null;
  refreshOverlays();
  updatePendingUI();
});

$('saveBtn').addEventListener('click', savePdf);

document.querySelectorAll('input[name="mode"]').forEach((r) => {
  r.addEventListener('change', () => {
    state.mode = r.value;
    document.body.dataset.mode = r.value;
    $('modeHint').textContent = r.value === 'find'
      ? 'คลิกบนข้อความใดก็ได้ในเอกสาร หรือค้นหาด้วยคำ แล้วพิมพ์ข้อความใหม่เพื่อวางทับ — เหมาะกับ PDF ที่คัดลอกข้อความได้'
      : 'ลากเมาส์เป็นสี่เหลี่ยมบนหน้าเพื่อกำหนดพื้นที่ใหม่ — ใช้ได้กับ PDF ทุกชนิด รวมไฟล์สแกน/ตัวอักษรเพี้ยน';
    updatePendingUI();
  });
});

const viewer = $('viewer');
viewer.addEventListener('dragover', (e) => {
  e.preventDefault();
  viewer.classList.add('dragover');
});
viewer.addEventListener('dragleave', () => viewer.classList.remove('dragover'));
viewer.addEventListener('drop', (e) => {
  e.preventDefault();
  viewer.classList.remove('dragover');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

window.addEventListener('keydown', (e) => {
  if (!state.pdfjsDoc) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown') gotoPage(state.pageNum + 1);
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') gotoPage(state.pageNum - 1);
});

/* init */
$('modeHint').textContent =
  'คลิกบนข้อความใดก็ได้ในเอกสาร หรือค้นหาด้วยคำ แล้วพิมพ์ข้อความใหม่เพื่อวางทับ — เหมาะกับ PDF ที่คัดลอกข้อความได้';
updatePendingUI();

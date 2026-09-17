// --- 🎨 まとめて色変更モード（キーボード: C） ---
// 2026-09-17 Tench要望「一気にいくつものピンの色を変更できるようにしたい」
//
// 使い方: バナーで色を選ぶ → ①ピンを投げ縄で囲む ＝ 囲んだ全ピンがその色に
//                           ②ピン/団子をタップ   ＝ その1本（団子なら同じ座標の全ピン）がその色に
// どちらも「その場で適用・保存」。1操作＝1回の pushUndo なので ↩ で1操作ずつ戻せる。
// 続けて何か所でも塗れる（Enter/Esc/C で終了）。投げ縄は gather.js と同型。
// 実際に色を書き換える処理は core.js の applyColorToPins()（団子一覧のパレットと共通）。
let bulkColorMode = false;
let bulkColorValue = '#9c27b0';   // 既定=紫（集合住宅）。'' は色なし
let bulkColorPoints = [];
let bulkColorLine = null;
let bulkColorActive = false;
let bulkColorDoneCount = 0;

function toggleBulkColorMode() {
  if (bulkColorMode) { finishBulkColor(); return; }
  if (pins.length === 0) { showToast('ピンがありません'); return; }
  exitAllOtherModes('bulkColor');
  bulkColorMode = true;
  pinMode = false;
  bulkColorPoints = [];
  bulkColorActive = false;
  bulkColorDoneCount = 0;

  const btn = document.getElementById('btn-bulk-color');
  if (btn) { btn.classList.add('active'); btn.textContent = '🎨 色変更中...'; }
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('bulk-color-banner').classList.add('show');
  document.getElementById('bulk-color-count').textContent = '0';
  renderBulkColorSwatches();

  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', bulkColorStart);
  map.on('mousemove', bulkColorMove);
  map.on('mouseup', bulkColorEnd);
  map.on('touchstart', bulkColorTouchStart);
  map.on('touchmove', bulkColorTouchMove);
  map.on('touchend', bulkColorEnd);

  refreshAllMarkers();
  bulkColorDisableMarkerDrag();
  showToast('🎨 色を選んで、ピンを囲むかタップしてください');
}

function renderBulkColorSwatches() {
  const box = document.getElementById('bulk-color-swatches');
  if (!box) return;
  box.innerHTML = '';
  pinColorPresets.forEach((c, i) => {
    const val = i === 0 ? '' : c.toLowerCase();          // 先頭(既定の青)は「色なし」
    const name = (window.getLegendLabel && val) ? window.getLegendLabel(val) : '';
    const dot = document.createElement('span');
    dot.className = 'bulk-swatch' + (val === bulkColorValue ? ' active' : '');
    dot.style.background = c;
    dot.title = val ? (name ? `${name}（${val}）` : val) : '色なし（既定の青）';
    if (!val) dot.textContent = '×';
    dot.addEventListener('click', ev => {
      ev.stopPropagation();
      bulkColorValue = val;
      renderBulkColorSwatches();
    });
    box.appendChild(dot);
  });
  const lab = document.getElementById('bulk-color-name');
  if (lab) {
    const nm = bulkColorValue ? ((window.getLegendLabel && window.getLegendLabel(bulkColorValue)) || bulkColorValue) : '色なし';
    lab.textContent = nm;
  }
}

function bulkColorDisableMarkerDrag() {
  for (const id in markers) {
    const m = markers[id];
    if (m && m.dragging) m.dragging.disable();
  }
}

function bulkColorStart(e) {
  if (!bulkColorMode) return;
  bulkColorActive = true;
  bulkColorPoints = [e.latlng];
  if (bulkColorLine) { map.removeLayer(bulkColorLine); bulkColorLine = null; }
}
function bulkColorTouchStart(e) {
  if (!bulkColorMode || !e.originalEvent.touches.length) return;
  const t = e.originalEvent.touches[0];
  bulkColorActive = true;
  bulkColorPoints = [map.containerPointToLatLng(L.point(t.clientX, t.clientY))];
  if (bulkColorLine) { map.removeLayer(bulkColorLine); bulkColorLine = null; }
}
function bulkColorDraw() {
  if (bulkColorLine) bulkColorLine.setLatLngs(bulkColorPoints);
  else bulkColorLine = L.polyline(bulkColorPoints, { color: '#AD1457', weight: 2, dashArray: '5 5' }).addTo(map);
}
function bulkColorMove(e) {
  if (!bulkColorActive) return;
  bulkColorPoints.push(e.latlng);
  bulkColorDraw();
}
function bulkColorTouchMove(e) {
  if (!bulkColorActive || !e.originalEvent.touches.length) return;
  e.originalEvent.preventDefault();
  const t = e.originalEvent.touches[0];
  bulkColorPoints.push(map.containerPointToLatLng(L.point(t.clientX, t.clientY)));
  bulkColorDraw();
}
function bulkColorEnd() {
  if (!bulkColorActive) return;
  bulkColorActive = false;
  const pts = bulkColorPoints;
  bulkColorPoints = [];
  if (bulkColorLine) { map.removeLayer(bulkColorLine); bulkColorLine = null; }
  if (pts.length < 3) return;
  const polygon = pts.map(p => [p.lat, p.lng]);
  const selected = pins.filter(pin => pointInPolygon([pin.lat, pin.lng], polygon));
  if (!selected.length) { showToast('囲みの中にピンがありません'); return; }
  bulkColorApply(selected);
}

// ピン（マーカー）をタップ: 同じ座標の全ピン＝団子ごと塗る。core.js の click ハンドラから呼ばれる
function bulkColorTap(pin) {
  const same = pins.filter(p => p.lat === pin.lat && p.lng === pin.lng);
  bulkColorApply(same.length ? same : [pin]);
}

function bulkColorApply(list) {
  const changed = applyColorToPins(list, bulkColorValue);   // core.js（pushUndo/保存/再描画/凡例更新まで）
  bulkColorDisableMarkerDrag();                             // 再描画でドラッグが復活するので無効化し直す
  const nm = bulkColorValue ? ((window.getLegendLabel && window.getLegendLabel(bulkColorValue)) || bulkColorValue) : '色なし';
  if (!changed) { showToast(`${list.length}本はもう「${nm}」です`); return; }
  bulkColorDoneCount++;
  document.getElementById('bulk-color-count').textContent = bulkColorDoneCount;
  showToast(`🎨 ${changed}本を「${nm}」にしました（続けて塗れます・↩で戻せます）`);
}

function finishBulkColor() {
  const n = bulkColorDoneCount;
  exitBulkColor();
  refreshAllMarkers();
  updatePinCount();
  showToast(n ? `まとめて色変更 を終了（${n}回塗りました）` : 'まとめて色変更 を終了');
}

function exitBulkColor() {
  bulkColorMode = false;
  bulkColorPoints = [];
  bulkColorActive = false;
  bulkColorDoneCount = 0;
  if (bulkColorLine) { map.removeLayer(bulkColorLine); bulkColorLine = null; }
  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', bulkColorStart);
  map.off('mousemove', bulkColorMove);
  map.off('mouseup', bulkColorEnd);
  map.off('touchstart', bulkColorTouchStart);
  map.off('touchmove', bulkColorTouchMove);
  map.off('touchend', bulkColorEnd);
  const btn = document.getElementById('btn-bulk-color');
  if (btn) { btn.classList.remove('active'); btn.textContent = '🎨 まとめて色変更'; }
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('bulk-color-banner').classList.remove('show');
}

// --- ⌨ C = 開始/終了、モード中は Enter/Esc でも終了（作法は G と同じ）---
(function () {
  function overlayOpen() {
    return ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal', 'legend-modal', 'submit-modal']
      .some(function (id) { var el = document.getElementById(id); return el && el.classList.contains('show'); });
  }
  document.addEventListener('keydown', function (e) {
    if (kbIsTyping(e) || overlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const isC = (k === 'c' || k === 'C');
    if (!bulkColorMode) {
      if (!isC) return;
      e.preventDefault();
      const busy = typeof activeModeName === 'function' ? activeModeName('bulkColor') : null;
      if (busy) {
        showToast(`「${(typeof MODE_LABELS !== 'undefined' && MODE_LABELS[busy]) || busy}」モード中です。先に終了してください`);
        return;
      }
      toggleBulkColorMode();
      return;
    }
    if (isC || k === 'Enter' || k === 'Escape') {
      e.preventDefault();
      finishBulkColor();
    }
  });
})();

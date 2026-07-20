// --- 🖐 まとめて移動モード ---
// 投げ縄で囲む/タップで選択した複数ピンを、✥ハンドルのドラッグで相対位置を保ったまま一括移動する。
// 投げ縄はlasso-delete.jsと同型（pointInPolygonはgroups.jsの関数を使用）。
// Undoはモード中の最初のドラッグで1回だけ積む＝「移動を取消」で開始前へ一括で戻せる。
let multiMoveMode = false;
let mmSelected = [];
let mmPoints = [];
let mmLine = null;
let mmActive = false;
let mmHandle = null;
let mmUndoPushed = false;

function toggleMultiMove() {
  if (multiMoveMode) {
    finishMultiMove();
    return;
  }
  if (pins.length === 0) {
    showToast('ピンがありません');
    return;
  }
  exitAllOtherModes('multiMove');
  multiMoveMode = true;
  pinMode = false;
  mmSelected = [];
  mmPoints = [];
  mmUndoPushed = false;

  document.getElementById('btn-multi-move').classList.add('active');
  document.getElementById('btn-multi-move').textContent = '🖐 移動中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('multi-move-banner').classList.add('show');
  document.getElementById('multi-move-count').textContent = '0';

  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', mmStart);
  map.on('mousemove', mmMove);
  map.on('mouseup', mmEnd);
  map.on('touchstart', mmTouchStart);
  map.on('touchmove', mmTouchMove);
  map.on('touchend', mmEnd);

  showToast('動かしたいピンを囲むかタップで選択してください');
}

function mmStart(e) {
  if (!multiMoveMode) return;
  mmActive = true;
  mmPoints = [e.latlng];
  if (mmLine) { map.removeLayer(mmLine); mmLine = null; }
}

function mmTouchStart(e) {
  if (!multiMoveMode || !e.originalEvent.touches.length) return;
  const t = e.originalEvent.touches[0];
  mmActive = true;
  mmPoints = [map.containerPointToLatLng(L.point(t.clientX, t.clientY))];
  if (mmLine) { map.removeLayer(mmLine); mmLine = null; }
}

function mmMove(e) {
  if (!mmActive) return;
  mmPoints.push(e.latlng);
  if (mmLine) mmLine.setLatLngs(mmPoints);
  else mmLine = L.polyline(mmPoints, { color: '#00897B', weight: 2, dashArray: '5 5' }).addTo(map);
}

function mmTouchMove(e) {
  if (!mmActive || !e.originalEvent.touches.length) return;
  e.originalEvent.preventDefault();
  const t = e.originalEvent.touches[0];
  mmPoints.push(map.containerPointToLatLng(L.point(t.clientX, t.clientY)));
  if (mmLine) mmLine.setLatLngs(mmPoints);
  else mmLine = L.polyline(mmPoints, { color: '#00897B', weight: 2, dashArray: '5 5' }).addTo(map);
}

function mmEnd() {
  if (!mmActive) return;
  mmActive = false;
  if (mmPoints.length < 3) {
    if (mmLine) { map.removeLayer(mmLine); mmLine = null; }
    return;
  }
  const polygon = mmPoints.map(p => [p.lat, p.lng]);
  pins.forEach(pin => {
    if (pointInPolygon([pin.lat, pin.lng], polygon)) {
      if (!mmSelected.find(p => p.id === pin.id)) mmSelected.push(pin);
    }
  });
  if (mmLine) { map.removeLayer(mmLine); mmLine = null; }
  mmUpdateUI();
  if (mmSelected.length > 0) {
    showToast(`${mmSelected.length}件選択。✥ハンドルをドラッグで一括移動`);
  }
}

// タップで個別に選択/解除（ハイライトマーカーとcore.jsのクリック分岐の両方から呼ばれる）
function handleMultiMoveTap(pinId) {
  const idx = mmSelected.findIndex(p => p.id === pinId);
  if (idx !== -1) mmSelected.splice(idx, 1);
  else {
    const pin = pins.find(p => p.id === pinId);
    if (pin) mmSelected.push(pin);
  }
  mmUpdateUI();
}

function mmUpdateUI() {
  document.getElementById('multi-move-count').textContent = mmSelected.length;
  mmHighlight();
  mmRefreshHandle();
}

function mmHighlight() {
  for (const id in markers) map.removeLayer(markers[id]);
  markers = {};
  const sz = getPinSize();
  const sel = new Set(mmSelected.map(p => p.id));
  pins.forEach((pin, i) => {
    const s = sel.has(pin.id);
    const num = getLabelNum(pin.label) ?? (i + 1);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon" style="background:${s ? '#00897B' : '#9E9E9E'};position:relative;${s ? '' : 'opacity:0.55;'}">${num}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz / 2, sz / 2]
    });
    const m = L.marker([pin.lat, pin.lng], { icon }).addTo(map);
    m.on('click', function (e) {
      L.DomEvent.stopPropagation(e);
      handleMultiMoveTap(pin.id);
    });
    markers[pin.id] = m;
  });
}

// 選択群の重心に✥移動ハンドルを配置。ドラッグ中は選択ピン全部を同オフセットで追従
function mmRefreshHandle() {
  if (mmHandle) { map.removeLayer(mmHandle); mmHandle = null; }
  if (!mmSelected.length) return;
  const cLat = mmSelected.reduce((a, p) => a + p.lat, 0) / mmSelected.length;
  const cLng = mmSelected.reduce((a, p) => a + p.lng, 0) / mmSelected.length;
  mmHandle = L.marker([cLat, cLng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:34px;height:34px;background:rgba(0,137,123,0.92);border:3px solid white;border-radius:50%;cursor:move;box-shadow:0 2px 8px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;font-size:17px;color:white;line-height:1;">✥</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17]
    }),
    draggable: true,
    zIndexOffset: 2000
  }).addTo(map);

  let prev = null;
  mmHandle.on('dragstart', function (e) {
    if (!mmUndoPushed) { pushUndo(); mmUndoPushed = true; }
    prev = e.target.getLatLng();
  });
  mmHandle.on('drag', function (e) {
    const pos = e.target.getLatLng();
    const dLat = pos.lat - prev.lat;
    const dLng = pos.lng - prev.lng;
    prev = pos;
    mmSelected.forEach(pin => {
      pin.lat += dLat;
      pin.lng += dLng;
      if (markers[pin.id]) markers[pin.id].setLatLng([pin.lat, pin.lng]);
    });
  });
  mmHandle.on('dragend', function () {
    saveToStorage();
    showToast(`${mmSelected.length}件を移動しました（続けて微調整できます）`);
  });
}

// 完了: 移動を確定して終了（移動はdragendごとに保存済み）
function finishMultiMove() {
  exitMultiMove();
  refreshAllMarkers();
  updatePinCount();
  showToast('まとめて移動を終了しました');
}

// 取消: モード中の移動を全部戻して終了
function cancelMultiMove() {
  const hadMove = mmUndoPushed;
  exitMultiMove();
  if (hadMove) {
    performUndo(); // マーカー再構築・保存・トーストはperformUndo内で行われる
  } else {
    refreshAllMarkers();
  }
}

function exitMultiMove() {
  multiMoveMode = false;
  mmSelected = [];
  mmPoints = [];
  mmActive = false;
  mmUndoPushed = false;
  if (mmLine) { map.removeLayer(mmLine); mmLine = null; }
  if (mmHandle) { map.removeLayer(mmHandle); mmHandle = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', mmStart);
  map.off('mousemove', mmMove);
  map.off('mouseup', mmEnd);
  map.off('touchstart', mmTouchStart);
  map.off('touchmove', mmTouchMove);
  map.off('touchend', mmEnd);

  document.getElementById('btn-multi-move').classList.remove('active');
  document.getElementById('btn-multi-move').textContent = '🖐 まとめて移動';
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('multi-move-banner').classList.remove('show');
}

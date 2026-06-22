// --- 範囲削除モード ---
let lassoDeleteMode = false;
let lassoDeleteSelected = [];
let lassoDeletePoints = [];
let lassoDeleteLine = null;
let lassoDeleteActive = false;

function toggleLassoDeleteMode() {
  if (lassoDeleteMode) {
    cancelLassoDeleteMode();
    return;
  }
  if (pins.length === 0) {
    showToast('ピンがありません');
    return;
  }
  exitAllOtherModes('lassoDelete');
  lassoDeleteMode = true;
  pinMode = false;
  lassoDeleteSelected = [];
  lassoDeletePoints = [];

  document.getElementById('btn-lasso-delete').classList.add('active');
  document.getElementById('btn-lasso-delete').textContent = '🗑️ 選択中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('lasso-delete-banner').classList.add('show');
  document.getElementById('lasso-delete-count').textContent = '0';

  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', lassoDeleteStart);
  map.on('mousemove', lassoDeleteMove);
  map.on('mouseup', lassoDeleteEnd);
  map.on('touchstart', lassoDeleteTouchStart);
  map.on('touchmove', lassoDeleteTouchMove);
  map.on('touchend', lassoDeleteEnd);

  showToast('マウスドラッグで削除するピンを囲んでください');
}

function lassoDeleteStart(e) {
  if (!lassoDeleteMode) return;
  lassoDeleteActive = true;
  lassoDeletePoints = [e.latlng];
  if (lassoDeleteLine) { map.removeLayer(lassoDeleteLine); lassoDeleteLine = null; }
}

function lassoDeleteTouchStart(e) {
  if (!lassoDeleteMode || !e.originalEvent.touches.length) return;
  const touch = e.originalEvent.touches[0];
  const latlng = map.containerPointToLatLng(L.point(touch.clientX, touch.clientY));
  lassoDeleteActive = true;
  lassoDeletePoints = [latlng];
  if (lassoDeleteLine) { map.removeLayer(lassoDeleteLine); lassoDeleteLine = null; }
}

function lassoDeleteMove(e) {
  if (!lassoDeleteActive) return;
  lassoDeletePoints.push(e.latlng);
  if (lassoDeleteLine) map.removeLayer(lassoDeleteLine);
  lassoDeleteLine = L.polyline(lassoDeletePoints, { color: '#f44336', weight: 2, dashArray: '5 5' }).addTo(map);
}

function lassoDeleteTouchMove(e) {
  if (!lassoDeleteActive || !e.originalEvent.touches.length) return;
  e.originalEvent.preventDefault();
  const touch = e.originalEvent.touches[0];
  const latlng = map.containerPointToLatLng(L.point(touch.clientX, touch.clientY));
  lassoDeletePoints.push(latlng);
  if (lassoDeleteLine) map.removeLayer(lassoDeleteLine);
  lassoDeleteLine = L.polyline(lassoDeletePoints, { color: '#f44336', weight: 2, dashArray: '5 5' }).addTo(map);
}

function lassoDeleteEnd() {
  if (!lassoDeleteActive) return;
  lassoDeleteActive = false;

  if (lassoDeletePoints.length < 3) {
    if (lassoDeleteLine) { map.removeLayer(lassoDeleteLine); lassoDeleteLine = null; }
    return;
  }

  const polygon = lassoDeletePoints.map(p => [p.lat, p.lng]);
  pins.forEach(pin => {
    if (pointInPolygon([pin.lat, pin.lng], polygon)) {
      if (!lassoDeleteSelected.find(p => p.id === pin.id)) {
        lassoDeleteSelected.push(pin);
      }
    }
  });

  if (lassoDeleteLine) { map.removeLayer(lassoDeleteLine); lassoDeleteLine = null; }
  document.getElementById('lasso-delete-count').textContent = lassoDeleteSelected.length;
  highlightLassoDeleteSelection();
  if (lassoDeleteSelected.length > 0) {
    showToast(`${lassoDeleteSelected.length}件選択。追加で囲むか削除を押してください`);
  }
}

function highlightLassoDeleteSelection() {
  for (const id in markers) map.removeLayer(markers[id]);
  markers = {};
  const sz = getPinSize();
  const selectedIds = new Set(lassoDeleteSelected.map(p => p.id));

  pins.forEach((pin, i) => {
    const selected = selectedIds.has(pin.id);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon" style="background:${selected ? '#f44336' : '#9E9E9E'};position:relative;${selected ? '' : 'opacity:0.6;'}">${i + 1}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      // タップで個別に選択/解除
      const idx = lassoDeleteSelected.findIndex(p => p.id === pin.id);
      if (idx !== -1) {
        lassoDeleteSelected.splice(idx, 1);
      } else {
        lassoDeleteSelected.push(pin);
      }
      document.getElementById('lasso-delete-count').textContent = lassoDeleteSelected.length;
      highlightLassoDeleteSelection();
    });
    markers[pin.id] = marker;
  });
}

function executeLassoDelete() {
  if (lassoDeleteSelected.length === 0) {
    showToast('ピンが選択されていません');
    return;
  }
  pushUndo();
  const count = lassoDeleteSelected.length;
  const deleteIds = new Set(lassoDeleteSelected.map(p => p.id));

  // マーカー削除
  deleteIds.forEach(id => {
    if (markers[id]) { map.removeLayer(markers[id]); delete markers[id]; }
  });

  // ピン配列から削除
  pins = pins.filter(p => !deleteIds.has(p.id));

  // グループからも削除
  pinGroups.forEach(grp => {
    grp.pinIds = grp.pinIds.filter(id => !deleteIds.has(id));
  });
  pinGroups = pinGroups.filter(grp => grp.pinIds.length >= 2);

  exitLassoDeleteMode();
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast(`${count}件削除しました`);
}

function cancelLassoDeleteMode() {
  exitLassoDeleteMode();
  refreshAllMarkers();
}

function exitLassoDeleteMode() {
  lassoDeleteMode = false;
  lassoDeleteSelected = [];
  lassoDeletePoints = [];
  lassoDeleteActive = false;
  if (lassoDeleteLine) { map.removeLayer(lassoDeleteLine); lassoDeleteLine = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', lassoDeleteStart);
  map.off('mousemove', lassoDeleteMove);
  map.off('mouseup', lassoDeleteEnd);
  map.off('touchstart', lassoDeleteTouchStart);
  map.off('touchmove', lassoDeleteTouchMove);
  map.off('touchend', lassoDeleteEnd);

  document.getElementById('btn-lasso-delete').classList.remove('active');
  document.getElementById('btn-lasso-delete').textContent = '🗑️ 範囲削除';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('lasso-delete-banner').classList.remove('show');
}

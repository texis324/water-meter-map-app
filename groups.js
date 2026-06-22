// --- グループ化モード（投げ縄選択） ---
let groupMode = false;
let groupSelectedPins = [];
let groupCircles = [];
let lassoPoints = [];
let lassoLine = null;
let lassoActive = false;

function toggleGroupMode() {
  if (groupMode) {
    cancelGroupMode();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  exitAllOtherModes('group');
  groupMode = true;
  pinMode = false;
  groupSelectedPins = [];
  lassoPoints = [];

  document.getElementById('btn-group').classList.add('active');
  document.getElementById('btn-group').textContent = '📦 グループ中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('group-banner').classList.add('show');
  document.getElementById('group-select-count').textContent = '0';

  // 投げ縄用のイベント
  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', lassoStart);
  map.on('mousemove', lassoMove);
  map.on('mouseup', lassoEnd);
  // タッチ対応
  map.on('touchstart', lassoTouchStart);
  map.on('touchmove', lassoTouchMove);
  map.on('touchend', lassoEnd);

  showToast('マウスドラッグで囲むか、ピンをタップして選択');
}

function lassoStart(e) {
  if (!groupMode) return;
  lassoActive = true;
  lassoPoints = [e.latlng];
  if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; }
}

function lassoTouchStart(e) {
  if (!groupMode || !e.originalEvent.touches.length) return;
  const touch = e.originalEvent.touches[0];
  const latlng = map.containerPointToLatLng(L.point(touch.clientX, touch.clientY));
  lassoActive = true;
  lassoPoints = [latlng];
  if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; }
}

function lassoMove(e) {
  if (!lassoActive) return;
  lassoPoints.push(e.latlng);
  if (lassoLine) map.removeLayer(lassoLine);
  lassoLine = L.polyline(lassoPoints, { color: '#5D4037', weight: 2, dashArray: '5 5' }).addTo(map);
}

function lassoTouchMove(e) {
  if (!lassoActive || !e.originalEvent.touches.length) return;
  e.originalEvent.preventDefault();
  const touch = e.originalEvent.touches[0];
  const latlng = map.containerPointToLatLng(L.point(touch.clientX, touch.clientY));
  lassoPoints.push(latlng);
  if (lassoLine) map.removeLayer(lassoLine);
  lassoLine = L.polyline(lassoPoints, { color: '#5D4037', weight: 2, dashArray: '5 5' }).addTo(map);
}

function lassoEnd() {
  if (!lassoActive) return;
  lassoActive = false;

  if (lassoPoints.length < 3) {
    if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; }
    return;
  }

  // 投げ縄の中にあるピンを選択
  const polygon = lassoPoints.map(p => [p.lat, p.lng]);
  pins.forEach(pin => {
    if (pointInPolygon([pin.lat, pin.lng], polygon)) {
      if (!groupSelectedPins.find(p => p.id === pin.id)) {
        groupSelectedPins.push(pin);
      }
    }
  });

  if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; }
  document.getElementById('group-select-count').textContent = groupSelectedPins.length;
  highlightGroupSelection();
  if (groupSelectedPins.length > 0) {
    showToast(`${groupSelectedPins.length}件選択。追加で囲むか完了を押してください`);
  }
}

// 点がポリゴンの中にあるか（ray casting）
function pointInPolygon(point, polygon) {
  let inside = false;
  const [py, px] = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [iy, ix] = polygon[i];
    const [jy, jx] = polygon[j];
    if (((iy > py) !== (jy > py)) && (px < (jx - ix) * (py - iy) / (jy - iy) + ix)) {
      inside = !inside;
    }
  }
  return inside;
}

function highlightGroupSelection() {
  // 選択ピンをハイライト表示
  for (const id in markers) map.removeLayer(markers[id]);
  markers = {};
  const sz = getPinSize();
  const selectedIds = new Set(groupSelectedPins.map(p => p.id));

  pins.forEach((pin, i) => {
    const selected = selectedIds.has(pin.id);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon" style="background:${selected ? '#5D4037' : '#9E9E9E'};position:relative;${selected ? '' : 'opacity:0.6;'}">${i + 1}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      handleGroupTap(pin.id);
    });
    markers[pin.id] = marker;
  });
}

function handleGroupTap(pinId) {
  const idx = groupSelectedPins.findIndex(p => p.id === pinId);
  if (idx !== -1) {
    groupSelectedPins.splice(idx, 1);
  } else {
    const pin = pins.find(p => p.id === pinId);
    if (pin) groupSelectedPins.push(pin);
  }
  document.getElementById('group-select-count').textContent = groupSelectedPins.length;
  highlightGroupSelection();
}

function finishGroupMode() {
  if (groupSelectedPins.length < 2) {
    showToast('2件以上選択してください');
    return;
  }
  pushUndo();

  // 新しいグループを作成（ピンは消さない、囲みで表示）
  const newGroup = {
    id: Date.now(),
    name: '',
    pinIds: groupSelectedPins.map(p => p.id)
  };
  pinGroups.push(newGroup);

  exitGroupMode();
  refreshAllMarkers();
  saveToStorage();
  showToast(`${newGroup.pinIds.length}件をグループ化しました`);
}

function cancelGroupMode() {
  exitGroupMode();
  refreshAllMarkers();
}

function exitGroupMode() {
  groupMode = false;
  groupSelectedPins = [];
  lassoPoints = [];
  lassoActive = false;
  if (lassoLine) { map.removeLayer(lassoLine); lassoLine = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', lassoStart);
  map.off('mousemove', lassoMove);
  map.off('mouseup', lassoEnd);
  map.off('touchstart', lassoTouchStart);
  map.off('touchmove', lassoTouchMove);
  map.off('touchend', lassoEnd);

  document.getElementById('btn-group').classList.remove('active');
  document.getElementById('btn-group').textContent = '📦 グループ';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('group-banner').classList.remove('show');
}

// グループの展開/縮小を切り替え
function toggleGroupCollapse(grpId) {
  const grp = pinGroups.find(g => g.id === grpId);
  if (!grp) return;
  grp.collapsed = !grp.collapsed;
  if (grp.collapsed) {
    // 縮小時: pins配列で最も番号が小さいピンを代表（pinIds[0]）にする
    grp.pinIds.sort((a, b) => {
      const idxA = pins.findIndex(p => p.id === a);
      const idxB = pins.findIndex(p => p.id === b);
      return idxA - idxB;
    });
  }
  refreshAllMarkers();
  saveToStorage();
  showToast(grp.collapsed ? 'グループを縮小しました' : 'グループを展開しました');
}

// 縮小中のグループに属する非代表ピンか？
function isHiddenByGroup(pin) {
  for (const grp of pinGroups) {
    if (!grp.collapsed) continue;
    const idx = grp.pinIds.indexOf(pin.id);
    if (idx > 0) return true; // 代表(idx=0)以外は非表示
  }
  return false;
}

// ピンの表示番号を計算（縮小グループは1カウント）
function getDisplayNumber(pin) {
  // ラベルの先頭番号があればそれを使う（注釈の番号が正）
  if (pin.label) {
    const m = pin.label.match(/^(\d+)\./);
    if (m) return parseInt(m[1]);
  }
  // ラベルがない場合はpins配列での順番
  let num = 0;
  const seenGroups = new Set();
  for (const p of pins) {
    if (isHiddenByGroup(p)) continue;
    const grp = pinGroups.find(g => g.collapsed && g.pinIds[0] === p.id);
    if (grp && !seenGroups.has(grp.id)) {
      seenGroups.add(grp.id);
    }
    num++;
    if (p.id === pin.id) return num;
  }
  return num;
}

// グループの矩形4角を計算（緯度補正付き回転で歪み防止）
function getGroupCorners(grp, grpPins) {
  const lats = grpPins.map(p => p.lat);
  const lngs = grpPins.map(p => p.lng);
  const basePad = 0.00004;
  const extraPad = (grp.padding || 0) * 0.00001;
  const pad = basePad + extraPad;
  const rotation = grp.rotation || 0;
  const oLat = grp.offsetLat || 0;
  const oLng = grp.offsetLng || 0;

  const minLat = Math.min(...lats) - pad + oLat;
  const maxLat = Math.max(...lats) + pad + oLat;
  const minLng = Math.min(...lngs) - pad + oLng;
  const maxLng = Math.max(...lngs) + pad + oLng;
  const cLat = (minLat + maxLat) / 2;
  const cLng = (minLng + maxLng) / 2;

  const corners = [
    [minLat, minLng], [minLat, maxLng],
    [maxLat, maxLng], [maxLat, minLng]
  ];

  if (rotation === 0) return { corners, center: [cLat, cLng] };

  // 緯度に応じた経度スケール補正（1°経度 = cos(lat) × 1°緯度 の距離）
  const cosLat = Math.cos(cLat * Math.PI / 180);
  const rad = rotation * Math.PI / 180;
  const rotated = corners.map(([lat, lng]) => {
    const dLat = lat - cLat;
    const dLng = (lng - cLng) * cosLat; // 実距離に変換
    const rLat = dLat * Math.cos(rad) - dLng * Math.sin(rad);
    const rLng = dLat * Math.sin(rad) + dLng * Math.cos(rad);
    return [cLat + rLat, cLng + rLng / cosLat]; // 緯度経度に戻す
  });
  return { corners: rotated, center: [cLat, cLng] };
}

// グループ囲み描画（矩形 + 点線 + ドラッグハンドル）
// ハンドルをドラッグ中に再生成しない方式
function drawGroupCircles() {
  groupCircles.forEach(c => map.removeLayer(c));
  groupCircles = [];

  // 旧式のpin.group対応（後方互換）
  pins.forEach(pin => {
    if (pin.group && pin.group.length) {
      const circle = L.circleMarker([pin.lat, pin.lng], {
        radius: getPinSize() * 0.8 + 6,
        color: '#7B1FA2', weight: 2, dashArray: '4 4', fill: false, interactive: false
      }).addTo(map);
      groupCircles.push(circle);
    }
  });

  // 新式のpinGroups対応
  pinGroups.forEach(grp => {
    const grpPins = grp.pinIds.map(id => pins.find(p => p.id === id)).filter(Boolean);
    if (grpPins.length < 1) return;

    const { corners, center } = getGroupCorners(grp, grpPins);

    if (grp.collapsed) {
      // 縮小時: 点線矩形のみ描画（ハンドルなし）
      const shape = L.polygon(corners, {
        color: '#5D4037', weight: 2, dashArray: '6 4',
        fill: true, fillColor: '#5D4037', fillOpacity: 0.03,
        interactive: true
      }).addTo(map);

      shape.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        toggleGroupCollapse(grp.id);
      });
      shape.on('contextmenu', function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        pushUndo();
        pinGroups = pinGroups.filter(g => g.id !== grp.id);
        refreshAllMarkers();
        saveToStorage();
        showToast('グループを解除しました');
      });
      groupCircles.push(shape);
    } else {
      // 展開時: 矩形本体 + ハンドル
      const shape = L.polygon(corners, {
        color: '#5D4037', weight: 2, dashArray: '6 4',
        fill: true, fillColor: '#5D4037', fillOpacity: 0.05
      }).addTo(map);

      shape.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        toggleGroupCollapse(grp.id);
      });
      shape.on('contextmenu', function(e) {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        pushUndo();
        pinGroups = pinGroups.filter(g => g.id !== grp.id);
        refreshAllMarkers();
        saveToStorage();
        showToast('グループを解除しました');
      });
      groupCircles.push(shape);

      // --- 移動ハンドル（中央 ✥）---
      const moveHandle = L.marker(center, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:16px;height:16px;background:rgba(93,64,55,0.8);border:2px solid white;border-radius:50%;cursor:move;box-shadow:0 1px 3px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:9px;color:white;line-height:1;">✥</div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        draggable: true,
        zIndexOffset: 1000
      }).addTo(map);

      let moveStartLat = 0, moveStartLng = 0;
      moveHandle.on('dragstart', function(e) {
        pushUndo();
        map.dragging.disable();
        moveStartLat = center[0];
        moveStartLng = center[1];
      });
      moveHandle.on('drag', function(e) {
        const pos = e.target.getLatLng();
        const dLat = pos.lat - moveStartLat;
        const dLng = pos.lng - moveStartLng;
        // ピンも一緒に移動
        grpPins.forEach(pin => {
          pin.lat += dLat;
          pin.lng += dLng;
          if (markers[pin.id]) {
            markers[pin.id].setLatLng([pin.lat, pin.lng]);
          }
        });
        moveStartLat = pos.lat;
        moveStartLng = pos.lng;
        // 枠も更新
        const newData = getGroupCorners(grp, grpPins);
        shape.setLatLngs(newData.corners);
      });
      moveHandle.on('dragend', function() {
        map.dragging.enable();
        saveToStorage();
        drawGroupCircles(); // ハンドル位置を再配置
      });
      groupCircles.push(moveHandle);

      // --- リサイズハンドル（右下角 ■）---
      const resizeCorner = corners[2]; // 右上角
      const resizeHandle = L.marker(resizeCorner, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:12px;height:12px;background:#5D4037;border:2px solid white;border-radius:2px;cursor:nwse-resize;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></div>',
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        }),
        draggable: true,
        zIndexOffset: 1000
      }).addTo(map);

      let resizeStartPad = grp.padding || 0;
      let resizeStartDist = 0;

      resizeHandle.on('dragstart', function() {
        pushUndo();
        map.dragging.disable();
        resizeStartPad = grp.padding || 0;
        resizeStartDist = Math.sqrt(
          Math.pow(resizeCorner[0] - center[0], 2) + Math.pow(resizeCorner[1] - center[1], 2)
        );
      });
      resizeHandle.on('drag', function(e) {
        const pos = e.target.getLatLng();
        const newDist = Math.sqrt(
          Math.pow(pos.lat - center[0], 2) + Math.pow(pos.lng - center[1], 2)
        );
        const delta = (newDist - resizeStartDist) / 0.00001; // 連続値
        grp.padding = Math.max(-3, resizeStartPad + delta);
        // ポリゴンだけ更新（ハンドル再生成なし）
        const newData = getGroupCorners(grp, grpPins);
        shape.setLatLngs(newData.corners);
      });
      resizeHandle.on('dragend', function() {
        map.dragging.enable();
        saveToStorage();
        drawGroupCircles(); // 最終位置でハンドル再配置
      });
      groupCircles.push(resizeHandle);

      // --- 回転ハンドル（上辺中央 🔄）---
      const topMid = [
        (corners[2][0] + corners[3][0]) / 2,
        (corners[2][1] + corners[3][1]) / 2
      ];
      const offsetLat = (corners[2][0] - corners[0][0]) * 0.2;
      const offsetLng = (corners[2][1] - corners[0][1]) * 0.2;
      const rotHandlePos = [topMid[0] + offsetLat, topMid[1] + offsetLng];

      const rotHandle = L.marker(rotHandlePos, {
        icon: L.divIcon({
          className: '',
          html: '<div style="width:16px;height:16px;background:#1976D2;border:2px solid white;border-radius:50%;cursor:grab;box-shadow:0 1px 3px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;color:white;line-height:1;">↻</div>',
          iconSize: [16, 16],
          iconAnchor: [8, 8]
        }),
        draggable: true,
        zIndexOffset: 1000
      }).addTo(map);

      // 回転ハンドルから枠上辺への線
      const rotLine = L.polyline([topMid, rotHandlePos], {
        color: '#1976D2', weight: 1.5, dashArray: '3 3', interactive: false
      }).addTo(map);
      groupCircles.push(rotLine);

      let rotStartAngle = grp.rotation || 0;
      let rotStartMouseAngle = 0;

      const cosLatRot = Math.cos(center[0] * Math.PI / 180);
      rotHandle.on('dragstart', function(e) {
        pushUndo();
        map.dragging.disable();
        rotStartAngle = grp.rotation || 0;
        const pos = e.target.getLatLng();
        rotStartMouseAngle = Math.atan2((pos.lng - center[1]) * cosLatRot, pos.lat - center[0]);
      });
      rotHandle.on('drag', function(e) {
        const pos = e.target.getLatLng();
        const currentAngle = Math.atan2((pos.lng - center[1]) * cosLatRot, pos.lat - center[0]);
        const delta = (currentAngle - rotStartMouseAngle) * 180 / Math.PI;
        grp.rotation = rotStartAngle + delta;
        // ポリゴンだけ更新
        const newData = getGroupCorners(grp, grpPins);
        shape.setLatLngs(newData.corners);
        // 回転線も更新
        const newTopMid = [
          (newData.corners[2][0] + newData.corners[3][0]) / 2,
          (newData.corners[2][1] + newData.corners[3][1]) / 2
        ];
        rotLine.setLatLngs([newTopMid, [pos.lat, pos.lng]]);
      });
      rotHandle.on('dragend', function() {
        map.dragging.enable();
        saveToStorage();
        drawGroupCircles(); // 最終位置でハンドル再配置
      });
      groupCircles.push(rotHandle);
    }
  });
}

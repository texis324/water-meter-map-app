// --- ラベル番号の振り直し ---
// pins配列の並び順に合わせてラベルの先頭番号を更新する（idは変更しない）
function relabelPins() {
  pins.forEach((pin, i) => {
    const num = i + 1;
    if (pin.label) {
      pin.label = pin.label.replace(/^\d+\./, `${num}.`);
    }
  });
}

// --- 並べ替えモード ---
let reorderMode = false;
let reorderedPins = [];    // 並べ替え済みのピン（タップ順）
let remainingPins = [];    // まだタップされていないピン
let reorderAnchorSet = false; // 開始位置が確定済みか
let reorderSwapMode = false;  // 入替モード（番号指定不要）

function toggleReorderMode() {
  if (reorderMode) {
    cancelReorder();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  // 並べ替えモード開始
  exitAllOtherModes('reorder');
  reorderMode = true;
  pinMode = false;
  reorderedPins = [];
  remainingPins = [...pins];
  reorderAnchorSet = false;

  document.getElementById('btn-reorder').classList.add('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('reorder-banner').classList.add('show');
  updateReorderCount();

  // 全ピンをグレーに
  refreshReorderMarkers();
  showToast('開始位置のピンをタップ（その次から並べ替え）');
}

function handleReorderTap(pinId) {
  // 最初のタップ: 開始位置を設定（そのピンの次の番号から並べ替え開始）
  if (!reorderAnchorSet) {
    const anchorIdx = pins.findIndex(p => p.id === pinId);
    if (anchorIdx === -1) return;
    const startNum = anchorIdx + 2; // そのピンの次の番号
    document.getElementById('reorder-start').value = startNum;
    reorderAnchorSet = true;
    refreshReorderMarkers();
    showToast(`${anchorIdx + 1}番の次（${startNum}番）から並べ替え開始`);
    return;
  }

  const idx = remainingPins.findIndex(p => p.id === pinId);
  if (idx === -1) {
    showToast('そのピンは並べ替え済みです');
    return;
  }
  // remaining → reordered に移動
  const pin = remainingPins.splice(idx, 1)[0];
  reorderedPins.push(pin);
  updateReorderCount();
  refreshReorderMarkers();
}

function updateReorderCount() {
  document.getElementById('reorder-count').textContent = reorderedPins.length;
  const instr = document.getElementById('reorder-instruction');
  if (instr) {
    instr.textContent = reorderAnchorSet ? 'ピンをタップして並べ替え' : '開始位置のピンをタップ';
  }
}

function getReorderStartNum() {
  return parseInt(document.getElementById('reorder-start')?.value || 1);
}

function updateReorderDisplay() {
  refreshReorderMarkers();
}

function refreshReorderMarkers() {
  for (const id in markers) {
    map.removeLayer(markers[id]);
  }
  markers = {};

  const startNum = getReorderStartNum();
  const sz = getPinSize();

  // 並べ替え済みピン（紫、開始番号からの連番）
  reorderedPins.forEach((pin, i) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon reordered">${reorderSwapMode ? (i + 1) : (startNum + i)}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon, draggable: true }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      if (reorderedPins[reorderedPins.length - 1]?.id === pin.id) {
        reorderedPins.pop();
        remainingPins.unshift(pin);
        updateReorderCount();
        refreshReorderMarkers();
        showToast('1つ戻しました');
      }
    });
    marker.on('dragend', function(e) {
      const pos = e.target.getLatLng();
      pin.lat = pos.lat;
      pin.lng = pos.lng;
      saveToStorage();
    });
    markers[pin.id] = marker;
  });

  // 未処理ピン（グレー、元の番号を表示）
  remainingPins.forEach(pin => {
    const origIdx = pins.indexOf(pin) + 1;
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon reorder-pending">${origIdx}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon, draggable: true }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      handleReorderTap(pin.id);
    });
    marker.on('dragend', function(e) {
      const pos = e.target.getLatLng();
      pin.lat = pos.lat;
      pin.lng = pos.lng;
      saveToStorage();
    });
    markers[pin.id] = marker;
  });
}

function toggleReorderSwapMode() {
  reorderSwapMode = !reorderSwapMode;
  const btn = document.getElementById('btn-swap-mode');
  const startArea = document.getElementById('reorder-startnum-area');
  if (reorderSwapMode) {
    btn.style.background = 'white';
    btn.style.color = '#9C27B0';
    startArea.style.display = 'none';
    reorderAnchorSet = true; // アンカー不要
    showToast('入替モード: ピンをタップ順に入替えます');
  } else {
    btn.style.background = 'rgba(255,255,255,0.3)';
    btn.style.color = 'white';
    startArea.style.display = '';
    reorderAnchorSet = false;
    showToast('通常モード: 開始番号を指定して並べ替え');
  }
  updateReorderCount();
  refreshReorderMarkers();
}

function finishReorder() {
  if (reorderedPins.length === 0) {
    showToast('1件もタップされていません');
    return;
  }
  pushUndo();
  if (reorderSwapMode) {
    // 入替モード: タップしたピンの元の位置（ソート済み）にタップ順で配置
    const origIndices = reorderedPins.map(p => pins.indexOf(p)).sort((a, b) => a - b);
    const newPins = [...pins];
    reorderedPins.forEach((pin, i) => {
      newPins[origIndices[i]] = pin;
    });
    pins = newPins;
  } else {
    // 通常モード: 開始番号の位置に挿入
    const startNum = getReorderStartNum();
    const insertIdx = startNum - 1;
    const reorderedIds = new Set(reorderedPins.map(p => p.id));
    const newPins = pins.filter(p => !reorderedIds.has(p.id));
    const clampedIdx = Math.min(insertIdx, newPins.length);
    newPins.splice(clampedIdx, 0, ...reorderedPins);
    pins = newPins;
  }

  // モード終了
  reorderMode = false;
  reorderedPins = [];
  remainingPins = [];
  reorderSwapMode = false;
  document.getElementById('btn-reorder').classList.remove('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('reorder-banner').classList.remove('show');

  relabelPins();
  refreshAllMarkers();
  saveToStorage();
  showToast('並べ替え完了！');
}

function cancelReorder() {
  reorderMode = false;
  reorderedPins = [];
  remainingPins = [];
  reorderAnchorSet = false;
  reorderSwapMode = false;
  document.getElementById('btn-reorder').classList.remove('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('reorder-banner').classList.remove('show');

  refreshAllMarkers();
  showToast('並べ替えを取消しました');
}

// --- なぞり並べ替えモード ---
let traceReorderMode = false;
let traceReorderPoints = [];
let traceReorderLine = null;
let traceHighlightedIds = new Set(); // ハイライト中のピンID

function toggleTraceReorder() {
  if (traceReorderMode) {
    cancelTraceReorder();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  exitAllOtherModes('traceReorder');
  traceReorderMode = true;
  pinMode = false;
  traceReorderPoints = [];
  document.getElementById('btn-trace-reorder').classList.add('active');
  document.getElementById('btn-trace-reorder').textContent = '👆 なぞり中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('trace-reorder-banner').classList.add('show');

  // 地図のドラッグを無効化（なぞり用）
  map.dragging.disable();

  // マウス/タッチでなぞり
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', traceReorderStart);
  map.on('touchstart', traceReorderStart);

  showToast('ピンを横切るように線をなぞってください');
}

function traceReorderStart(e) {
  if (!traceReorderMode) return;
  // ミドルボタン: 地図パン移動
  if (e.originalEvent && e.originalEvent.button === 1) {
    e.originalEvent.preventDefault();
    const startPos = { x: e.originalEvent.clientX, y: e.originalEvent.clientY };
    const startCenter = map.getCenter();
    function onMiddleMove(ev) {
      const dx = ev.clientX - startPos.x;
      const dy = ev.clientY - startPos.y;
      const startPoint = map.latLngToContainerPoint(startCenter);
      map.panTo(map.containerPointToLatLng([startPoint.x - dx, startPoint.y - dy]), { animate: false });
    }
    function onMiddleUp() {
      document.removeEventListener('mousemove', onMiddleMove);
      document.removeEventListener('mouseup', onMiddleUp);
    }
    document.addEventListener('mousemove', onMiddleMove);
    document.addEventListener('mouseup', onMiddleUp);
    return;
  }
  traceReorderPoints = [];
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }

  const latlng = e.latlng || (e.touches && map.mouseEventToLatLng(e.touches[0]));
  if (!latlng) return;
  traceReorderPoints.push(latlng);

  traceReorderLine = L.polyline(traceReorderPoints, {
    color: '#E65100', weight: 3, opacity: 0.7
  }).addTo(map);

  map.on('mousemove', traceReorderMove);
  map.on('touchmove', traceReorderMove);
  map.on('mouseup', traceReorderEnd);
  map.on('touchend', traceReorderEnd);
}

function traceReorderMove(e) {
  if (!traceReorderMode || !traceReorderLine) return;
  const latlng = e.latlng || (e.touches && map.mouseEventToLatLng(e.touches[0]));
  if (!latlng) return;
  traceReorderPoints.push(latlng);
  traceReorderLine.setLatLngs(traceReorderPoints);

  // リアルタイムハイライト: 線の近くのピンをオレンジに
  const threshold = getTraceThresholdPx();
  pins.forEach(pin => {
    if (isHiddenByGroup(pin)) return;
    const pinPx = map.latLngToContainerPoint([pin.lat, pin.lng]);
    const curPx = map.latLngToContainerPoint(latlng);
    const distPx = Math.sqrt(Math.pow(pinPx.x - curPx.x, 2) + Math.pow(pinPx.y - curPx.y, 2));
    if (distPx < threshold && !traceHighlightedIds.has(pin.id)) {
      traceHighlightedIds.add(pin.id);
      const m = markers[pin.id];
      if (m) {
        const el = m.getElement();
        if (el) {
          const icon = el.querySelector('.pin-icon');
          if (icon) {
            icon.style.background = '#E65100';
            icon.style.color = 'white';
            icon.style.transition = 'background 0.15s';
          }
        }
      }
    }
  });
}

// ピクセル単位の閾値（ピンサイズに連動）
function getTraceThresholdPx() {
  return getPinSize() * 0.8 + 5; // ピンの半径+少し余裕
}

function traceReorderEnd() {
  map.off('mousemove', traceReorderMove);
  map.off('touchmove', traceReorderMove);
  map.off('mouseup', traceReorderEnd);
  map.off('touchend', traceReorderEnd);
  // 即時反映（モードは継続）
  if (traceReorderPoints.length >= 2) {
    applyTraceReorder();
  }
}

// 並べ替え実行（モード継続）
function applyTraceReorder() {
  if (traceReorderPoints.length < 2) return;

  // 全てピクセル座標で計算（距離も順序も統一）
  const segsPx = [];
  let cumLen = 0;
  for (let i = 0; i < traceReorderPoints.length - 1; i++) {
    const aPx = map.latLngToContainerPoint(traceReorderPoints[i]);
    const bPx = map.latLngToContainerPoint(traceReorderPoints[i + 1]);
    const dx = bPx.x - aPx.x, dy = bPx.y - aPx.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    segsPx.push({ aPx, bPx, dx, dy, segLen, cumLen });
    cumLen += segLen;
  }

  const thresholdPx = getTraceThresholdPx();
  const visiblePins = pins.filter(p => !isHiddenByGroup(p));
  const nearPins = [];

  visiblePins.forEach(pin => {
    const pinPx = map.latLngToContainerPoint([pin.lat, pin.lng]);
    let minDistPx = Infinity;
    let bestT = 0;

    for (const seg of segsPx) {
      let t = 0;
      if (seg.segLen > 0) {
        t = Math.max(0, Math.min(1,
          ((pinPx.x - seg.aPx.x) * seg.dx + (pinPx.y - seg.aPx.y) * seg.dy) / (seg.segLen * seg.segLen)
        ));
      }
      const px = seg.aPx.x + t * seg.dx;
      const py = seg.aPx.y + t * seg.dy;
      const dist = Math.sqrt(Math.pow(pinPx.x - px, 2) + Math.pow(pinPx.y - py, 2));
      if (dist < minDistPx) {
        minDistPx = dist;
        bestT = seg.cumLen + t * seg.segLen;
      }
    }

    if (minDistPx < thresholdPx) {
      nearPins.push({ pin, t: bestT });
    }
  });

  if (nearPins.length < 2) {
    showToast('近くにピンが足りません');
    if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }
    traceReorderPoints = [];
    traceHighlightedIds.clear();
    refreshAllMarkers();
    return;
  }

  pushUndo();
  nearPins.sort((a, b) => a.t - b.t);

  const targetIds = new Set(nearPins.map(p => p.pin.id));
  let minIdx = pins.length;
  pins.forEach((p, i) => {
    if (targetIds.has(p.id) && i < minIdx) minIdx = i;
  });

  const remaining = pins.filter(p => !targetIds.has(p.id));
  const reordered = nearPins.map(p => p.pin);
  remaining.splice(minIdx, 0, ...reordered);
  pins = remaining;

  // 線を消してリセット（モードは継続）
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }
  traceReorderPoints = [];
  traceHighlightedIds.clear();

  relabelPins();
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast(`${nearPins.length}件を${minIdx + 1}番から並べ替え`);
}

function finishTraceReorder() {
  cancelTraceReorder();
}

function cancelTraceReorder() {
  traceReorderMode = false;
  traceReorderPoints = [];
  traceHighlightedIds.clear();
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', traceReorderStart);
  map.off('touchstart', traceReorderStart);
  map.off('mousemove', traceReorderMove);
  map.off('touchmove', traceReorderMove);
  map.off('mouseup', traceReorderEnd);
  map.off('touchend', traceReorderEnd);

  document.getElementById('btn-trace-reorder').classList.remove('active');
  document.getElementById('btn-trace-reorder').textContent = '👆 なぞり順';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('trace-reorder-banner').classList.remove('show');
}

// --- 連結モード ---
let concatMode = false;
let concatFirst = null;  // 前半の終点ピン

function toggleConcatMode() {
  if (concatMode) {
    cancelConcat();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  exitAllOtherModes('concat');
  concatMode = true;
  pinMode = false;
  concatFirst = null;
  document.getElementById('btn-concat').classList.add('active');
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('concat-banner').classList.add('show');
  showToast('前半の終点ピンをタップしてください');
}

function handleConcatTap(pinId) {
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;

  const labelMatch = (pin.label || '').match(/^(\d+)\./);
  const pinNum = labelMatch ? parseInt(labelMatch[1]) : null;

  if (!concatFirst) {
    // 1つ目: 前半の終点
    concatFirst = pin;
    const numText = pinNum ? `#${pinNum}` : `id=${pin.id}`;
    document.getElementById('concat-status').textContent = `${numText} を選択済み → 次は後半の始点をタップ`;
    // ハイライト
    const m = markers[pin.id];
    if (m) {
      const el = m.getElement();
      if (el) {
        const icon = el.querySelector('.pin-icon');
        if (icon) { icon.style.background = '#E91E63'; icon.style.transition = 'background 0.15s'; }
      }
    }
    showToast(`${numText} の後ろに繋げる先をタップ`);
  } else {
    // 2つ目: 後半の始点
    if (pin.id === concatFirst.id) {
      showToast('同じピンです。別のピンをタップしてください');
      return;
    }

    const firstMatch = (concatFirst.label || '').match(/^(\d+)\./);
    const firstNum = firstMatch ? parseInt(firstMatch[1]) : null;
    const secondNum = pinNum;

    // pins配列でのインデックスを取得
    const firstIdx = pins.indexOf(concatFirst);
    const secondIdx = pins.indexOf(pin);

    if (firstIdx === -1 || secondIdx === -1) {
      showToast('ピンが見つかりません');
      cancelConcat();
      return;
    }

    pushUndo();

    // 前半: 0〜firstIdx、後半: secondIdx〜末尾、スキップ: firstIdx+1〜secondIdx-1
    const partA = pins.slice(0, firstIdx + 1);
    const partB = pins.slice(secondIdx);
    const skipped = pins.slice(firstIdx + 1, secondIdx);

    pins = [...partA, ...partB, ...skipped];

    const numA = firstNum || (firstIdx + 1);
    const numB = secondNum || (secondIdx + 1);

    // ラベル番号を配列順に振り直し
    relabelPins();

    showToast(`#${numA} → #${numB} に連結しました（${skipped.length}件を後方へ移動）`);

    refreshAllMarkers();
    saveToStorage();
    updatePinCount();
    cancelConcat();
  }
}

function cancelConcat() {
  concatMode = false;
  concatFirst = null;
  document.getElementById('btn-concat').classList.remove('active');
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('concat-banner').classList.remove('show');
  refreshAllMarkers();
}

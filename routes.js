// --- ルート表示 (Google Directions API) ---
const GOOGLE_API_KEY = 'AIzaSyBOemRQOk5uindiAsebzINiKbPwl2phA2E';
let routeLines = [];
let routeVisible = false;
// 並行fetch対策: showRoute連打や hide→show 切替時に前回のバッチ取得をキャンセル
let routeAbortController = null;

function toggleRoute() {
  if (routeVisible) {
    hideRoute();
    return;
  }
  showRoute();
}

function hideRoute() {
  // 進行中のルート取得があれば中断
  if (routeAbortController) {
    routeAbortController.abort();
    routeAbortController = null;
  }
  routeLines.forEach(line => map.removeLayer(line));
  routeLines = [];
  routeVisible = false;
  document.getElementById('btn-route').textContent = '🔄 ルート表示';
  showToast('ルートを非表示にしました');
}

// Google Directions APIでルート取得（最大25ウェイポイント/リクエスト）
async function fetchGoogleRoute(waypoints, signal) {
  const origin = `${waypoints[0].lat},${waypoints[0].lng}`;
  const destination = `${waypoints[waypoints.length - 1].lat},${waypoints[waypoints.length - 1].lng}`;

  let url = `https://maps.googleapis.com/maps/api/directions/json?origin=${origin}&destination=${destination}&mode=walking&key=${GOOGLE_API_KEY}`;

  // 中間ウェイポイントがあれば追加
  if (waypoints.length > 2) {
    const mid = waypoints.slice(1, -1).map(p => `${p.lat},${p.lng}`).join('|');
    url += `&waypoints=${mid}`;
  }

  const res = await fetch(url, { signal });
  const data = await res.json();

  if (data.status === 'OK' && data.routes[0]) {
    // encoded polyline をデコード
    return decodePolyline(data.routes[0].overview_polyline.points);
  }
  return null;
}

// Google Encoded Polyline デコーダー
function decodePolyline(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);

    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

async function showRoute() {
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }

  showToast('ルート取得中...');

  // 前回の取得が進行中なら中断（連打時のラインが重なる/上書きされるレース対策）
  if (routeAbortController) {
    routeAbortController.abort();
  }
  routeAbortController = new AbortController();
  const myController = routeAbortController;
  const signal = myController.signal;

  // 既存ルートをクリア
  routeLines.forEach(line => map.removeLayer(line));
  routeLines = [];

  // Google Directions APIは1リクエスト最大25地点（origin + destination + 23 waypoints）
  // ピンをバッチに分けてリクエスト
  const batchSize = 25;
  let failCount = 0;

  try {
    for (let i = 0; i < pins.length - 1; i += batchSize - 1) {
      // 途中で中断された場合はこれ以上描画しない
      if (signal.aborted || myController !== routeAbortController) return;

      const batch = pins.slice(i, Math.min(i + batchSize, pins.length));
      if (batch.length < 2) break;

      try {
        const routeCoords = await fetchGoogleRoute(batch, signal);
        if (signal.aborted || myController !== routeAbortController) return;
        if (routeCoords) {
          const line = L.polyline(routeCoords, {
            color: '#1976D2',
            weight: 5,
            opacity: getTraceOpacity()
          }).addTo(map);
          routeLines.push(line);
        } else {
          throw new Error('No route');
        }
      } catch (err) {
        // 中断によるエラーは即座に抜ける（フォールバック線も引かない）
        if (err && err.name === 'AbortError') return;
        if (signal.aborted) return;
        failCount++;
        // フォールバック: 直線で繋ぐ
        for (let j = 0; j < batch.length - 1; j++) {
          const line = L.polyline(
            [[batch[j].lat, batch[j].lng], [batch[j+1].lat, batch[j+1].lng]],
            { color: '#f44336', weight: 3, opacity: 0.6, dashArray: '8, 8' }
          ).addTo(map);
          routeLines.push(line);
        }
      }
    }
  } finally {
    // 自分が最新のままなら、controllerをクリア
    if (myController === routeAbortController) {
      routeAbortController = null;
    }
  }

  routeVisible = true;
  document.getElementById('btn-route').textContent = '🔄 ルート非表示';
  if (failCount > 0) {
    showToast(`ルート表示完了（${failCount}区間は直線で代替）`);
  } else {
    showToast('ルートを表示しました');
  }
}

// --- ルート線の濃さ ---
function getTraceOpacity() {
  const slider = document.getElementById('trace-opacity-slider');
  return slider ? parseInt(slider.value) / 100 : 0.9;
}

function changeTraceOpacity(val) {
  const op = val / 100;
  // Google Directionsルート線に反映
  routeLines.forEach(line => line.setStyle({ opacity: op }));
  // 保存済みルート線に反映
  savedTraceLines.forEach(line => line.setStyle({ opacity: op }));
  // 作業中のルート線にも反映
  if (traceLine) traceLine.setStyle({ opacity: op });
  // 永続化（リロード後も維持）
  localStorage.setItem('waterMeterTraceOpacity', String(val));
}

// --- ルート線モード ---
function toggleTraceMode() {
  if (traceMode) {
    finishTrace();
    return;
  }
  exitAllOtherModes('trace');
  traceMode = true;
  pinMode = false;
  tracePoints = [];

  document.getElementById('btn-trace').classList.add('active');
  document.getElementById('btn-trace').textContent = '✏️ ルート線中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('trace-banner').classList.add('show');
  updateTraceCount();
  showToast('タップでルート線を引いてください');
}

function handleTraceTap(latlng) {
  const point = { lat: latlng.lat, lng: latlng.lng };
  tracePoints.push(point);
  updateTraceCount();

  // 小さい丸マーカーを追加
  const circleMarker = L.circleMarker([point.lat, point.lng], {
    radius: 5,
    color: '#1976D2',
    fillColor: '#1976D2',
    fillOpacity: 0.8,
    weight: 2
  }).addTo(map);
  traceMarkers.push(circleMarker);

  // ラインを更新
  const coords = tracePoints.map(p => [p.lat, p.lng]);
  if (traceLine) {
    traceLine.setLatLngs(coords);
  } else {
    traceLine = L.polyline(coords, {
      color: '#1976D2',
      weight: 4,
      opacity: getTraceOpacity()
    }).addTo(map);
  }
}

function undoTrace() {
  if (tracePoints.length === 0) return;
  tracePoints.pop();

  // 最後のマーカーを削除
  const lastMarker = traceMarkers.pop();
  if (lastMarker) map.removeLayer(lastMarker);

  // ラインを更新
  if (tracePoints.length > 0) {
    traceLine.setLatLngs(tracePoints.map(p => [p.lat, p.lng]));
  } else if (traceLine) {
    map.removeLayer(traceLine);
    traceLine = null;
  }
  updateTraceCount();
}

function clearTrace() {
  tracePoints = [];
  traceMarkers.forEach(m => map.removeLayer(m));
  traceMarkers = [];
  if (traceLine) { map.removeLayer(traceLine); traceLine = null; }
  updateTraceCount();
  showToast('ルート線をクリアしました');
}

function finishTrace() {
  // なぞったルートがあれば保存
  if (tracePoints.length >= 2) {
    pushUndo();
    const colors = ['#E91E63', '#FF9800', '#9C27B0', '#009688', '#FF5722', '#3F51B5'];
    const colorIdx = savedTraces.length % colors.length;
    savedTraces.push({ points: [...tracePoints], color: colors[colorIdx] });

    // 作業用のラインとマーカーを消して、保存用ラインとして再描画
    traceMarkers.forEach(m => map.removeLayer(m));
    traceMarkers = [];
    if (traceLine) { map.removeLayer(traceLine); traceLine = null; }

    redrawSavedTraces();
    saveToStorage();
    showToast('ルートを保存しました');
  } else {
    // ポイントが足りない場合はクリーンアップだけ
    traceMarkers.forEach(m => map.removeLayer(m));
    traceMarkers = [];
    if (traceLine) { map.removeLayer(traceLine); traceLine = null; }
    if (tracePoints.length > 0) showToast('2点以上必要です');
  }

  tracePoints = [];
  traceMode = false;
  document.getElementById('btn-trace').classList.remove('active');
  document.getElementById('btn-trace').textContent = '✏️ ルート線';
  document.getElementById('btn-mode').style.display = '';
  document.getElementById('trace-banner').classList.remove('show');
}

function redrawSavedTraces() {
  savedTraceLines.forEach(l => map.removeLayer(l));
  savedTraceLines = [];
  savedTraces.forEach((trace, traceIdx) => {
    const coords = trace.points.map(p => [p.lat, p.lng]);
    const line = L.polyline(coords, {
      color: trace.color,
      weight: 6,
      opacity: getTraceOpacity()
    }).addTo(map);
    // タップで編集モードに入る
    line.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      if (traceEditMode || traceMode || reorderMode) return;
      startTraceEdit(traceIdx);
    });
    // 長押し/右クリックで削除
    line.on('contextmenu', function(e) {
      L.DomEvent.stopPropagation(e);
      if (traceEditMode) return;
      if (confirm('このルート線を削除しますか？')) {
        pushUndo();
        savedTraces.splice(traceIdx, 1);
        redrawSavedTraces();
        saveToStorage();
        showToast('ルート線を削除しました');
      }
    });
    savedTraceLines.push(line);
  });
}

function updateTraceCount() {
  document.getElementById('trace-count').textContent = tracePoints.length;
}

// --- ルート編集モード ---
function startTraceEdit(idx) {
  exitAllOtherModes('traceEdit');
  traceEditMode = true;
  traceEditIdx = idx;
  pinMode = false;
  traceEditOriginal = JSON.parse(JSON.stringify(savedTraces[idx]));
  traceEditPoints = savedTraces[idx].points.map(p => ({ ...p }));

  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('btn-trace').style.display = 'none';
  document.getElementById('trace-edit-banner').classList.add('show');

  // 他のルート線はそのまま、編集対象だけ非表示にして編集用に再描画
  if (savedTraceLines[idx]) {
    map.removeLayer(savedTraceLines[idx]);
  }

  drawTraceEditUI();
  showToast('ルートを編集中 — ポイントをドラッグで移動');
}

function drawTraceEditUI() {
  // 既存の編集UIをクリア
  if (traceEditLine) map.removeLayer(traceEditLine);
  traceEditMarkers.forEach(m => map.removeLayer(m));
  traceEditMidMarkers.forEach(m => map.removeLayer(m));
  traceEditMarkers = [];
  traceEditMidMarkers = [];

  const color = savedTraces[traceEditIdx].color;

  // 編集用ライン
  const coords = traceEditPoints.map(p => [p.lat, p.lng]);
  traceEditLine = L.polyline(coords, {
    color: color,
    weight: 5,
    opacity: 0.9,
    dashArray: '8, 6'
  }).addTo(map);

  // 各ポイントにドラッグ可能マーカー
  traceEditPoints.forEach((point, i) => {
    const icon = L.divIcon({
      className: '',
      html: '<div class="trace-edit-point"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8]
    });
    const marker = L.marker([point.lat, point.lng], {
      icon: icon,
      draggable: true
    }).addTo(map);

    // ドラッグでポイント移動
    marker.on('drag', function(e) {
      const pos = e.target.getLatLng();
      traceEditPoints[i].lat = pos.lat;
      traceEditPoints[i].lng = pos.lng;
      traceEditLine.setLatLngs(traceEditPoints.map(p => [p.lat, p.lng]));
      // 中間マーカーも更新
      updateMidMarkers();
    });

    // タップでポイント削除（3点以上ある場合のみ）
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      if (traceEditPoints.length <= 2) {
        showToast('2点以下にはできません');
        return;
      }
      traceEditPoints.splice(i, 1);
      drawTraceEditUI();
      showToast('ポイントを削除しました');
    });

    traceEditMarkers.push(marker);
  });

  // 中間ポイント（ポイント間に追加用の半透明マーカー）
  updateMidMarkers();
}

function updateMidMarkers() {
  traceEditMidMarkers.forEach(m => map.removeLayer(m));
  traceEditMidMarkers = [];

  for (let i = 0; i < traceEditPoints.length - 1; i++) {
    const p1 = traceEditPoints[i];
    const p2 = traceEditPoints[i + 1];
    const midLat = (p1.lat + p2.lat) / 2;
    const midLng = (p1.lng + p2.lng) / 2;

    const icon = L.divIcon({
      className: '',
      html: '<div class="trace-mid-point"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });

    const insertIdx = i + 1;
    const midMarker = L.marker([midLat, midLng], { icon: icon }).addTo(map);

    midMarker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      // この位置に新しいポイントを挿入
      traceEditPoints.splice(insertIdx, 0, { lat: midLat, lng: midLng });
      drawTraceEditUI();
      showToast('ポイントを追加しました');
    });

    traceEditMidMarkers.push(midMarker);
  }
}

function finishTraceEdit() {
  // 編集結果を保存
  pushUndo();
  savedTraces[traceEditIdx].points = traceEditPoints;

  // 編集UIクリア
  cleanupTraceEdit();

  redrawSavedTraces();
  saveToStorage();
  showToast('ルート編集を保存しました');
}

function cancelTraceEdit() {
  // 元に戻す
  savedTraces[traceEditIdx] = traceEditOriginal;

  // 編集UIクリア
  cleanupTraceEdit();

  redrawSavedTraces();
  showToast('編集を取消しました');
}

function cleanupTraceEdit() {
  if (traceEditLine) { map.removeLayer(traceEditLine); traceEditLine = null; }
  traceEditMarkers.forEach(m => map.removeLayer(m));
  traceEditMidMarkers.forEach(m => map.removeLayer(m));
  traceEditMarkers = [];
  traceEditMidMarkers = [];

  traceEditMode = false;
  traceEditIdx = -1;
  traceEditPoints = [];
  traceEditOriginal = null;

  document.getElementById('btn-mode').style.display = '';
  document.getElementById('btn-trace').style.display = '';
  document.getElementById('trace-edit-banner').classList.remove('show');
}

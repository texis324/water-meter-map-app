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
// 線の種類（2026-08-19 Tench要望「区切りのために線を描きたい」）:
//   route   = 従来のルート線（実線・自動配色）
//   divider = 区切り線（破線・選んだ色。順路のブロック境界など、地図上のメモ用）
// savedTraces[i] = { points, color, kind } （kind 無し = 旧データ = route 扱い）
function getTraceKind() {
  const el = document.getElementById('trace-kind');
  const v = el ? el.value : 'route';
  return (v === 'divider' || v === 'marker') ? v : 'route';
}
// 📍目印（休憩スポット等）: 名前から絵文字を推定。savedTraces に {kind:'marker', points:[{lat,lng}], label, icon, color} で保存
// （線と同じ層＝保存/クラウド同期/Undo/書出しが全部そのまま効く。ピンではないので番号も順路も提出も無関係）
const NOTE_ICON_RULES = [
  [/休憩|休む|ベンチ|座/, '☕'], [/自販|飲み|水分|ジュース/, '🥤'], [/トイレ|便所|WC/i, '🚻'], [/日陰|木陰|涼/, '🌳'],
  [/駐車|バイク|停め|置き場/, '🅿'], [/危険|注意|気をつけ|滑/, '⚠'], [/犬|猫|動物/, '🐕'], [/コンビニ|ローソン|ファミマ|セブン|店/, '🏪'],
  [/開始|スタート|集合/, '🏁'], [/昼|飯|弁当|食/, '🍙'], [/鍵|カギ|施錠/, '🔑'], [/埋|土|スコップ|掘/, '🪏'],
];
function noteIconFor(label) {
  for (const [re, ic] of NOTE_ICON_RULES) if (re.test(label || '')) return ic;
  return '📌';
}
function getTraceDrawColor() {
  const el = document.getElementById('trace-color');
  return (el && el.value) ? el.value : '#212121';
}
function traceStyleFor(kind, color, weightRoute, weightDivider) {
  return kind === 'divider'
    ? { color: color, weight: weightDivider, opacity: 0.95, dashArray: '10, 8', lineCap: 'butt' }
    : { color: color, weight: weightRoute, opacity: getTraceOpacity() };
}
// バナーの種類/色を変えたら描画中の線にも反映
function updateTraceStyleLive() {
  if (!traceMode || !traceLine) return;
  const kind = getTraceKind();
  const color = kind === 'divider' ? getTraceDrawColor() : '#1976D2';
  traceLine.setStyle(traceStyleFor(kind, color, 4, 4));
  traceMarkers.forEach(m => m.setStyle({ color: color, fillColor: color }));
}

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
  const _k = getTraceKind();
  showToast(_k === 'marker' ? 'タップで目印を置いてください（名前を聞きます / Enter=終了）'
          : _k === 'divider' ? 'タップで区切り線を引いてください（Enter=完了 / Backspace=戻す / Esc=取消）'
          : 'タップでルート線を引いてください（Enter=完了 / Backspace=戻す / Esc=取消）');
}

// 取消（描きかけを捨てて終了）
function cancelTrace() {
  if (!traceMode) return;
  const n = tracePoints.length;
  if (n > 0 && !confirm(`描きかけの線（${n}点）を捨てて終了しますか？`)) return;
  tracePoints = [];
  traceMarkers.forEach(m => map.removeLayer(m));
  traceMarkers = [];
  if (traceLine) { map.removeLayer(traceLine); traceLine = null; }
  finishTrace();
}

function handleTraceTap(latlng) {
  const point = { lat: latlng.lat, lng: latlng.lng };
  if (getTraceKind() === 'marker') {
    // 📍目印: 1タップ＝1個。名前を聞いて即保存（モードは続くので連続で置ける・Enter/Escで終了）
    const label = prompt('目印の名前（例: 休憩 / 自販機 / トイレ / 日陰 / 駐車 / 危険）', '休憩');
    if (label === null) return;
    const name = (label || '').trim() || '目印';
    pushUndo();
    savedTraces.push({ kind: 'marker', points: [point], label: name, icon: noteIconFor(name), color: getTraceDrawColor() });
    redrawSavedTraces();
    saveToStorage();
    showToast(`${noteIconFor(name)} 「${name}」を置きました（続けてタップで追加 / Enterで終了）`);
    return;
  }
  tracePoints.push(point);
  updateTraceCount();

  const kind = getTraceKind();
  const drawColor = kind === 'divider' ? getTraceDrawColor() : '#1976D2';
  // 小さい丸マーカーを追加
  const circleMarker = L.circleMarker([point.lat, point.lng], {
    radius: 5,
    color: drawColor,
    fillColor: drawColor,
    fillOpacity: 0.8,
    weight: 2
  }).addTo(map);
  traceMarkers.push(circleMarker);

  // ラインを更新
  const coords = tracePoints.map(p => [p.lat, p.lng]);
  if (traceLine) {
    traceLine.setLatLngs(coords);
  } else {
    traceLine = L.polyline(coords, traceStyleFor(kind, drawColor, 4, 4)).addTo(map);
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
    const kind = getTraceKind();
    if (kind === 'divider') {
      savedTraces.push({ points: [...tracePoints], color: getTraceDrawColor(), kind: 'divider' });
    } else {
      const colors = ['#E91E63', '#FF9800', '#9C27B0', '#009688', '#FF5722', '#3F51B5'];
      const colorIdx = savedTraces.filter(t => t.kind !== 'divider').length % colors.length;
      savedTraces.push({ points: [...tracePoints], color: colors[colorIdx], kind: 'route' });
    }

    // 作業用のラインとマーカーを消して、保存用ラインとして再描画
    traceMarkers.forEach(m => map.removeLayer(m));
    traceMarkers = [];
    if (traceLine) { map.removeLayer(traceLine); traceLine = null; }

    redrawSavedTraces();
    saveToStorage();
    showToast(getTraceKind() === 'divider' ? '区切り線を保存しました' : 'ルートを保存しました');
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
  updateModeBtn();
  document.getElementById('trace-banner').classList.remove('show');
}

function redrawSavedTraces() {
  savedTraceLines.forEach(l => map.removeLayer(l));
  savedTraceLines = [];
  savedTraces.forEach((trace, traceIdx) => {
    if (trace.kind === 'marker') {
      const pt = trace.points[0];
      const icon = L.divIcon({
        className: '',
        html: `<div class="note-marker" style="border-color:${trace.color || '#212121'}"><span class="note-ico">${trace.icon || '📌'}</span><span class="note-lbl">${escapeHtml(trace.label || '')}</span></div>`,
        iconSize: null, iconAnchor: [14, 14]
      });
      const mk = L.marker([pt.lat, pt.lng], { icon, draggable: true, zIndexOffset: 500 }).addTo(map);
      mk.bindTooltip(`📍 ${escapeHtml(trace.label || '目印')}`, { direction: 'top', offset: [0, -14] });
      mk.on('click', function(e) {           // タップで名前変更
        L.DomEvent.stopPropagation(e);
        if (traceEditMode || traceMode || reorderMode) return;
        const v = prompt('目印の名前を変更（空欄で変更なし）', trace.label || '');
        if (v === null || !v.trim()) return;
        pushUndo(); trace.label = v.trim(); trace.icon = noteIconFor(trace.label);
        redrawSavedTraces(); saveToStorage();
      });
      mk.on('contextmenu', function(e) {     // 右クリック/長押しで削除
        L.DomEvent.stopPropagation(e); L.DomEvent.preventDefault(e);
        if (confirm(`目印「${trace.label || ''}」を削除しますか？`)) {
          pushUndo(); savedTraces.splice(traceIdx, 1); redrawSavedTraces(); saveToStorage(); showToast('目印を削除しました');
        }
      });
      mk.on('dragend', function(e) {        // ドラッグで移動
        const p = e.target.getLatLng(); pushUndo(); trace.points = [{ lat: p.lat, lng: p.lng }]; saveToStorage();
      });
      mk.setStyle = function() {};          // changeTraceOpacity が setStyle を一律に呼ぶので no-op を生やす
      savedTraceLines.push(mk);
      return;
    }
    const coords = trace.points.map(p => [p.lat, p.lng]);
    const line = L.polyline(coords, traceStyleFor(trace.kind, trace.color, 6, 5)).addTo(map);
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
      if (confirm(trace.kind === 'divider' ? 'この区切り線を削除しますか？' : 'このルート線を削除しますか？')) {
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
  updateModeBtn();
  document.getElementById('btn-trace').style.display = '';
  document.getElementById('trace-edit-banner').classList.remove('show');
}


// --- ⌨ ルート線/区切り線のキーボード（PC作業用・2026-08-19） ---
// L = 開始（モード中はEnterと同じ「完了」）／ Enter = 完了 ／ Backspace・Z = 1点戻す ／ Esc = 取消
(function () {
  function isTyping(e) { return kbIsTyping(e); }
  function overlayOpen() {
    return ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal', 'legend-modal', 'submit-modal']
      .some(function (id) { var el = document.getElementById(id); return el && el.classList.contains('show'); });
  }
  document.addEventListener('keydown', function (e) {
    if (isTyping(e) || overlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (!traceMode) {
      if (k !== 'l' && k !== 'L') return;
      e.preventDefault();
      const busy = typeof activeModeName === 'function' ? activeModeName('trace') : null;
      if (busy) { showToast(`「${(typeof MODE_LABELS !== 'undefined' && MODE_LABELS[busy]) || busy}」モード中です。先に終了してください`); return; }
      toggleTraceMode();
      return;
    }
    if (k === 'l' || k === 'L' || k === 'Enter') { e.preventDefault(); finishTrace(); }
    else if (k === 'Backspace' || k === 'z' || k === 'Z') { e.preventDefault(); undoTrace(); }
    else if (k === 'Escape') { e.preventDefault(); cancelTrace(); }
  });
})();

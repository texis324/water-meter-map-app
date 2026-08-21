// --- 🎯 1箇所に集めるモード（キーボード: G） ---
// 投げ縄で囲んだピンを、その場で1点に重ねる（集合住宅の各室を建物の1点にスタックする用途）。
// 2026-08-21 Tench要望「複数のピンを一か所に集めたいとき、Gキー押して囲ったらまとまるようにしたい」
//
// 集める先の決め方:
//   囲みの中に既に団子（同一座標に2本以上）があれば、その中で一番大きい団子の位置 ＝ 建物側は動かさない
//   団子が無ければ囲んだピンの重心
// 1囲み＝1操作として pushUndo するので、↩で1囲みずつ戻せる。モードは続けて何箇所でも囲める（Enter/Esc/Gで終了）。
// 投げ縄は lasso-delete.js / multi-move.js と同型。pointInPolygon は groups.js の関数を使う。
let gatherMode = false;
let gatherPoints = [];
let gatherLine = null;
let gatherActive = false;
let gatherDoneCount = 0;

function toggleGatherMode() {
  if (gatherMode) {
    finishGather();
    return;
  }
  if (pins.length === 0) {
    showToast('ピンがありません');
    return;
  }
  exitAllOtherModes('gather');
  gatherMode = true;
  pinMode = false;
  gatherPoints = [];
  gatherActive = false;
  gatherDoneCount = 0;

  const btn = document.getElementById('btn-gather');
  if (btn) { btn.classList.add('active'); btn.textContent = '🎯 集め中...'; }
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('gather-banner').classList.add('show');
  document.getElementById('gather-count').textContent = '0';

  map.dragging.disable();
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', gatherStart);
  map.on('mousemove', gatherMove);
  map.on('mouseup', gatherEnd);
  map.on('touchstart', gatherTouchStart);
  map.on('touchmove', gatherTouchMove);
  map.on('touchend', gatherEnd);

  refreshAllMarkers();
  gatherDisableMarkerDrag();
  showToast('🎯 まとめたいピンを囲んでください（囲んだ瞬間に1箇所へ重なります）');
}

// モード中はピンをドラッグさせない（ピンの上から投げ縄を始められるように＆誤移動防止）。
// refreshAllMarkers はマーカーを draggable で作り直すので、作り直すたびに呼ぶ
function gatherDisableMarkerDrag() {
  for (const id in markers) {
    const m = markers[id];
    if (m && m.dragging) m.dragging.disable();
  }
}

function gatherStart(e) {
  if (!gatherMode) return;
  gatherActive = true;
  gatherPoints = [e.latlng];
  if (gatherLine) { map.removeLayer(gatherLine); gatherLine = null; }
}

function gatherTouchStart(e) {
  if (!gatherMode || !e.originalEvent.touches.length) return;
  const t = e.originalEvent.touches[0];
  gatherActive = true;
  gatherPoints = [map.containerPointToLatLng(L.point(t.clientX, t.clientY))];
  if (gatherLine) { map.removeLayer(gatherLine); gatherLine = null; }
}

function gatherMove(e) {
  if (!gatherActive) return;
  gatherPoints.push(e.latlng);
  if (gatherLine) gatherLine.setLatLngs(gatherPoints);
  else gatherLine = L.polyline(gatherPoints, { color: '#3949AB', weight: 2, dashArray: '5 5' }).addTo(map);
}

function gatherTouchMove(e) {
  if (!gatherActive || !e.originalEvent.touches.length) return;
  e.originalEvent.preventDefault();
  const t = e.originalEvent.touches[0];
  gatherPoints.push(map.containerPointToLatLng(L.point(t.clientX, t.clientY)));
  if (gatherLine) gatherLine.setLatLngs(gatherPoints);
  else gatherLine = L.polyline(gatherPoints, { color: '#3949AB', weight: 2, dashArray: '5 5' }).addTo(map);
}

function gatherEnd() {
  if (!gatherActive) return;
  gatherActive = false;
  const pts = gatherPoints;
  gatherPoints = [];
  if (gatherLine) { map.removeLayer(gatherLine); gatherLine = null; }
  if (pts.length < 3) return;

  const polygon = pts.map(p => [p.lat, p.lng]);
  const selected = pins.filter(pin => pointInPolygon([pin.lat, pin.lng], polygon));
  if (selected.length < 2) {
    showToast(selected.length === 0 ? '囲みの中にピンがありません' : '1本だけです。2本以上囲んでください');
    return;
  }
  gatherPinsTo(selected);
}

// 集める先を決めて selected を全部そこへ重ねる。戻り値: {lat,lng,stacked}
function gatherTarget(selected) {
  // 既存の団子（同一座標に2本以上）を探す。一番大きいものを採用（同数なら先に見つかった方）
  const byCoord = new Map();
  selected.forEach(p => {
    const k = p.lat + ',' + p.lng;
    const arr = byCoord.get(k);
    if (arr) arr.push(p); else byCoord.set(k, [p]);
  });
  let best = null;
  byCoord.forEach(arr => {
    if (arr.length >= 2 && (!best || arr.length > best.length)) best = arr;
  });
  if (best) return { lat: best[0].lat, lng: best[0].lng, stacked: best.length };
  const lat = selected.reduce((a, p) => a + p.lat, 0) / selected.length;
  const lng = selected.reduce((a, p) => a + p.lng, 0) / selected.length;
  return { lat, lng, stacked: 0 };
}

function gatherPinsTo(selected) {
  const t = gatherTarget(selected);
  const moving = selected.filter(p => p.lat !== t.lat || p.lng !== t.lng);
  if (moving.length === 0) {
    showToast(`${selected.length}本はもう同じ場所です`);
    return;
  }
  pushUndo();
  moving.forEach(p => { p.lat = t.lat; p.lng = t.lng; });
  gatherDoneCount++;
  document.getElementById('gather-count').textContent = gatherDoneCount;
  saveToStorage();
  refreshAllMarkers();
  gatherDisableMarkerDrag();
  const where = t.stacked ? `既存の団子(${t.stacked}本)の位置` : '重心';
  showToast(`🎯 ${selected.length}本を${where}に重ねました（続けて囲めます・↩で戻せます）`);
}

function finishGather() {
  const n = gatherDoneCount;
  exitGather();
  refreshAllMarkers();
  updatePinCount();
  showToast(n ? `1箇所に集める を終了（${n}箇所まとめました）` : '1箇所に集める を終了');
}

function exitGather() {
  gatherMode = false;
  gatherPoints = [];
  gatherActive = false;
  gatherDoneCount = 0;
  if (gatherLine) { map.removeLayer(gatherLine); gatherLine = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', gatherStart);
  map.off('mousemove', gatherMove);
  map.off('mouseup', gatherEnd);
  map.off('touchstart', gatherTouchStart);
  map.off('touchmove', gatherTouchMove);
  map.off('touchend', gatherEnd);

  const btn = document.getElementById('btn-gather');
  if (btn) { btn.classList.remove('active'); btn.textContent = '🎯 1箇所に集める'; }
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('gather-banner').classList.remove('show');
}

// --- ⌨ G = 開始/終了、モード中は Enter/Esc でも終了 ---
// 作法は N(並べ替え) と同じ: 入力中/モーダル中/修飾キー併用は素通し、他モード中は黙って乗っ取らずトーストで断る。
// 並べ替えのNと違い、集める操作は囲んだ瞬間に保存済みなので G をトグルにしても失う作業が無い。
(function () {
  function overlayOpen() {
    return ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal', 'legend-modal', 'submit-modal']
      .some(function (id) { var el = document.getElementById(id); return el && el.classList.contains('show'); });
  }
  document.addEventListener('keydown', function (e) {
    if (kbIsTyping(e) || overlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    const isG = (k === 'g' || k === 'G');
    if (!gatherMode) {
      if (!isG) return;
      e.preventDefault();
      const busy = typeof activeModeName === 'function' ? activeModeName('gather') : null;
      if (busy) {
        showToast(`「${(typeof MODE_LABELS !== 'undefined' && MODE_LABELS[busy]) || busy}」モード中です。先に終了してください`);
        return;
      }
      toggleGatherMode();
      return;
    }
    if (isG || k === 'Enter' || k === 'Escape') {
      e.preventDefault();
      finishGather();
    }
  });
})();

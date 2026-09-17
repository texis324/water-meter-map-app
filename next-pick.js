// --- 👆 前のピンをタップ → 次の番号のピンをここへ（ネクスト・ピック） ---
// 2026-09-17 Tench要望「この座標にピンが無いな、と気づいた時にすぐ呼び出したい。
//   呼び出す時に一つ前のピンを押すと、自動的に次のピンがそこに置かれる仕組み」
//
// 流れ: ①ピンの無い場所を右クリック→📌モーダルの「👆 前のピンをタップ」（または Shift+右クリックで直接）
//       ②置き先に目印が立つ  ③地図上の「一つ前のピン」をタップ → その次の番号のピンが目印へ移動して終了
//   ・団子（同じ座標に複数）をタップしたら「その団子の最大番号の次」＝建物の次の家
//   ・Shift+タップ は逆向き＝「その団子の最小番号の一つ前」を置く
//   ・途中で別の場所を右クリックすると置き先を変更。Esc で取消
// 「次の番号」は +1 固定ではなく、ラベル番号が基準より大きい中で最小のもの（欠番・枝番 71.2 などに対応）。
let nextPickMode = false;
let nextPickLatLng = null;
let nextPickMarker = null;

function startNextPick(latlng) {
  if (!latlng) return;
  if (pins.length === 0) { showToast('ピンがありません'); return; }
  exitAllOtherModes('nextPick');
  nextPickMode = true;
  nextPickLatLng = latlng;
  nextPickDrawTarget();
  document.getElementById('next-pick-banner').classList.add('show');
  map.getContainer().style.cursor = 'pointer';
  nextPickDisableMarkerDrag();
  showToast('👆 一つ前のピンをタップしてください（その次の番号がここに置かれます）');
}

// 📌モーダルのボタンから入る（モーダルが持っている右クリック地点を引き継ぐ）
function startNextPickFromModal() {
  const ll = quickPlaceLatLng;
  closeQuickPlace();
  startNextPick(ll);
}

function nextPickDrawTarget() {
  if (nextPickMarker) { map.removeLayer(nextPickMarker); nextPickMarker = null; }
  const icon = L.divIcon({ className: '', html: '<div class="next-pick-target">📌</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
  nextPickMarker = L.marker(nextPickLatLng, { icon, interactive: false, zIndexOffset: 2000 }).addTo(map);
}

// ピック中に別の場所を右クリック＝置き先の変更
function nextPickRetarget(latlng) {
  nextPickLatLng = latlng;
  nextPickDrawTarget();
  showToast('📌 置き先を変更しました。一つ前のピンをタップしてください');
}

function nextPickDisableMarkerDrag() {
  for (const id in markers) {
    const m = markers[id];
    if (m && m.dragging) m.dragging.disable();
  }
}

// core.js のマーカー click から呼ばれる。backward=true（Shift+タップ）で逆向き
function nextPickTap(pin, backward) {
  if (!nextPickMode || !nextPickLatLng) return;
  const same = pins.filter(p => p.lat === pin.lat && p.lng === pin.lng);
  const nums = same.map(p => getLabelNum(p.label)).filter(n => n !== null);
  if (!nums.length) { showToast('このピンには番号がありません。番号のあるピンをタップしてください'); return; }
  const numbered = pins.filter(p => getLabelNum(p.label) !== null);
  let cand = null, base;
  if (!backward) {
    base = Math.max(...nums);
    numbered.forEach(p => { const n = getLabelNum(p.label); if (n > base && (!cand || n < getLabelNum(cand.label))) cand = p; });
    if (!cand) { showToast(`#${base} の次の番号のピンがありません（これが最後です）`); return; }
  } else {
    base = Math.min(...nums);
    numbered.forEach(p => { const n = getLabelNum(p.label); if (n < base && (!cand || n > getLabelNum(cand.label))) cand = p; });
    if (!cand) { showToast(`#${base} の前の番号のピンがありません（これが最初です）`); return; }
  }
  let lat = nextPickLatLng.lat, lng = nextPickLatLng.lng;
  if (typeof snapToReference === 'function') {
    const s = snapToReference(lat, lng);
    lat = s.lat; lng = s.lng;
  }
  const from = map.distance([cand.lat, cand.lng], [lat, lng]);
  const fromTxt = from >= 1000 ? (from / 1000).toFixed(1) + 'km' : Math.round(from) + 'm';
  pushUndo();
  cand.lat = lat;
  cand.lng = lng;
  const n = getLabelNum(cand.label);
  const name = stripLabelNum(cand.label).slice(0, 16);
  exitNextPick();
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast(`📌 #${base} の${backward ? '前' : '次'} → #${n} ${name} をここに移動しました（${fromTxt}先から・↩で戻せます）`);
}

function cancelNextPick(silent) {
  if (!nextPickMode) return;
  exitNextPick();
  refreshAllMarkers();
  if (!silent) showToast('👆 前のピンをタップ を取り消しました');
}

function exitNextPick() {
  nextPickMode = false;
  nextPickLatLng = null;
  if (nextPickMarker) { map.removeLayer(nextPickMarker); nextPickMarker = null; }
  map.getContainer().style.cursor = '';
  const b = document.getElementById('next-pick-banner');
  if (b) b.classList.remove('show');
}

// Esc で取消
document.addEventListener('keydown', function (e) {
  if (!nextPickMode || e.key !== 'Escape') return;
  e.preventDefault();
  cancelNextPick();
});

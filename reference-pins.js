// reference-pins.js
// リファレンス（薄）ピンレイヤー + 磁石スナップ機能
//
// 用途: 過去のJSON（位置が手動修正済みで信頼できる）を読み専レイヤーとして表示し、
//       新規ピン追加・既存ピンドラッグ時に最寄りのリファレンスピンへスナップする。
// 永続化: localStorage キー 'waterMeterReferencePins'

let referencePins = [];           // [{id, lat, lng, label}]
let referenceMarkerLayer = null;  // L.LayerGroup
let snapEnabled = true;           // スナップON/OFF
const SNAP_THRESHOLD_METERS = 20; // この距離内なら吸着

// --- 距離計算（Haversine） ---
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// --- レイヤー初期化 ---
function ensureReferenceLayer() {
  if (!referenceMarkerLayer) {
    referenceMarkerLayer = L.layerGroup().addTo(map);
  }
  return referenceMarkerLayer;
}

// --- 薄ピン用アイコン ---
function createReferenceIcon(label) {
  const text = (label || '').slice(0, 6);
  return L.divIcon({
    className: 'reference-pin',
    html: `<div style="
      width:18px;height:18px;border-radius:50%;
      background:rgba(150,150,150,0.35);
      border:1.5px dashed rgba(80,80,80,0.55);
      display:flex;align-items:center;justify-content:center;
      font-size:9px;color:rgba(40,40,40,0.7);font-weight:600;
      pointer-events:none;
    ">${text}</div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9]
  });
}

// --- ロード（JSONデータ or pins配列 を受ける） ---
function loadReferencePins(data) {
  const pinArr = Array.isArray(data) ? data : (data && data.pins) || [];
  referencePins = pinArr.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    label: p.label || ''
  })).filter(p => typeof p.lat === 'number' && typeof p.lng === 'number');

  const layer = ensureReferenceLayer();
  layer.clearLayers();
  referencePins.forEach(p => {
    const m = L.marker([p.lat, p.lng], {
      icon: createReferenceIcon(p.label),
      interactive: false,
      keyboard: false,
      zIndexOffset: -1000
    });
    layer.addLayer(m);
  });

  saveReferenceToStorage();
  updateReferenceUI();
  if (typeof showToast === 'function') showToast(`参照ピン${referencePins.length}件を読み込みました`);
}

function clearReferencePins() {
  referencePins = [];
  if (referenceMarkerLayer) referenceMarkerLayer.clearLayers();
  saveReferenceToStorage();
  updateReferenceUI();
  if (typeof showToast === 'function') showToast('参照ピンをクリアしました');
}

// --- 検索 ---
function findNearestReference(lat, lng, thresholdMeters) {
  if (!referencePins.length) return null;
  const threshold = thresholdMeters != null ? thresholdMeters : SNAP_THRESHOLD_METERS;
  let best = null, bestDist = Infinity;
  for (const p of referencePins) {
    const d = haversineMeters(lat, lng, p.lat, p.lng);
    if (d < bestDist && d <= threshold) {
      best = p; bestDist = d;
    }
  }
  return best ? { pin: best, distance: bestDist } : null;
}

// --- 公開API: 座標をスナップ後の座標に変換（スナップ無効・該当なしなら元のまま） ---
function snapToReference(lat, lng) {
  if (!snapEnabled) return { lat, lng, snapped: false };
  const hit = findNearestReference(lat, lng);
  if (!hit) return { lat, lng, snapped: false };
  // ビジュアルフィードバック
  flashReferencePin(hit.pin);
  return { lat: hit.pin.lat, lng: hit.pin.lng, snapped: true, distance: hit.distance };
}

// --- 一瞬光らせる ---
function flashReferencePin(pin) {
  const flash = L.circleMarker([pin.lat, pin.lng], {
    radius: 18,
    color: '#FFC107',
    weight: 3,
    fill: false,
    interactive: false
  }).addTo(map);
  setTimeout(() => map.removeLayer(flash), 600);
}

// --- localStorage 永続化 ---
function saveReferenceToStorage() {
  try {
    localStorage.setItem('waterMeterReferencePins', JSON.stringify(referencePins));
    localStorage.setItem('waterMeterSnapEnabled', snapEnabled ? '1' : '0');
  } catch(e) { console.error('参照ピン保存エラー', e); }
}
function loadReferenceFromStorage() {
  try {
    const raw = localStorage.getItem('waterMeterReferencePins');
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        loadReferencePins(arr);
      }
    }
    const se = localStorage.getItem('waterMeterSnapEnabled');
    if (se !== null) {
      snapEnabled = (se === '1');
      updateReferenceUI();
    }
  } catch(e) { console.error('参照ピン復元エラー', e); }
}

// --- UI: ボタン状態更新 ---
function updateReferenceUI() {
  const snapBtn = document.getElementById('btn-snap');
  if (snapBtn) {
    snapBtn.textContent = snapEnabled ? '🧲 スナップON' : '🧲 スナップOFF';
    snapBtn.classList.toggle('active', snapEnabled);
  }
  const countEl = document.getElementById('reference-count');
  if (countEl) countEl.textContent = referencePins.length ? `参照${referencePins.length}件` : '';
}

function toggleSnap() {
  snapEnabled = !snapEnabled;
  saveReferenceToStorage();
  updateReferenceUI();
  if (typeof showToast === 'function') showToast(`スナップ${snapEnabled ? 'ON' : 'OFF'}`);
}

// --- ファイル読込 ---
function importReferenceData() {
  document.getElementById('reference-file-input').click();
}
function handleReferenceImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      loadReferencePins(data);
    } catch(err) {
      alert('参照ピンファイルの読み込みに失敗しました: ' + err.message);
    }
  };
  reader.readAsText(file);
  event.target.value = '';  // 再選択可
}

// 初期化（DOM読み込み後）
window.addEventListener('DOMContentLoaded', loadReferenceFromStorage);

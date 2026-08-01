// --- 建物名・住所 検索（Maps JavaScript API の Geocoder を使用） ---
// REST Geocoding はリファラー制限キーで弾かれるが、JS API の Geocoder はクライアント型なので
// 同じリファラー制限キーで動く（要: GCPで Maps JavaScript API を有効化）。

let _geocoder = null;
let _mapsApiLoading = null;
let searchResultMarker = null;

// Maps JS API を初回検索時に動的ロード（キーは routes.js の GOOGLE_API_KEY を共用）
function loadMapsApi() {
  if (window.google && window.google.maps) return Promise.resolve();
  if (_mapsApiLoading) return _mapsApiLoading;
  _mapsApiLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_API_KEY}&language=ja&region=JP&loading=async`;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Maps JS API load failed'));
    document.head.appendChild(s);
  });
  return _mapsApiLoading;
}

async function doGeoSearch() {
  const input = document.getElementById('search-input');
  const q = input.value.trim();
  if (!q) return;
  try {
    await loadMapsApi();
  } catch (e) {
    showToast('地図検索の準備に失敗（Maps JS APIの有効化を確認）');
    return;
  }
  if (!_geocoder) _geocoder = new google.maps.Geocoder();
  // 県市が含まれてなければ伊勢市を自動補完
  const query = /三重県|伊勢市/.test(q) ? q : ('三重県伊勢市 ' + q);
  showToast('検索中…');
  try {
    const { results } = await _geocoder.geocode({ address: query });
    if (!results || !results.length) { showToast('見つかりませんでした: ' + q); return; }
    const g = results[0];
    const lat = g.geometry.location.lat();
    const lng = g.geometry.location.lng();
    const lt = g.geometry.location_type;
    map.setView([lat, lng], 18);
    if (searchResultMarker) map.removeLayer(searchResultMarker);
    const icon = L.divIcon({ className: 'search-result-pin', html: '<div class="srp-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
    searchResultMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(map);
    const precJp = { ROOFTOP: '建物特定 ✓', RANGE_INTERPOLATED: '番地補間 ✓', GEOMETRIC_CENTER: '区画中心', APPROXIMATE: '⚠町域代表(精度低)' }[lt] || lt;
    searchResultMarker.bindPopup(
      `<b>${q}</b><br>${g.formatted_address}<br>精度: ${precJp}<br>` +
      `<button onclick="addPinAtSearch(${lat},${lng})" style="margin-top:6px;padding:5px 12px;border:none;border-radius:4px;background:#1976D2;color:#fff;font-weight:bold;cursor:pointer;">📍 ここに新規ピン</button>`
    ).openPopup();
  } catch (e) {
    showToast('検索エラー: ' + (e.message || e));
  }
}

function addPinAtSearch(lat, lng) {
  const label = document.getElementById('search-input').value.trim();
  // 色は空＝既定の青（明示指定すると凡例・始点ハイライトの「色なし」判定から外れる）
  addPin(lat, lng, label, '', null, { color: '' });
  saveToStorage();
  showToast('ピンを追加: ' + label);
  if (searchResultMarker) { map.removeLayer(searchResultMarker); searchResultMarker = null; }
}

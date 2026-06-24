// --- 状態管理 ---
let pins = [];           // { id, lat, lng, label, memo, group? }
let pinMode = true;      // ピン追加モード
let markers = {};        // id -> L.marker
let editingPinId = null;
let routeLine = null; // legacy, kept for import compatibility
let nextId = 1;
let _bulkLoading = false; // 一括読み込み中はsaveToStorage抑制
let pinListOpen = false;  // ピン一覧パネルの開閉状態
// localStorage に保存済みなら復元、未保存なら true 既定
let highlightEndpoints = (localStorage.getItem('waterMeterHighlightEndpoints') ?? 'true') === 'true';
let isDark = localStorage.getItem('waterMeterDark') === 'true';

// グループ囲み管理
let pinGroups = [];       // [{ id, name, pinIds: [...] }, ...]

// Undo/Redoシステム
let undoStack = [];
let redoStack = [];
const MAX_UNDO = 30;

function pushUndo() {
  undoStack.push(JSON.stringify({ pins, pinGroups, savedTraces }));
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack = []; // 新しい操作をしたらredoは消す
}

function performUndo() {
  if (undoStack.length === 0) {
    showToast('やり直す操作がありません');
    return;
  }
  // 現在の状態をredoスタックに保存
  redoStack.push(JSON.stringify({ pins, pinGroups, savedTraces }));
  if (redoStack.length > MAX_UNDO) redoStack.shift();

  const state = JSON.parse(undoStack.pop());
  for (const id in markers) map.removeLayer(markers[id]);
  markers = {};
  pins = state.pins || [];
  pinGroups = state.pinGroups || [];
  if (state.savedTraces !== undefined) {
    savedTraces = state.savedTraces;
    redrawSavedTraces();
  }
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast('元に戻しました');
}

function performRedo() {
  if (redoStack.length === 0) {
    showToast('やり直す操作がありません');
    return;
  }
  // 現在の状態をundoスタックに保存
  undoStack.push(JSON.stringify({ pins, pinGroups, savedTraces }));
  if (undoStack.length > MAX_UNDO) undoStack.shift();

  const state = JSON.parse(redoStack.pop());
  for (const id in markers) map.removeLayer(markers[id]);
  markers = {};
  pins = state.pins || [];
  pinGroups = state.pinGroups || [];
  if (state.savedTraces !== undefined) {
    savedTraces = state.savedTraces;
    redrawSavedTraces();
  }
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast('やり直しました');
}

// --- モード排他制御 ---
// 排他モード一覧: 同時にONになれない（一つONにすると他は強制OFF）
// reorderSwapMode は reorderMode のサブモードなので除外
// pinMode は他モードがOFFの時の暗黙的なデフォルトなので除外
function exitAllOtherModes(exceptName) {
  const modes = [
    { name: 'stamp',        flag: () => typeof stampMode !== 'undefined' && stampMode,                 exit: () => finishStampMode() },
    { name: 'reorder',      flag: () => typeof reorderMode !== 'undefined' && reorderMode,             exit: () => cancelReorder() },
    { name: 'traceReorder', flag: () => typeof traceReorderMode !== 'undefined' && traceReorderMode,   exit: () => cancelTraceReorder() },
    { name: 'concat',       flag: () => typeof concatMode !== 'undefined' && concatMode,               exit: () => cancelConcat() },
    { name: 'group',        flag: () => typeof groupMode !== 'undefined' && groupMode,                 exit: () => cancelGroupMode() },
    { name: 'trace',        flag: () => typeof traceMode !== 'undefined' && traceMode,                 exit: () => finishTrace() },
    { name: 'traceEdit',    flag: () => typeof traceEditMode !== 'undefined' && traceEditMode,         exit: () => cancelTraceEdit() },
    { name: 'lassoDelete',  flag: () => typeof lassoDeleteMode !== 'undefined' && lassoDeleteMode,     exit: () => cancelLassoDeleteMode() },
  ];
  modes.forEach(m => {
    if (m.name === exceptName) return;
    try {
      if (m.flag()) m.exit();
    } catch(e) {
      console.warn(`[exitAllOtherModes] ${m.name} exit failed:`, e);
    }
  });
}

// なぞりルート関連
let traceMode = false;
let tracePoints = [];
let traceLine = null;
let traceMarkers = [];
let savedTraces = [];
let savedTraceLines = [];

// ルート編集関連
let traceEditMode = false;
let traceEditIdx = -1;
let traceEditPoints = [];
let traceEditLine = null;
let traceEditMarkers = [];
let traceEditMidMarkers = [];
let traceEditOriginal = null;

// --- 地図初期化 ---
const map = L.map('map', {
  zoomControl: true,
  attributionControl: false,
  doubleClickZoom: false
}).setView([34.4917, 136.7090], 14); // デフォルト: 伊勢市中心部（位置情報が取れない環境向け）

const tiles = {
  light: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', { maxZoom: 21, maxNativeZoom: 19 }),
  dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 21, maxNativeZoom: 19 }),
  satellite: L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 22, maxNativeZoom: 20 })
};
const tileNames = ['light', 'dark', 'satellite'];
const tileLabels = { light: '🗺️', dark: '🌙', satellite: '🛰️' };
let currentTile = localStorage.getItem('waterMeterTile') || 'light';

// 起動時のテーマ適用
function applyTile() {
  tileNames.forEach(name => { if (map.hasLayer(tiles[name])) map.removeLayer(tiles[name]); });
  tiles[currentTile].addTo(map);
  document.body.classList.toggle('dark', currentTile !== 'light');
  document.getElementById('btn-dark').textContent = tileLabels[currentTile];
  localStorage.setItem('waterMeterTile', currentTile);
}
applyTile();

function toggleDark() {
  const idx = tileNames.indexOf(currentTile);
  currentTile = tileNames[(idx + 1) % tileNames.length];
  applyTile();
}

// 起動時にローカルストレージから復元
loadFromStorage();

// ピンがなければ現在地に移動（ピンがあればfitBoundsで表示済み）
if (pins.length === 0 && navigator.geolocation) {
  navigator.geolocation.getCurrentPosition(pos => {
    map.setView([pos.coords.latitude, pos.coords.longitude], 16);
  });
}

// --- 地図タップ ---
map.on('click', function(e) {
  if (traceEditMode) return;
  if (traceMode) {
    handleTraceTap(e.latlng);
    return;
  }
  if (stampMode) {
    handleStampTap(e.latlng);
    return;
  }
  if (!pinMode) {
    // 閲覧モード: クリック地点の住所を表示
    reverseGeocode(e.latlng.lat, e.latlng.lng);
    return;
  }
  // 参照ピンへ磁石スナップ
  const snapped = (typeof snapToReference === 'function') ? snapToReference(e.latlng.lat, e.latlng.lng) : { lat: e.latlng.lat, lng: e.latlng.lng };
  addPin(snapped.lat, snapped.lng, '', '');
});

// reverseGeocode, callPinHere, moveSinglePin, moveMatchedPins → geocode.js

// 地図右クリック: 並べ替え中・なぞり中にピン追加
map.on('contextmenu', function(e) {
  if (reorderMode || traceReorderMode) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    // ピンデータだけ作成（マーカーはrefreshReorderMarkersに任せる）
    const pinId = nextId++;
    const pin = { id: pinId, lat: e.latlng.lat, lng: e.latlng.lng, label: '', memo: '', group: [] };
    pins.push(pin);
    updatePinCount();
    saveToStorage();

    if (reorderMode && reorderAnchorSet) {
      // 並べ替え済みリストに直接追加
      reorderedPins.push(pin);
      updateReorderCount();
      refreshReorderMarkers();
      const num = getReorderStartNum() + reorderedPins.length - 1;
      showToast(`ピンを追加 → ${num}番に配置`);
    } else {
      // アンカー未設定 or なぞり中: 未処理リストに追加
      remainingPins.push(pin);
      refreshReorderMarkers();
      showToast('ピンを追加しました');
    }
  }
});

// 地図ダブルクリック: Googleストリートビューを開く
map.on('dblclick', function(e) {
  L.DomEvent.stopPropagation(e);
  L.DomEvent.preventDefault(e);
  if (reorderMode || groupMode || traceMode) return;
  const lat = e.latlng.lat.toFixed(6);
  const lng = e.latlng.lng.toFixed(6);
  const url = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
  window.open(url, '_blank');
  showToast('ストリートビューを開きます');
});

// --- ピン追加 ---
function addPin(lat, lng, label, memo, id, extra) {
  let pinId = id || nextId++;
  if (!id && pinId >= nextId) nextId = pinId + 1;
  if (id && pinId >= nextId) nextId = pinId + 1;

  // ID衝突チェック: 既存pinまたはmarkerと同IDの場合、新規IDを払い出す
  if (markers[pinId] || pins.some(p => p.id === pinId)) {
    console.warn(`[addPin] ID衝突検出: ${pinId} → 新規ID払い出し`);
    const oldId = pinId;
    pinId = nextId++;
    if (id) {
      // 元のidが指定されてた = 復元ケース。衝突時のみログ
      console.warn(`  復元時の衝突: 旧id=${oldId} → 新id=${pinId}`);
    }
  }

  const pin = { id: pinId, lat, lng, label: label || '', memo: memo || '', group: [] };
  // extraで追加プロパティ（color, groupなど）を復元
  if (extra) {
    Object.assign(pin, extra);
    // idはOverrideしない（衝突回避で振り直した場合があるため）
    pin.id = pinId;
  }
  pins.push(pin);

  const marker = createMarker(pin);
  markers[pinId] = marker;

  updatePinCount();
  if (!_bulkLoading) saveToStorage();
}

function getPinSize() {
  return parseInt(document.getElementById('pin-size-slider')?.value || 20);
}

function createMarker(pin) {
  const displayNum = getDisplayNumber(pin);
  const sz = getPinSize();
  const inGroup = pinGroups.some(g => g.pinIds.includes(pin.id));
  const collapsedGrp = pinGroups.find(g => g.collapsed && g.pinIds[0] === pin.id);
  const hasOldGroup = pin.group && pin.group.length;
  const classes = [
    'pin-icon',
    pin.memo ? 'has-memo' : '',
    (inGroup || hasOldGroup) ? 'has-group' : ''
  ].filter(Boolean).join(' ');
  // 縮小グループの代表ピン: バッジに件数表示
  // 同一座標の重複件数バッジ
  const dupeCount = pins.filter(p => p.lat === pin.lat && p.lng === pin.lng).length;
  let badge = '';
  if (collapsedGrp) {
    badge = `<span class="group-badge">${collapsedGrp.pinIds.length}</span>`;
  } else if (hasOldGroup) {
    badge = `<span class="group-badge">${pin.group.length + 1}</span>`;
  } else if (dupeCount > 1) {
    badge = `<span class="group-badge dupe-badge">${dupeCount}</span>`;
  }
  // カスタムカラー: pin.colorがあればCSSクラスの色を上書き
  // 始点ハイライト（カスタムカラー未設定時・1番目だけ緑）
  let autoColor = '';
  if (!pin.color && highlightEndpoints) {
    if (displayNum === 1) {
      autoColor = 'background:#4CAF50 !important;';
    }
  }
  const colorStyle = pin.color ? `background:${pin.color} !important;` : autoColor;
  const icon = L.divIcon({
    className: '',
    html: `<div class="${classes}" style="position:relative;${colorStyle}">${displayNum}${badge}</div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz/2, sz/2]
  });

  const marker = L.marker([pin.lat, pin.lng], {
    icon: icon,
    draggable: true
  }).addTo(map);

  // ホバーでラベル表示（ツールチップ）
  {
    const sameLoc = pins.filter(p => p.lat === pin.lat && p.lng === pin.lng);
    const dupeCount = sameLoc.length;
    const labelText = stripLabelNum(pin.label) || `ピン #${displayNum}`;
    let tooltipHtml = `<b>#${displayNum} ${escapeHtml(labelText)}</b>`;
    if (pin.memo) tooltipHtml += `<br><span style="color:#666">${escapeHtml(pin.memo)}</span>`;
    if (dupeCount > 1) {
      // 同じ座標のピンのラベルから番地部分を抽出して比較
      const getBanchi = lbl => { const m = lbl.match(/[０-９0-9－\-]+/g); return m ? m.join('') : ''; };
      const myBanchi = getBanchi(labelText);
      const diffBanchi = sameLoc.some(p => p.id !== pin.id && getBanchi(p.label || '') !== myBanchi);
      if (diffBanchi) {
        tooltipHtml += `<br><span style="color:#e53935;font-weight:bold">⚠️ ${dupeCount}件重複（異番地あり！要修正）</span>`;
      } else {
        tooltipHtml += `<br><span style="color:#FF9800;font-weight:bold">📍 ${dupeCount}件重複（同番地）</span>`;
      }
    }
    marker.bindTooltip(tooltipHtml, { direction: 'top', offset: [0, -sz/2], className: 'pin-tooltip' });
  }

  // クリック: タイマーでシングル/ダブルを区別
  let clickTimer = null;
  marker.on('click', function(e) {
    L.DomEvent.stopPropagation(e);
    if (stampMode) {
      // スタンプモード: 既存ピンクリックで起点変更
      const m = (pin.label || '').match(/^(\d+)\./);
      if (m) {
        stampNum = parseInt(m[1]) + 1;
        updateStampDisplay();
        showToast(`#${parseInt(m[1])} の次 → #${stampNum} から配置`);
      }
      return;
    }
    if (concatMode) {
      handleConcatTap(pin.id);
      return;
    }
    if (reorderMode) {
      handleReorderTap(pin.id);
      return;
    }

    if (groupMode) {
      handleGroupTap(pin.id);
      return;
    }
    if (clickTimer) {
      // ダブルクリック: 同一座標のマーカーを全消去
      clearTimeout(clickTimer);
      clickTimer = null;
      const dupes = pins.filter(p => p.lat === pin.lat && p.lng === pin.lng);
      if (dupes.length < 2) {
        showToast('重複なし');
        return;
      }
      pushUndo();
      dupes.forEach(p => {
        if (markers[p.id]) { map.removeLayer(markers[p.id]); delete markers[p.id]; }
        const idx = pins.indexOf(p);
        if (idx !== -1) pins.splice(idx, 1);
      });
      refreshAllMarkers();
      saveToStorage();
      updatePinCount();
      showToast(`${dupes.length}件削除しました`);
    } else {
      // シングルクリック: 少し待ってから削除
      clickTimer = setTimeout(() => {
        clickTimer = null;
        if (!pins.includes(pin)) return;
        // モード切替後にタイマーが発火して誤削除するのを防ぐ
        if (stampMode || concatMode || reorderMode || reorderSwapMode || groupMode ||
            traceMode || traceEditMode || traceReorderMode || lassoDeleteMode) return;
        pushUndo();
        map.removeLayer(markers[pin.id]);
        delete markers[pin.id];
        pins.splice(pins.indexOf(pin), 1);
        refreshAllMarkers();
        saveToStorage();
        updatePinCount();
        showToast('削除しました');
      }, 300);
    }
  });

  // ダブルクリック: グループの展開/縮小、または同一座標全消去
  marker.on('dblclick', function(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    if (reorderMode || groupMode) return;
    // グループ所属ピンの場合、展開/縮小をトグル
    const grp = pinGroups.find(g => g.pinIds.includes(pin.id));
    if (grp) {
      toggleGroupCollapse(grp.id);
    }
  });

  // 右クリック: 詳細モーダル表示
  marker.on('contextmenu', function(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    if (reorderMode) return;
    openModal(pin.id);
  });

  // ドラッグで位置修正
  marker.on('dragend', function(e) {
    let pos = e.target.getLatLng();
    // 参照ピンへ磁石スナップ
    if (typeof snapToReference === 'function') {
      const snapped = snapToReference(pos.lat, pos.lng);
      if (snapped.snapped) {
        pos = L.latLng(snapped.lat, snapped.lng);
        e.target.setLatLng(pos);
      }
    }
    pin.lat = pos.lat;
    pin.lng = pos.lng;
    // スタンプモード中: ドラッグしたピンの番号を起点にする
    if (stampMode) {
      const m = (pin.label || '').match(/^(\d+)\./);
      if (m) {
        stampNum = parseInt(m[1]) + 1;
        updateStampDisplay();
        showToast(`#${parseInt(m[1])} を移動 → 次は #${stampNum}`);
      }
    }
    // 重複バッジ・ツールチップを再計算するため全マーカー再構築
    refreshAllMarkers();
    saveToStorage();
    if (!stampMode) showToast('位置を更新しました');
  });

  return marker;
}

// --- モーダル ---
// カラープリセット
const pinColorPresets = ['#1976D2','#E65100','#4CAF50','#9C27B0','#f44336','#FF9800','#00BCD4','#795548','#607D8B','#E91E63'];

function renderColorPresets(activeColor) {
  const container = document.getElementById('color-presets');
  container.innerHTML = '';
  pinColorPresets.forEach(c => {
    const dot = document.createElement('div');
    dot.style.cssText = `width:22px;height:22px;border-radius:50%;background:${c};cursor:pointer;border:2px solid ${c === activeColor ? '#333' : 'transparent'};box-shadow:0 1px 3px rgba(0,0,0,0.3);`;
    dot.onclick = () => {
      document.getElementById('pin-color').value = c;
      renderColorPresets(c);
    };
    container.appendChild(dot);
  });
}

function clearPinColor() {
  document.getElementById('pin-color').value = '#1976D2';
  renderColorPresets('');
}

function openModal(pinId) {
  editingPinId = pinId;
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;

  document.getElementById('pin-label').value = pin.label;
  document.getElementById('pin-memo').value = pin.memo;
  document.getElementById('pin-color').value = pin.color || '#1976D2';
  renderColorPresets(pin.color || '');
  document.getElementById('modal-title').textContent = `ピン #${pins.indexOf(pin) + 1}`;
  renderGroupItems(pin.group || []);
  document.getElementById('pin-modal').classList.add('show');
}

function renderGroupItems(group) {
  const container = document.getElementById('group-items');
  container.innerHTML = '';
  group.forEach((item, i) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;gap:4px;margin-bottom:3px;align-items:center;';
    div.innerHTML = `<input type="text" class="group-label" value="${(item.label||'').replace(/"/g,'&quot;')}" placeholder="名前" style="flex:1;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px;"><button onclick="removeGroupItem(${i})" style="padding:2px 6px;border:none;border-radius:4px;background:#f44336;color:white;font-size:11px;cursor:pointer;">✕</button>`;
    container.appendChild(div);
  });
}

function addGroupItem() {
  const container = document.getElementById('group-items');
  const items = container.querySelectorAll('.group-label');
  const group = Array.from(items).map(el => ({ label: el.value }));
  group.push({ label: '' });
  renderGroupItems(group);
  // 最後の入力欄にフォーカス（モバイルではソフトキーボード裏に隠れないよう中央へスクロール）
  setTimeout(() => {
    const inputs = container.querySelectorAll('.group-label');
    if (inputs.length) {
      const last = inputs[inputs.length - 1];
      last.focus();
      if (last.scrollIntoView) last.scrollIntoView({ block: 'center' });
    }
  }, 50);
}

function removeGroupItem(idx) {
  const container = document.getElementById('group-items');
  const items = container.querySelectorAll('.group-label');
  const group = Array.from(items).map(el => ({ label: el.value }));
  group.splice(idx, 1);
  renderGroupItems(group);
}

function getGroupFromModal() {
  const items = document.getElementById('group-items').querySelectorAll('.group-label');
  return Array.from(items).map(el => ({ label: el.value.trim() })).filter(g => g.label);
}

function closeModal() {
  document.getElementById('pin-modal').classList.remove('show');
  editingPinId = null;
}

function savePin() {
  const pin = pins.find(p => p.id === editingPinId);
  if (!pin) return;

  pin.label = document.getElementById('pin-label').value.trim();
  pin.memo = document.getElementById('pin-memo').value.trim();
  const selectedColor = document.getElementById('pin-color').value;
  pin.color = (selectedColor && selectedColor !== '#1976D2') ? selectedColor : '';
  pin.group = getGroupFromModal();

  // マーカー更新
  map.removeLayer(markers[pin.id]);
  markers[pin.id] = createMarker(pin);

  saveToStorage();
  if (pinListOpen) renderPinList();
  closeModal();
  showToast('保存しました');
}

function deletePin() {
  const idx = pins.findIndex(p => p.id === editingPinId);
  if (idx === -1) return;
  pushUndo();
  map.removeLayer(markers[editingPinId]);
  delete markers[editingPinId];
  pins.splice(idx, 1);

  // 番号を振り直す
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  closeModal();
  showToast('削除しました');
}

// --- モード切替 ---
function toggleMode() {
  pinMode = !pinMode;
  const btn = document.getElementById('btn-mode');
  if (pinMode) {
    btn.textContent = '📍 ピン追加モード';
    btn.classList.add('active');
  } else {
    btn.textContent = '🔒 閲覧モード';
    btn.classList.remove('active');
  }
}

// --- マーカー全更新 ---
function refreshAllMarkers() {
  for (const id in markers) {
    map.removeLayer(markers[id]);
  }
  markers = {};
  pins.forEach(pin => {
    if (isHiddenByGroup(pin)) return; // 縮小グループの非代表ピンは非表示
    markers[pin.id] = createMarker(pin);
  });
  drawGroupCircles();
}

// --- UI ---
function updatePinCount() {
  document.getElementById('pin-count').textContent = pins.length + '件';
  if (pinListOpen) renderPinList();
  if (window.refreshMapLegend) window.refreshMapLegend();
}

function changePinSize(val) {
  const sz = parseInt(val);
  const fontSize = Math.max(7, Math.round(sz * 0.45));
  document.documentElement.style.setProperty('--pin-size', sz + 'px');
  document.documentElement.style.setProperty('--pin-font', fontSize + 'px');
  localStorage.setItem('waterMeterPinSize', sz);
  // Rebuild all markers with new iconSize/anchor
  if (!reorderMode) refreshAllMarkers();
  else refreshReorderMarkers();
}

// Restore saved pin size
// 保存値があれば反映、無くてもHTML初期値依存を断ち切るためDOMから読み戻して
// 既存oninputハンドラ(changePinSize)経由でJS側へ同期する
(function() {
  const slider = document.getElementById('pin-size-slider');
  if (!slider) return;
  const saved = localStorage.getItem('waterMeterPinSize');
  if (saved) slider.value = saved;
  // dispatchEventで既存のoninputハンドラに同期処理を委ねる
  slider.dispatchEvent(new Event('input', { bubbles: true }));
})();

// Restore saved trace opacity
// localStorageにキー waterMeterTraceOpacity を導入。既存値がなくても
// DOM初期値から既存ハンドラ経由でJS側に同期させる
(function() {
  const slider = document.getElementById('trace-opacity-slider');
  if (!slider) return;
  const saved = localStorage.getItem('waterMeterTraceOpacity');
  if (saved) slider.value = saved;
  slider.dispatchEvent(new Event('input', { bubbles: true }));
})();

// 始点・終点ハイライトボタンの初期同期: HTMLの class="active" 依存を排除
syncEndpointsButton();

// --- ヘルプ表示 ---
function toggleHelp() {
  const modal = document.getElementById('help-modal');
  modal.classList.toggle('show');
}

// --- ピン一覧パネル ---
// pinListOpen は先頭で定義済み

function togglePinList() {
  pinListOpen = !pinListOpen;
  const panel = document.getElementById('pin-list-panel');
  const btn = document.getElementById('btn-list');
  if (pinListOpen) {
    panel.classList.add('show');
    btn.classList.add('active');
    renderPinList();
  } else {
    panel.classList.remove('show');
    btn.classList.remove('active');
  }
}

function renderPinList() {
  const container = document.getElementById('pin-list-items');
  const searchInput = document.getElementById('pin-list-search');
  const query = (searchInput?.value || '').trim().toLowerCase();

  let html = '';
  const sortedPins = [...pins].sort((a, b) => {
    const aMatch = (a.label || '').match(/^(\d+)\./);
    const bMatch = (b.label || '').match(/^(\d+)\./);
    const aNum = aMatch ? parseInt(aMatch[1]) : Infinity;
    const bNum = bMatch ? parseInt(bMatch[1]) : Infinity;
    return aNum - bNum;
  });
  sortedPins.forEach((pin, i) => {
    const labelMatch = (pin.label || '').match(/^(\d+)\./);
    const num = labelMatch ? parseInt(labelMatch[1]) : i + 1;
    const label = pin.label || '';
    const memo = pin.memo || '';
    const numStr = String(num);

    // 検索フィルタ
    if (query && !label.toLowerCase().includes(query) && !memo.toLowerCase().includes(query) && !numStr.includes(query)) {
      return;
    }

    const hasMemo = memo ? ' has-memo' : '';
    const displayLabel = stripLabelNum(label) || `ピン #${num}`;
    const memoLine = memo ? `<div class="pin-list-memo">${escapeHtml(memo)}</div>` : '';
    const coords = `${pin.lat.toFixed(6)}, ${pin.lng.toFixed(6)}`;
    const numStyle = pin.color ? `background:${pin.color}` : '';

    html += `<div class="pin-list-item" onclick="focusPin(${pin.id})" title="${escapeHtml(label)}">
      <div class="pin-list-num${hasMemo}" style="${numStyle}">${num}</div>
      <div class="pin-list-info">
        <div class="pin-list-label">${escapeHtml(displayLabel)}</div>
        ${memoLine}
        <div class="pin-list-coords">${coords}</div>
      </div>
    </div>`;
  });

  if (!html) {
    html = '<div style="text-align:center;color:#999;padding:20px;font-size:13px;">該当なし</div>';
  }

  container.innerHTML = html;
  document.getElementById('pin-list-total').textContent = pins.length;
}

function sortPinsByLabel() {
  if (pins.length === 0) return;
  pushUndo();
  pins.sort((a, b) => {
    const aMatch = (a.label || '').match(/^(\d+)\./);
    const bMatch = (b.label || '').match(/^(\d+)\./);
    const aNum = aMatch ? parseInt(aMatch[1]) : Infinity;
    const bNum = bMatch ? parseInt(bMatch[1]) : Infinity;
    return aNum - bNum;
  });
  saveToStorage();
  renderPinList();
  showToast('ラベル番号順に整列しました');
}

function focusPin(pinId) {
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;
  const targetZoom = Math.max(map.getZoom(), 18);
  // パネルが開いてる場合、パネル幅の半分だけ左にオフセットして見える範囲の中央に表示
  const panelOffset = pinListOpen ? 160 : 0;
  const point = map.project([pin.lat, pin.lng], targetZoom);
  point.x += panelOffset;
  const adjusted = map.unproject(point, targetZoom);
  map.setView(adjusted, targetZoom);
  // マーカーを一瞬ハイライト
  const marker = markers[pinId];
  if (marker) {
    const el = marker.getElement();
    if (el) {
      el.style.transition = 'transform 0.2s';
      el.style.transform = 'scale(1.5)';
      setTimeout(() => { el.style.transform = ''; }, 600);
    }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ラベルから先頭の番号部分を除去（例: "66. 伊勢市..." → "伊勢市..."）
function stripLabelNum(label) {
  return (label || '').replace(/^\d+\.\s*/, '');
}

// 範囲削除モード → lasso-delete.js

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- 欠番検出 ---
function checkMissingNumbers() {
  // ラベルの先頭番号を抽出
  const nums = pins.map(p => {
    const m = (p.label || '').match(/^(\d+)\./);
    return m ? parseInt(m[1]) : null;
  }).filter(n => n !== null);

  if (nums.length === 0) {
    showToast('番号付きピンがありません');
    return;
  }

  const max = Math.max(...nums);
  const numSet = new Set(nums);
  const missing = [];
  for (let i = 1; i <= max; i++) {
    if (!numSet.has(i)) missing.push(i);
  }

  // 欠番の前後ピンを特定して、間に入るべき位置をわかりやすく表示
  if (missing.length === 0) {
    showToast('欠番なし！全番号が揃っています');
    return;
  }

  let html = `<h3 style="margin:0 0 8px;">🔍 欠番チェック</h3>
    <div style="font-size:13px;margin-bottom:8px;">総数: ${max}件中 <b style="color:#e53935">${missing.length}件欠番</b></div>
    <div style="max-height:300px;overflow-y:auto;">`;

  missing.forEach(num => {
    const prev = pins.find(p => (p.label||'').match(new RegExp(`^${num - 1}\\.`)));
    const next = pins.find(p => (p.label||'').match(new RegExp(`^${num + 1}\\.`)));
    const prevLabel = prev ? prev.label : '';
    const nextLabel = next ? next.label : '';
    html += `<div style="padding:4px 0;border-bottom:1px solid #eee;font-size:12px;">
      <b style="color:#e53935;">#${num}</b>
      <span style="color:#999;"> ${prevLabel ? '← ' + escapeHtml(prevLabel) : ''}</span>
      ${next ? `<button onclick="focusBetween(${prev?prev.id:0},${next.id})" style="margin-left:4px;padding:1px 6px;border:none;border-radius:3px;background:#1976D2;color:white;font-size:10px;cursor:pointer;">表示</button>` : ''}
    </div>`;
  });

  html += '</div>';

  // モーダル表示
  const overlay = document.getElementById('help-modal');
  document.getElementById('help-content').innerHTML = html;
  document.querySelector('#help-modal h3').textContent = '';
  overlay.classList.add('show');
}

// 欠番の前後ピンの間にズーム
function focusBetween(prevId, nextId) {
  const p1 = pins.find(p => p.id === prevId);
  const p2 = pins.find(p => p.id === nextId);
  if (p2) {
    const lat = p1 ? (p1.lat + p2.lat) / 2 : p2.lat;
    const lng = p1 ? (p1.lng + p2.lng) / 2 : p2.lng;
    map.setView([lat, lng], 19);
    document.getElementById('help-modal').classList.remove('show');
  }
}

// --- 始点・終点ハイライト ---
function toggleEndpoints() {
  highlightEndpoints = !highlightEndpoints;
  localStorage.setItem('waterMeterHighlightEndpoints', highlightEndpoints ? 'true' : 'false');
  syncEndpointsButton();
  refreshAllMarkers();
  showToast(highlightEndpoints ? '始点・終点ハイライト ON' : '始点・終点ハイライト OFF');
}

// 変数 highlightEndpoints の値を btn-endpoints の active クラスに反映
function syncEndpointsButton() {
  const btn = document.getElementById('btn-endpoints');
  if (btn) btn.classList.toggle('active', highlightEndpoints);
}

// --- モバイル/PC共通: Escキー & 背景タップでモーダルを閉じる ---
(function () {
  var overlayIds = ['pin-modal', 'help-modal', 'sync-modal'];
  overlayIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    // 背景（オーバーレイ自身）タップで閉じる。内側(.modal)クリックは閉じない
    el.addEventListener('click', function (e) {
      if (e.target === el) el.classList.remove('show');
    });
  });
  // Escキーで開いているモーダルを閉じる（物理キーボード接続時）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    overlayIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.classList.contains('show')) el.classList.remove('show');
    });
  });
})();

// スタンプモード → stamp.js

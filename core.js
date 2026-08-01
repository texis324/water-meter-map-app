// --- 状態管理 ---
let pins = [];           // { id, lat, lng, label, memo, group? }
let pinMode = true;      // ピン追加モード
let markers = {};        // id -> L.marker
let editingPinId = null;
let nextId = 1;
let _bulkLoading = false; // 一括読み込み中はsaveToStorage抑制
let _markerCache = null;  // refreshAllMarkers中だけ有効な共有インデックス（起動時のloadFromStorageより前に要宣言＝TDZ回避）
let pinListOpen = false;  // ピン一覧パネルの開閉状態
// localStorage に保存済みなら復元、未保存なら true 既定
let highlightEndpoints = (localStorage.getItem('waterMeterHighlightEndpoints') ?? 'true') === 'true';
let isDark = localStorage.getItem('waterMeterDark') === 'true';

// グループ囲み管理
let pinGroups = [];       // [{ id, name, pinIds: [...] }, ...]

// --- 順路番号ヘルパー（ラベル先頭番号の読み書きはここへ集約） ---
// ラベル形式は「番号. 住所 氏名」。先頭番号が業務上の順路番号の正本（欠番・枝番も情報として保持）。
// パースは寛容: 全角ドット「12．」・枝番「238.1」も受ける（旧はsubmit.jsだけ対応の非対称だった）。
// 生成(setLabelNum)は常に半角「N. 」形式。
const LABEL_NUM_RE = /^\s*(\d+(?:\.\d+)?)[\.．]\s*/;

// ラベル先頭の順路番号を数値で返す（無ければ null。枝番"238.1"は238.1のまま返す）
function getLabelNum(label) {
  const m = (label || '').match(LABEL_NUM_RE);
  return m ? parseFloat(m[1]) : null;
}

// ラベルから番号部分を除いた本文（住所 氏名）を返す
function stripLabelNum(label) {
  return (label || '').replace(LABEL_NUM_RE, '');
}

// 番号配列を連続範囲つき文字列へ圧縮（例 [1,2,3,5,7,8] → 「1〜3, 5, 7〜8」）。枝番は単独表記
function formatNumRanges(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const parts = [];
  let start = null, prev = null;
  const flush = () => {
    if (start === null) return;
    parts.push(start === prev ? String(start) : `${start}〜${prev}`);
  };
  for (const n of sorted) {
    if (prev !== null && Number.isInteger(prev) && n === prev + 1) { prev = n; continue; }
    flush();
    start = prev = n;
  }
  flush();
  return parts.join(', ');
}

// ラベルへ順路番号を書き込む（既存番号は置換・「N. 本文」形式に正規化）
function setLabelNum(label, num) {
  return `${num}. ${stripLabelNum(label)}`;
}

// 指定番号のピンを探す（スタンプ起点・呼出し・欠番チェックの前後表示用）
function findPinByNum(num) {
  return pins.find(p => getLabelNum(p.label) === num) || null;
}

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
    showToast('戻す操作がありません');
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
// モード一覧の正本。exitAllOtherModes と activeModeName で共有する（二重管理を避ける）
function getModeRegistry() {
  return [
    { name: 'stamp',        flag: () => typeof stampMode !== 'undefined' && stampMode,                 exit: () => finishStampMode() },
    { name: 'reorder',      flag: () => typeof reorderMode !== 'undefined' && reorderMode,             exit: () => cancelReorder() },
    { name: 'traceReorder', flag: () => typeof traceReorderMode !== 'undefined' && traceReorderMode,   exit: () => cancelTraceReorder() },
    { name: 'concat',       flag: () => typeof concatMode !== 'undefined' && concatMode,               exit: () => cancelConcat() },
    { name: 'group',        flag: () => typeof groupMode !== 'undefined' && groupMode,                 exit: () => cancelGroupMode() },
    { name: 'trace',        flag: () => typeof traceMode !== 'undefined' && traceMode,                 exit: () => finishTrace() },
    { name: 'traceEdit',    flag: () => typeof traceEditMode !== 'undefined' && traceEditMode,         exit: () => cancelTraceEdit() },
    { name: 'lassoDelete',  flag: () => typeof lassoDeleteMode !== 'undefined' && lassoDeleteMode,     exit: () => cancelLassoDeleteMode() },
    // multiMoveの移動はdragendごとに保存済みなので、モード切替では確定終了(finish)する（勝手にundoしない）
    { name: 'multiMove',    flag: () => typeof multiMoveMode !== 'undefined' && multiMoveMode,         exit: () => finishMultiMove() },
  ];
}

// 現在ONになっているモード名（exceptName は無視）。無ければ null。
// キーボードショートカットが「他のモードを黙って蹴散らす」のを防ぐ用途。
function activeModeName(exceptName) {
  const m = getModeRegistry().find(x => x.name !== exceptName && x.flag());
  return m ? m.name : null;
}

const MODE_LABELS = {
  stamp: 'スタンプ', reorder: '並替え', traceReorder: 'なぞり順', concat: '連結',
  group: 'グループ化', trace: 'ルート線', traceEdit: 'ルート編集',
  lassoDelete: '範囲削除', multiMove: 'まとめて移動',
};

function exitAllOtherModes(exceptName) {
  const modes = getModeRegistry();
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

// 地図右クリック(スマホは長押し): 並べ替え中・なぞり中はピン追加、通常時は📌番号クイック配置
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
  } else if (!stampMode && !concatMode && !groupMode && !traceMode && !traceEditMode && !lassoDeleteMode && !multiMoveMode) {
    // 通常時（ピン追加/閲覧モード）: 指定番号のピンをこの地点へパッと置く
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    openQuickPlace(e.latlng);
  }
});

// --- 📌 番号クイック配置 ---
// 「1番をここにパッと置きたい」用。地図の右クリック/長押し→番号入力→その番号のピンを
// タップ地点へ移動（存在しない番号なら新規作成）。呼出し(callPinHere)と違い逆ジオコ通信を待たない
let quickPlaceLatLng = null;

function openQuickPlace(latlng) {
  quickPlaceLatLng = latlng;
  document.getElementById('place-modal').classList.add('show');
  document.getElementById('place-num-end').value = ''; // 範囲は毎回明示させる(単発が既定)
  const input = document.getElementById('place-num');
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

function closeQuickPlace() {
  document.getElementById('place-modal').classList.remove('show');
  quickPlaceLatLng = null;
}

function executeQuickPlace() {
  if (!quickPlaceLatLng) return;
  const num = parseInt(document.getElementById('place-num').value);
  if (!num || num < 1) { showToast('番号を入力してください'); return; }
  const endRaw = document.getElementById('place-num-end').value.trim();
  const endNum = endRaw ? parseInt(endRaw) : null;
  if (endNum && endNum >= 1 && endNum !== num) {
    executeQuickPlaceRange(Math.min(num, endNum), Math.max(num, endNum));
    return;
  }
  // --- 単発: 移動 or 新規作成（従来動作） ---
  // 参照ピンへの磁石スナップ（ON時のみ吸着）
  let lat = quickPlaceLatLng.lat, lng = quickPlaceLatLng.lng;
  if (typeof snapToReference === 'function') {
    const s = snapToReference(lat, lng);
    lat = s.lat; lng = s.lng;
  }
  const pin = findPinByNum(num);
  pushUndo();
  if (pin) {
    pin.lat = lat;
    pin.lng = lng;
    refreshAllMarkers();
    saveToStorage();
    const name = stripLabelNum(pin.label).slice(0, 14);
    showToast(`📌 #${num} ${name} をここに移動しました`);
  } else {
    addPin(lat, lng, `${num}. 新規ピン`, '');
    showToast(`📌 #${num} を新規配置しました`);
  }
  updatePinCount();
  closeQuickPlace();
}

// --- 範囲召喚: start〜end番の実在ピンを、クリック地点起点の小格子(約5m間隔・5本/行)へ番号順に配置 ---
// 存在しない番号はスキップ（勝手に新規ピンを量産しない）。枝番(12.5等)も範囲内なら拾う。
// 同一点に重ねると後で個別に掴めないため、少しずらして並べる=召喚後すぐ配れる
function executeQuickPlaceRange(start, end) {
  const targets = pins
    .filter(p => { const n = getLabelNum(p.label); return n !== null && n >= start && n <= end; })
    .sort((a, b) => getLabelNum(a.label) - getLabelNum(b.label));
  if (!targets.length) { showToast(`#${start}〜#${end} のピンが見つかりません`); return; }
  if (targets.length > 30 && !confirm(`${targets.length}件をここへ一気に移動します。よろしいですか？`)) return;
  const { lat, lng } = quickPlaceLatLng;
  const dLat = 0.000045, dLng = 0.000055, perRow = 5; // 約5m間隔の格子
  pushUndo();
  targets.forEach((p, i) => {
    p.lat = lat - Math.floor(i / perRow) * dLat;
    p.lng = lng + (i % perRow) * dLng;
  });
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  const requested = end - start + 1;
  const skipped = requested - targets.filter(p => Number.isInteger(getLabelNum(p.label))).length;
  showToast(`📦 #${start}〜#${end}: ${targets.length}件を召喚しました${skipped > 0 ? `（番号なし${skipped}件はスキップ）` : ''}`);
  closeQuickPlace();
}

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
  if (pinId >= nextId) nextId = pinId + 1;

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

  // 一括読込中はマーカー生成・カウント更新をスキップ（applyDataset末尾でまとめて構築）
  if (!_bulkLoading) {
    markers[pinId] = createMarker(pin);
    updatePinCount();
    saveToStorage();
  }
}

function getPinSize() {
  return parseInt(document.getElementById('pin-size-slider')?.value || 20);
}

function createMarker(pin) {
  const displayNum = getDisplayNumber(pin);
  const sz = getPinSize();
  // 全更新中は共有インデックス(_markerCache)でO(1)参照、単体呼び出し時は従来の走査
  const cache = _markerCache;
  const inGroup = cache ? cache.inGroupIds.has(pin.id) : pinGroups.some(g => g.pinIds.includes(pin.id));
  const collapsedGrp = cache ? cache.collapsedRepMap.get(pin.id) : pinGroups.find(g => g.collapsed && g.pinIds[0] === pin.id);
  const hasOldGroup = pin.group && pin.group.length;
  const sameLoc = cache ? (cache.coordPins.get(pin.lat + ',' + pin.lng) || [pin])
                        : pins.filter(p => p.lat === pin.lat && p.lng === pin.lng);
  const classes = [
    'pin-icon',
    pin.memo ? 'has-memo' : '',
    (inGroup || hasOldGroup) ? 'has-group' : ''
  ].filter(Boolean).join(' ');
  // 縮小グループの代表ピン: バッジに件数表示
  // 同一座標の重複件数バッジ
  const dupeCount = sameLoc.length;
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
    const labelText = stripLabelNum(pin.label) || `ピン #${displayNum}`;
    let tooltipHtml = `<b>#${displayNum} ${escapeHtml(labelText)}</b>`;
    if (pin.memo) tooltipHtml += `<br><span style="color:#666">${escapeHtml(pin.memo)}</span>`;
    if (dupeCount > 1) {
      // 重なってるピンの順路番号を範囲表示（マンション等の団子で「何番〜何番か」を即読めるように）
      const stackNums = sameLoc.map(p => getLabelNum(p.label)).filter(n => n !== null);
      if (stackNums.length > 1) {
        tooltipHtml += `<br><span style="color:#1976d2;font-weight:bold">🔢 ${formatNumRanges(stackNums)}</span>`;
      }
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
      const n = getLabelNum(pin.label);
      if (n !== null) {
        const base = Math.floor(n); // 枝番(238.1等)は整数部を起点にする
        stampNum = base + 1;
        updateStampDisplay();
        showToast(`#${base} の次 → #${stampNum} から配置`);
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
    if (multiMoveMode) {
      handleMultiMoveTap(pin.id);
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
            traceMode || traceEditMode || traceReorderMode || lassoDeleteMode || multiMoveMode) return;
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
    // 閲覧モード(pinMode OFF かつ他モード全OFF)では位置を戻して何も変更しない
    // — 地図パンのつもりで指がピンに乗った時の誤移動＋自動push事故防止
    if (!pinMode && !stampMode && !reorderMode && !traceReorderMode && !concatMode &&
        !groupMode && !traceMode && !traceEditMode && !lassoDeleteMode) {
      e.target.setLatLng([pin.lat, pin.lng]);
      showToast('🔒 閲覧モード中はピンを移動できません');
      return;
    }
    pushUndo();
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
      const n = getLabelNum(pin.label);
      if (n !== null) {
        const base = Math.floor(n); // 枝番は整数部を起点にする
        stampNum = base + 1;
        updateStampDisplay();
        showToast(`#${base} を移動 → 次は #${stampNum}`);
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
  // ★input[type=color]の値は仕様上つねに小文字で返る。大文字定数と厳密比較すると
  //   永久に不一致＝「色なし(既定の青)」に戻せず #1976d2 が焼き付く（始点ハイライトも死ぬ）
  const isDefaultColor = selectedColor.toLowerCase() === pinColorPresets[0].toLowerCase();
  pin.color = (selectedColor && !isDefaultColor) ? selectedColor : '';
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
// 表示は常に updateModeBtn() で pinMode から導出する。
// 各モードが pinMode=false にした後ボタンを再表示する際、表示が「追加」のまま
// 実態と食い違う同期漏れがあった（モード終了側は必ず updateModeBtn() を呼ぶこと）
function updateModeBtn() {
  const btn = document.getElementById('btn-mode');
  if (!btn) return;
  if (pinMode) {
    btn.textContent = '📍 ピン追加モード';
    btn.classList.add('active');
  } else {
    btn.textContent = '🔒 閲覧モード';
    btn.classList.remove('active');
  }
}

function toggleMode() {
  pinMode = !pinMode;
  updateModeBtn();
}

// --- マーカー全更新 ---
// _markerCache（宣言はファイル先頭）: refresh中だけ有効な共有インデックス。
// createMarkerのピン毎O(n)検索（座標重複・グループ所属）をO(1)にする
function buildMarkerCache() {
  const coordPins = new Map();       // "lat,lng" -> その座標のピン配列
  pins.forEach(p => {
    const k = p.lat + ',' + p.lng;
    const arr = coordPins.get(k);
    if (arr) arr.push(p); else coordPins.set(k, [p]);
  });
  const inGroupIds = new Set();      // グループ所属ピンid
  const collapsedRepMap = new Map(); // 縮小グループ代表ピンid -> グループ
  const hiddenIds = new Set();       // 縮小グループの非代表ピンid（非表示）
  pinGroups.forEach(g => {
    g.pinIds.forEach(id => inGroupIds.add(id));
    if (g.collapsed && g.pinIds.length) {
      collapsedRepMap.set(g.pinIds[0], g);
      g.pinIds.slice(1).forEach(id => hiddenIds.add(id));
    }
  });
  return { coordPins, inGroupIds, collapsedRepMap, hiddenIds };
}

function refreshAllMarkers() {
  for (const id in markers) {
    map.removeLayer(markers[id]);
  }
  markers = {};
  _markerCache = buildMarkerCache();
  try {
    pins.forEach(pin => {
      if (_markerCache.hiddenIds.has(pin.id)) return; // 縮小グループの非代表ピンは非表示
      markers[pin.id] = createMarker(pin);
    });
  } finally {
    _markerCache = null;
  }
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

// --- ツールバーのドロップアップメニュー（✏️編集 / ⚙️その他） ---
function toggleToolbarMenu(name) {
  const menu = document.getElementById('menu-' + name);
  const btn = document.getElementById('btn-menu-' + name);
  if (!menu || !btn) return;
  const willShow = !menu.classList.contains('show');
  closeToolbarMenus();
  if (!willShow) return;
  menu.classList.add('show');
  btn.classList.add('active');
  // トリガーの真上に開く（ツールバーが画面下端のため）。右端はみ出しは左へ寄せる
  const r = btn.getBoundingClientRect();
  menu.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  menu.style.left = r.left + 'px';
  const mw = menu.offsetWidth;
  if (r.left + mw > window.innerWidth - 8) {
    menu.style.left = Math.max(8, window.innerWidth - mw - 8) + 'px';
  }
}

function closeToolbarMenus() {
  document.querySelectorAll('.toolbar-menu.show').forEach(m => m.classList.remove('show'));
  ['btn-menu-edit', 'btn-menu-more'].forEach(id => {
    const b = document.getElementById(id);
    if (b) b.classList.remove('active');
  });
}

// メニュー項目を選んだら閉じる／外側タップで閉じる（スライダー操作では閉じない）
document.addEventListener('click', function (e) {
  if (e.target.closest('#btn-menu-edit') || e.target.closest('#btn-menu-more')) return;
  const inMenu = e.target.closest('.toolbar-menu');
  if (!inMenu || e.target.closest('button')) closeToolbarMenus();
});

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
    const aNum = getLabelNum(a.label) ?? Infinity;
    const bNum = getLabelNum(b.label) ?? Infinity;
    return aNum - bNum;
  });
  sortedPins.forEach((pin, i) => {
    const num = getLabelNum(pin.label) ?? (i + 1);
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
    const aNum = getLabelNum(a.label) ?? Infinity;
    const bNum = getLabelNum(b.label) ?? Infinity;
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

// stripLabelNum → ファイル先頭の順路番号ヘルパー群に移設済み

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
  const nums = pins.map(p => getLabelNum(p.label)).filter(n => n !== null);

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
    const prev = findPinByNum(num - 1);
    const next = findPinByNum(num + 1);
    const prevLabel = prev ? prev.label : '';
    const nextLabel = next ? next.label : '';
    html += `<div style="padding:4px 0;border-bottom:1px solid #eee;font-size:12px;">
      <b style="color:#e53935;">#${num}</b>
      <span style="color:#999;"> ${prevLabel ? '← ' + escapeHtml(prevLabel) : ''}</span>
      ${next ? `<button onclick="focusBetween(${prev?prev.id:0},${next.id})" style="margin-left:4px;padding:1px 6px;border:none;border-radius:3px;background:#1976D2;color:white;font-size:10px;cursor:pointer;">表示</button>` : ''}
    </div>`;
  });

  html += '</div>';

  // 専用の結果モーダルに表示（ヘルプモーダルは触らない）
  const overlay = document.getElementById('result-modal');
  document.getElementById('result-content').innerHTML = html;
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
    document.getElementById('result-modal').classList.remove('show');
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
  var overlayIds = ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal'];
  overlayIds.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    // 背景（オーバーレイ自身）タップで閉じる。内側(.modal)クリックは閉じない
    el.addEventListener('click', function (e) {
      if (e.target === el) el.classList.remove('show');
    });
  });
  // Escキーで開いているモーダル・ツールバーメニューを閉じる（物理キーボード接続時）
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    overlayIds.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.classList.contains('show')) el.classList.remove('show');
    });
    if (typeof closeToolbarMenus === 'function') closeToolbarMenus();
  });
})();

// スタンプモード → stamp.js

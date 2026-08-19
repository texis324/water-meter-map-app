// --- スナップショット日付 (古いデータ警告) ---
// ファイル名から YYYY-MM-DD を抽出 (例: water_meter_pins_2026-04-08 最終バックアップ小木町.json)
function extractDateFromFilename(filename) {
  if (!filename) return null;
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// 現在ロード中のスナップショット日付 (saveToStorage で再保存する用)
let currentSnapshotDate = null;

// 日付文字列 (YYYY-MM-DD) から経過日数を計算
function daysSinceSnapshot(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

// 警告バナーの表示 / 非表示
function showStaleSnapshotWarning(dateStr) {
  const days = daysSinceSnapshot(dateStr);
  const banner = document.getElementById('stale-snapshot-banner');
  if (!banner) return;
  if (days != null && days >= 180) {
    document.getElementById('stale-snapshot-days').textContent = days;
    document.getElementById('stale-snapshot-date').textContent = dateStr;
    banner.classList.add('show');
  } else {
    banner.classList.remove('show');
  }
}

// パース済みデータからスナップショット日付を決定 (meta優先、無ければファイル名)
function resolveSnapshotDate(parsedData, filename) {
  if (parsedData && parsedData.meta && parsedData.meta.snapshotDate) {
    return parsedData.meta.snapshotDate;
  }
  return extractDateFromFilename(filename);
}

// --- データ一式の適用（共通コア） ---
// D&D読込・📥読込みボタン・localStorage復元・クラウドpullの4経路が全てここを通る。
// （以前は4箇所にほぼ同文のコピペがあり、挙動が発散してエリア誤push等の温床だった）
// opts.filename: snapshotDate抽出のフォールバック元ファイル名
// opts.save: 'none'で適用後に保存しない（既定は saveToStorage 実行）
// opts.fit: false で全ピンズームをしない（既定は実行）
function applyDataset(data, opts) {
  opts = opts || {};
  // 並べ替え等のモード中にデータセットを差し替えると、モードの参照が死んで壊れた配列を保存し得る（監査#3）
  if (typeof activeModeName === 'function' && activeModeName()) exitAllOtherModes();
  pins.forEach(p => { if (markers[p.id]) map.removeLayer(markers[p.id]); });
  pins = []; markers = {};
  nextId = data.nextId || 1;
  savedTraces = data.savedTraces || [];
  pinGroups = data.pinGroups || [];
  redrawSavedTraces();
  _bulkLoading = true;
  try {
    (data.pins || []).forEach(p => addPin(p.lat, p.lng, p.label, p.memo, p.id, { ...p }));
  } finally {
    _bulkLoading = false;
  }
  // nextId セーフティ再計算: data.nextId が破損していても確実に max+1
  if (pins.length > 0) {
    nextId = Math.max(nextId, ...pins.map(p => p.id || 0)) + 1;
  }
  // マーカーは一括構築（addPinは_bulkLoading中スキップ・重複バッジも全件正しく付く）
  refreshAllMarkers();
  updatePinCount();
  warnIfDuplicates();
  currentSnapshotDate = resolveSnapshotDate(data, opts.filename);
  showStaleSnapshotWarning(currentSnapshotDate);
  if (opts.save !== 'none') saveToStorage();
  if (opts.fit !== false && pins.length > 0) {
    map.fitBounds(L.featureGroup(Object.values(markers)).getBounds().pad(0.1));
  }
}

// --- ドラッグ&ドロップ JSON読込 ---
;(function() {
  function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    document.body.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (!file || !file.name.endsWith('.json')) {
      showToast('JSONファイルをドロップしてください');
      return;
    }
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data.pins) { showToast('ピンデータが見つかりません'); return; }
        // 読込みボタン(handleImport)と同じ扱い: 「読み込み中エリア」を解除して旧エリアへの誤pushを防ぐ
        if (typeof window.syncClearLoadedArea === 'function') window.syncClearLoadedArea();
        applyDataset(data, { filename: file.name });
        showToast(`📂 ${file.name} — ${pins.length}件を読み込みました`);
      } catch(err) {
        showToast('読み込みエラー: ファイル形式を確認してください');
      }
    };
    reader.readAsText(file);
  }
  document.addEventListener('dragover', function(e) {
    e.preventDefault();
    document.body.classList.add('drag-over');
  });
  document.addEventListener('dragleave', function(e) {
    if (e.relatedTarget === null) document.body.classList.remove('drag-over');
  });
  document.addEventListener('drop', handleDrop);
})();

// --- 保存 / 読込 ---
function saveToStorage() {
  try {
    const meta = currentSnapshotDate ? { snapshotDate: currentSnapshotDate } : undefined;
    const data = JSON.stringify({ pins, nextId, savedTraces, pinGroups, meta });
    localStorage.setItem('waterMeterPins', data);
    console.log(`[SAVE] ${pins.length}件保存 (${(data.length/1024).toFixed(1)}KB)`);
  } catch(e) {
    console.error('localStorage保存エラー:', e);
    showToast('保存エラー: ' + e.message);
  }
}

function loadFromStorage() {
  const data = localStorage.getItem('waterMeterPins');
  if (!data) { console.log('[LOAD] localStorageにデータなし'); return; }
  try {
    const parsed = JSON.parse(data);
    console.log(`[LOAD] localStorage読込: ${parsed.pins ? parsed.pins.length : 0}件のピン (${(data.length/1024).toFixed(1)}KB)`);
    applyDataset(parsed, { save: 'none' });
    if (pins.length > 0) showToast(`${pins.length}件のピンを復元しました`);
  } catch(e) {
    console.error('データ復元エラー:', e);
  }
}

function detectAreaName() {
  // ラベルから地域名を自動検出（最頻出の町名を使用）
  const counts = {};
  pins.forEach(p => {
    const m = (p.label || '').match(/伊勢市(.+?町)/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted.length > 0 ? sorted[0][0] : '';
}

function exportData() {
  const area = detectAreaName();
  // 書き出し時は本日の日付で snapshotDate を更新 (最新スナップショット扱い)
  const todayStr = new Date().toISOString().slice(0, 10);
  currentSnapshotDate = todayStr;
  const meta = { snapshotDate: todayStr };
  const data = JSON.stringify({ pins, nextId, savedTraces, pinGroups, meta }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `water_meter_pins_${new Date().toISOString().slice(0,10)}${area ? area : ''}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`ファイルを書き出しました${area ? ' (' + area + ')' : ''}`);
}

function importData() {
  document.getElementById('file-input').click();
}

function handleImport(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.pins) { showToast('ピンデータが見つかりません'); return; }
      applyDataset(data, { filename: file.name });
      showToast(`${pins.length}件を読み込みました`);
    } catch(err) {
      showToast('読み込みエラー: ファイル形式を確認してください');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

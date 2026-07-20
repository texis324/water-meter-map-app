// --- スタンプモード ---
let stampMode = false;
let stampNum = 1;

function toggleStampMode() {
  if (stampMode) {
    finishStampMode();
    return;
  }
  exitAllOtherModes('stamp');
  stampMode = true;
  pinMode = false;
  stampNum = 1;

  document.getElementById('btn-stamp').classList.add('active');
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('stamp-banner').classList.add('show');
  updateStampDisplay();
  showToast('スタンプモード: クリックでピンを配置（既存ピンクリックで起点変更）');
}

function finishStampMode() {
  stampMode = false;
  document.getElementById('btn-stamp').classList.remove('active');
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('stamp-banner').classList.remove('show');
  refreshAllMarkers();
  showToast('スタンプモード終了');
}

function setStampNum(num) {
  if (num >= 1) {
    stampNum = num;
    updateStampDisplay();
  }
}

function updateStampDisplay() {
  document.getElementById('stamp-next-num').textContent = stampNum;
  document.getElementById('stamp-num-input').value = stampNum;
  // 該当番号のピンのラベルを表示
  const pin = findPinByNum(stampNum);
  const labelEl = document.getElementById('stamp-next-label');
  if (pin) {
    labelEl.textContent = '→ ' + pin.label;
  } else {
    labelEl.textContent = '（新規ピン）';
  }
}

function handleStampTap(latlng) {
  // 現在の番号のピンを探して移動、またはなければ新規作成
  // （findPinByNumが唯一の探索なので、旧実装にあった同一条件の二重防御filterは撤去）
  const targetPin = findPinByNum(stampNum);

  pushUndo();

  if (targetPin) {
    // 既存ピンをこの位置に移動
    targetPin.lat = latlng.lat;
    targetPin.lng = latlng.lng;
    showToast(`#${stampNum} ${targetPin.label} を配置`);
  } else {
    // 新規ピン作成
    addPin(latlng.lat, latlng.lng, `${stampNum}. 新規ピン`, '');
    showToast(`#${stampNum} を新規配置`);
  }

  refreshAllMarkers();
  saveToStorage();

  // 次の番号へ
  stampNum++;
  updateStampDisplay();
}

// 案D: 重複番号検出 - ラベル先頭番号が複数ピンで重複しているものを一覧化
// 戻り値: 重複情報配列 [{ num, pins: [...] }, ...] （UIには結果に応じてtoast/alert表示）
function findDuplicateNumbers() {
  const numMap = {};  // num -> [pin, pin, ...]
  pins.forEach(p => {
    const num = getLabelNum(p.label);
    if (num !== null) {
      if (!numMap[num]) numMap[num] = [];
      numMap[num].push(p);
    }
  });
  return Object.entries(numMap)
    .filter(([num, arr]) => arr.length > 1)
    .map(([num, arr]) => ({ num: parseFloat(num), pins: arr }))
    .sort((a, b) => a.num - b.num);
}

function detectDuplicateNumbers() {
  const duplicates = findDuplicateNumbers();
  if (duplicates.length === 0) {
    showToast('✅ 番号重複なし');
    return;
  }
  const lines = duplicates.map(d =>
    `#${d.num}: ${d.pins.length}件\n  ${d.pins.map(p => `[id=${p.id}] ${p.label}`).join('\n  ')}`
  ).join('\n\n');
  alert(`⚠️ 番号重複 ${duplicates.length}件\n\n${lines}`);
  console.warn('[detectDuplicateNumbers]', duplicates);
}

// import/load直後に呼ぶサイレント版（toastだけ、alert無し）
function warnIfDuplicates() {
  const duplicates = findDuplicateNumbers();
  if (duplicates.length > 0) {
    const sample = duplicates.slice(0, 3).map(d => `#${d.num}`).join(', ');
    const more = duplicates.length > 3 ? ` ほか${duplicates.length - 3}件` : '';
    showToast(`⚠️ 番号重複 ${duplicates.length}件 (${sample}${more}) → 🔁ボタンで詳細`);
  }
}

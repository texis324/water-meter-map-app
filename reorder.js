// --- ラベル番号の振り直し ---
// pins配列の並び順に合わせてラベルの先頭番号を更新する（idは変更しない）
// ラベルが空のピンは触らない。番号なしラベルには番号を付与する
// （旧実装はreplace無反応でスキップ=提出表の新Noが空欄になる穴だった）
function relabelPins() {
  pins.forEach((pin, i) => {
    if (pin.label) {
      pin.label = setLabelNum(pin.label, i + 1);
    }
  });
}

// --- 配列順をラベル番号順に揃える（並べ替え系モードの入口で必ず呼ぶ） ---
// 番号の正本はラベル先頭番号（2026-07-08 番号正本化）。一方、並べ替え/なぞり順/連結は
// 「配列の順番＝番号」を前提に動く（アンカーidx→開始番号・挿入位置・完了時のrelabelPins）。
// モーダルでラベルの番号だけ書き換える等で配列順とラベル番号がズレたまま並べ替えを完了すると、
// 触っていないピンの番号まで動く（2026-08-19 尾上町で実害: 66〜75/115・116/151・152が勝手に入替）。
// → 入口で配列をラベル番号順（枝番はfloat・番号なしは末尾・同値は元の順＝安定）に並べ直して前提を成立させる。
// ラベル文字列そのものは変えない（見た目・クラウド・old_noに影響なし）。
function normalizePinOrderByLabel() {
  // 番号なし（label空／番号なしラベル）は「配列上の位置＝暗黙の番号 index+1」を持つ扱い（relabelPinsも表示も
  // その前提）。末尾へ流すと以降の全番号が1つ詰まる回帰になる（監査#2）ので、暗黙番号をキーにして位置を保つ。
  const withIdx = pins.map((p, i) => { const n = getLabelNum(p.label); return { p, i, n: (n == null) ? (i + 1) : n }; });
  withIdx.sort((a, b) => (a.n - b.n) || (a.i - b.i));
  const changed = withIdx.some((x, i) => x.i !== i);
  if (changed) pins = withIdx.map(x => x.p);
  return changed;
}

// --- 並べ替えモード ---
let reorderMode = false;
let reorderedPins = [];    // 並べ替え済みのピン（タップ順）
let remainingPins = [];    // まだタップされていないピン
let reorderAnchorSet = false; // 開始位置が確定済みか
// アンカー（開始位置）のピンID。ブロックは完了時に「このピンの直後」に入る。
// 旧実装は「開始番号-1 の配列位置」に固定挿入していたため、開始位置より前のピンを取り込むと
// その分だけ前が詰まり、後ろのピンがブロックの前へ滑り込んだ（2026-08-19 尾上町: 78,69,79 と取ると 80 が 77 番に）。
// null のときは「開始番号の位置」の旧セマンティクスで動く（数字を直接入力し、対応するピンが無い場合）。
let reorderAnchorPinId = null;
let reorderSwapMode = false;  // 入替モード（番号指定不要）
let reorderTakeHistory = []; // 各タップで取り込んだ本数（🏢まとめ取りのUndo用）
// 🔒保留ピン: 「この番号は動かすな」と明示指定したピンのID。
// 並べ替え後も元の位置(=今の番号)に固定され、取り込み対象からも外れる。
// 並べ替えセッション限りの状態で、完了/取消でクリアする（ピンのデータには残さない）。
let reorderHeldIds = new Set();

function isPinHeld(pinId) {
  return reorderHeldIds.has(pinId);
}

// 保留のトグル（右クリック / スマホ長押し）
function toggleReorderHold(pinId) {
  if (!reorderMode) return;
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;
  const num = getLabelNum(pin.label) || (pins.indexOf(pin) + 1);
  if (reorderHeldIds.has(pinId)) {
    reorderHeldIds.delete(pinId);
    showToast(`🔓 ${num}番の保留を解除`);
  } else {
    // 取り込み済みのピンを保留にしたい場合は、まず取り込みから外す
    const i = reorderedPins.indexOf(pin);
    if (i !== -1) {
      showToast('取り込み済みです。先に戻して（Backspace）から保留にしてください');
      return;
    }
    reorderHeldIds.add(pinId);
    showToast(`🔒 ${num}番を保留（並べ替えても動きません）`);
  }
  updateReorderCount();
  refreshReorderMarkers();
}

function toggleReorderMode() {
  if (reorderMode) {
    cancelReorder();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  // 並べ替えモード開始
  exitAllOtherModes('reorder');
  normalizePinOrderByLabel();   // 配列順＝番号順を保証（アンカー番号・挿入位置の前提）
  reorderMode = true;
  reorderAnchorPinId = null;
  pinMode = false;
  reorderedPins = [];
  remainingPins = [...pins];
  reorderAnchorSet = false;
  reorderTakeHistory = [];
  reorderHeldIds = new Set();

  document.getElementById('btn-reorder').classList.add('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('reorder-banner').classList.add('show');
  updateReorderCount();

  // 全ピンをグレーに
  refreshReorderMarkers();
  showToast('開始位置のピンをタップ（その次から並べ替え）');
}

function handleReorderTap(pinId) {
  // 最初のタップ: 開始位置を設定（そのピンの次の番号から並べ替え開始）
  if (!reorderAnchorSet) {
    const anchorIdx = pins.findIndex(p => p.id === pinId);
    if (anchorIdx === -1) return;
    const startNum = anchorIdx + 2; // そのピンの次の番号
    document.getElementById('reorder-start').value = startNum;
    reorderAnchorSet = true;
    reorderAnchorPinId = pinId;     // 完了時は「このピンの直後」に挿入
    refreshReorderMarkers();
    showToast(`${anchorIdx + 1}番の次（${startNum}番）から並べ替え開始`);
    return;
  }

  // 🔒保留ピンは取り込まない（右クリック/長押しで解除できる）
  if (isPinHeld(pinId)) {
    showToast('🔒 保留中のピンです（右クリック/長押しで解除）');
    return;
  }

  const idx = remainingPins.findIndex(p => p.id === pinId);
  if (idx === -1) {
    showToast('そのピンは並べ替え済みです');
    return;
  }
  const pin = remainingPins[idx];
  // 🏢まとめ取り: 同一座標（=重複バッジが出てる団子）の未処理ピンをワンタップで全部取り込む。
  // 建物内の相対順は現在の並び順を維持。入替モードは位置交換の意味が崩れるので対象外。
  // 同じ建物の中に保留ピンが混じっていても、それだけは取り込まない。
  const stack = reorderSwapMode ? [pin]
    : remainingPins.filter(p => p.lat === pin.lat && p.lng === pin.lng && !isPinHeld(p.id));
  if (stack.length > 1) {
    stack.sort((a, b) => pins.indexOf(a) - pins.indexOf(b));
    for (const s of stack) {
      remainingPins.splice(remainingPins.indexOf(s), 1);
      reorderedPins.push(s);
    }
    reorderTakeHistory.push(stack.length);
    showToast(`🏢 同じ場所の${stack.length}本をまとめて取り込み`);
  } else {
    remainingPins.splice(remainingPins.indexOf(pin), 1);
    reorderedPins.push(pin);
    reorderTakeHistory.push(1);
  }
  updateReorderCount();
  refreshReorderMarkers();
}

// 直前の取り込みを1つ戻す（🏢まとめ取りなら丸ごと）。
// マーカータップとキーボードショートカット(Backspace/Z)の共通処理。
function undoLastTake() {
  if (!reorderMode || reorderedPins.length === 0) return false;
  const lastN = reorderTakeHistory.pop() || 1;
  const back = reorderedPins.splice(reorderedPins.length - lastN, lastN);
  remainingPins.unshift(...back);
  updateReorderCount();
  refreshReorderMarkers();
  showToast(lastN > 1 ? `🏢 ${lastN}本まとめて戻しました` : '1つ戻しました');
  return true;
}

function updateReorderCount() {
  document.getElementById('reorder-count').textContent = reorderedPins.length;
  const instr = document.getElementById('reorder-instruction');
  if (instr) {
    instr.textContent = reorderAnchorSet ? 'ピンをタップして並べ替え' : '開始位置のピンをタップ';
  }
  const heldEl = document.getElementById('reorder-held-count');
  if (heldEl) {
    heldEl.textContent = reorderHeldIds.size ? `／🔒保留 ${reorderHeldIds.size}件` : '';
  }
}

// 開始番号を手入力した時: その番号-1 のピンをアンカーに解決する（1 なら先頭＝アンカーなし）。
// 対応するピンが無ければ旧セマンティクス（番号位置）にフォールバック。
function setReorderStartFromInput() {
  const v = parseInt(document.getElementById('reorder-start')?.value || 1);
  reorderAnchorSet = true;
  reorderAnchorPinId = null;
  if (v > 1) {
    const prev = findPinByNum(v - 1);
    if (prev) reorderAnchorPinId = prev.id;
  }
  updateReorderDisplay();
}

function getReorderStartNum() {
  return parseInt(document.getElementById('reorder-start')?.value || 1);
}

function updateReorderDisplay() {
  refreshReorderMarkers();
}

function refreshReorderMarkers() {
  for (const id in markers) {
    map.removeLayer(markers[id]);
  }
  markers = {};

  const sz = getPinSize();
  // 紫ピンの番号＝完了後の実番号（computeReorderResult と同じ計算）。入替モードはタップ順
  let finalIdx = null;
  if (!reorderSwapMode && reorderedPins.length) {
    finalIdx = new Map(computeReorderResult().map((p, i) => [p.id, i + 1]));
  }

  // 並べ替え済みピン（紫）
  reorderedPins.forEach((pin, i) => {
    const shown = reorderSwapMode ? (i + 1) : ((finalIdx && finalIdx.get(pin.id)) || (getReorderStartNum() + i));
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon reordered">${shown}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon, draggable: true }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      // 最後に取り込んだピン（🏢まとめ取りならその建物のどれか）をタップで、直前のタップ分を丸ごと戻す
      const lastN = reorderTakeHistory[reorderTakeHistory.length - 1] || 1;
      const lastTake = reorderedPins.slice(-lastN);
      if (lastTake.some(p => p.id === pin.id)) undoLastTake();
    });
    marker.on('dragend', function(e) {
      const pos = e.target.getLatLng();
      pin.lat = pos.lat;
      pin.lng = pos.lng;
      saveToStorage();
    });
    markers[pin.id] = marker;
  });

  // 未処理ピン（グレー、元の番号を表示）／🔒保留ピンは琥珀で「動かない」を明示
  remainingPins.forEach(pin => {
    const origIdx = pins.indexOf(pin) + 1;
    const held = isPinHeld(pin.id);
    const icon = L.divIcon({
      className: '',
      html: `<div class="pin-icon ${held ? 'reorder-held' : 'reorder-pending'}" ${held ? 'title="🔒保留中: 並べ替えてもこの番号のまま"' : ''}>${origIdx}</div>`,
      iconSize: [sz, sz],
      iconAnchor: [sz/2, sz/2]
    });
    const marker = L.marker([pin.lat, pin.lng], { icon, draggable: true }).addTo(map);
    marker.on('click', function(e) {
      L.DomEvent.stopPropagation(e);
      handleReorderTap(pin.id);
    });
    marker.on('dragend', function(e) {
      const pos = e.target.getLatLng();
      pin.lat = pos.lat;
      pin.lng = pos.lng;
      saveToStorage();
    });
    markers[pin.id] = marker;
  });

  // 🔒保留のトグル: ピンを右クリック（スマホは長押し）。
  // ★stopPropagationしないと地図側のcontextmenu（並べ替え中は「ピン追加」）に抜けて、
  //   ピンを右クリックしただけで新しいピンが生えてしまう。
  Object.keys(markers).forEach(id => {
    markers[id].on('contextmenu', function (e) {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      toggleReorderHold(parseInt(id));
    });
  });
}

function toggleReorderSwapMode() {
  reorderSwapMode = !reorderSwapMode;
  const btn = document.getElementById('btn-swap-mode');
  const startArea = document.getElementById('reorder-startnum-area');
  if (reorderSwapMode) {
    btn.style.background = 'white';
    btn.style.color = '#9C27B0';
    startArea.style.display = 'none';
    reorderAnchorSet = true; // アンカー不要
    showToast('入替モード: ピンをタップ順に入替えます');
  } else {
    btn.style.background = 'rgba(255,255,255,0.3)';
    btn.style.color = 'white';
    startArea.style.display = '';
    // アンカーは開始番号欄から復元（取り込み済みが残っている時に index経路へ落ちないように・監査#8）
    setReorderStartFromInput();
    showToast('通常モード: 開始番号を指定して並べ替え');
  }
  updateReorderCount();
  refreshReorderMarkers();
}

// 通常モードの「完了後の配列」を計算する純関数（pins は変更しない）。
// finishReorder と refreshReorderMarkers（紫ピンの番号表示）が同じ関数を使うので、
// 並べ替え中に見えている番号と完了後の番号が必ず一致する（監査#4: アンカーより前のピンを取り込むと表示がズレていた）。
function computeReorderResult() {
  const startNum = getReorderStartNum();
  const insertIdx = startNum - 1;
  const reorderedIds = new Set(reorderedPins.map(p => p.id));

  // 🔒保留ピンは「元の位置(=今の番号)」に固定する。
  // 手順: ①保留を一旦抜いた配列を作って並べ替えブロックを挿入 → ②保留を元のindexへ戻す。
  //       ②は元index昇順に splice すれば、各ピンがちょうど元のindexに収まる。
  const heldEntries = pins
    .map((p, idx) => ({ pin: p, idx }))
    .filter(x => reorderHeldIds.has(x.pin.id));

  const rest = pins.filter(p => !reorderedIds.has(p.id) && !reorderHeldIds.has(p.id));
  let clampedIdx;
  const anchorPin = (reorderAnchorPinId != null) ? pins.find(p => p.id === reorderAnchorPinId) : null;
  if (anchorPin && startNum > 1) {
    // ★アンカー基準: ブロックは「アンカーピンの直後」。アンカー自身が取り込み/保留で rest に無ければ、
    //   元の並びで手前へ遡って rest にいる最初のピンの直後（何も無ければ先頭）。
    //   これで開始位置より前のピンを取り込んでも、後ろのピンがブロックの前へ滑り込まない。
    let ref = null;
    for (let i = pins.indexOf(anchorPin); i >= 0; i--) {
      if (rest.includes(pins[i])) { ref = pins[i]; break; }
    }
    clampedIdx = ref ? rest.indexOf(ref) + 1 : 0;
  } else {
    // 開始番号のみ（アンカーピン無し／先頭指定）: 最終番号での位置。保留がその手前を占める分だけ rest 座標系では前にずれる
    const heldBefore = heldEntries.filter(x => x.idx < insertIdx).length;
    clampedIdx = Math.max(0, Math.min(insertIdx - heldBefore, rest.length));
  }
  rest.splice(clampedIdx, 0, ...reorderedPins);

  heldEntries.forEach(({ pin, idx }) => {
    rest.splice(Math.min(idx, rest.length), 0, pin);
  });
  return rest;
}

function finishReorder() {
  if (reorderedPins.length === 0) {
    showToast('1件もタップされていません');
    return;
  }
  pushUndo();
  normalizePinOrderByLabel();   // 念のため完了直前にも（モード中にラベル番号が変わる経路への保険）
  if (reorderSwapMode) {
    // 入替モード: タップしたピンの元の位置（ソート済み）にタップ順で配置
    const origIndices = reorderedPins.map(p => pins.indexOf(p)).sort((a, b) => a - b);
    const newPins = [...pins];
    reorderedPins.forEach((pin, i) => {
      newPins[origIndices[i]] = pin;
    });
    pins = newPins;
  } else {
    // 通常モード: 最終配列は computeReorderResult()（表示中の紫番号と同じ計算＝完了時と必ず一致）
    pins = computeReorderResult();
  }

  // モード終了
  reorderMode = false;
  reorderedPins = [];
  remainingPins = [];
  reorderSwapMode = false;
  reorderTakeHistory = [];
  reorderHeldIds = new Set();
  reorderAnchorPinId = null;
  document.getElementById('btn-reorder').classList.remove('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え';
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('reorder-banner').classList.remove('show');

  relabelPins();
  refreshAllMarkers();
  saveToStorage();
  showToast('並べ替え完了！');
}

function cancelReorder() {
  reorderMode = false;
  reorderedPins = [];
  remainingPins = [];
  reorderAnchorSet = false;
  reorderAnchorPinId = null;
  reorderSwapMode = false;
  reorderTakeHistory = [];
  reorderHeldIds = new Set();
  document.getElementById('btn-reorder').classList.remove('active');
  document.getElementById('btn-reorder').textContent = '🔢 並替え';
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('reorder-banner').classList.remove('show');

  refreshAllMarkers();
  showToast('並べ替えを取消しました');
}

// --- 🔁 R = 範囲反転／2本入替: R → 始点タップ → 終点タップ ---
// 動機(2026-08-19 Tench要望): 「2つのピンをちょうど入れ替えたい」「109〜125を一気に反転したい」が
// N→入替モード→…→Enter だと手数が多い。R→A→B の3手で終わらせる。
//  ・既定 = A〜B の範囲を丸ごと反転（109↔125, 110↔124, …）。隣同士なら結果は2本入替と同じ
//  ・2本目を Shift+クリック = 範囲は触らず A⇄B の2本だけ入替（PCのみ・スマホは反転のみ）
// 番号のセット（枝番・欠番の位置）は範囲内で保たれ、範囲外のピンは一切触らない。配列位置も同じに並べ替えて 配列順=番号順 を保つ。
// 1回実行したら自動終了（連続でやるなら R をもう一度）。誤爆で次のクリックが反転になるのを防ぐ。
let swapTwoMode = false;
let swapTwoFirstId = null;

function toggleSwapTwoMode() {
  if (swapTwoMode) { cancelSwapTwo(); return; }
  const busy = typeof activeModeName === 'function' ? activeModeName('swapTwo') : null;
  if (busy) {
    showToast(`「${(typeof MODE_LABELS !== 'undefined' && MODE_LABELS[busy]) || busy}」モード中です。先に終了してください`);
    return;
  }
  if (pins.length < 2) { showToast('ピンが2件以上必要です'); return; }
  exitAllOtherModes('swapTwo');
  swapTwoMode = true;
  swapTwoFirstId = null;
  normalizePinOrderByLabel();   // 範囲＝配列の連続区間として扱うので、配列順＝番号順を保証してから
  const b = document.getElementById('btn-swap-two');
  if (b) { b.classList.add('active'); b.textContent = '🔁 反転中...'; }
  if (typeof closeToolbarMenus === 'function') closeToolbarMenus();
  showToast('🔁 始点のピンをタップ（Esc/Rで中止）');
}

function cancelSwapTwo(silent) {
  swapTwoMode = false;
  swapTwoFirstId = null;
  const b = document.getElementById('btn-swap-two');
  if (b) { b.classList.remove('active'); b.textContent = '🔁 反転/入替'; }
  refreshAllMarkers();
  if (!silent) showToast('反転/入替を中止しました');
}

function handleSwapTwoTap(pinId, evt) {
  if (swapTwoFirstId == null) {
    swapTwoFirstId = pinId;
    const el = markers[pinId] && markers[pinId].getElement && markers[pinId].getElement();
    const icon = el && el.querySelector('.pin-icon');
    if (icon) icon.classList.add('swap-first');
    const p = pins.find(x => x.id === pinId);
    showToast(`${getLabelNum(p && p.label) ?? '?'}番を選択 → 終点をタップで範囲反転（Shift+タップ=2本だけ入替）`);
    return;
  }
  if (pinId === swapTwoFirstId) {          // 同じピンをもう一度＝選択解除
    swapTwoFirstId = null;
    refreshAllMarkers();
    showToast('選択を解除。1本目からやり直し');
    return;
  }
  const a = pins.find(x => x.id === swapTwoFirstId);
  const b = pins.find(x => x.id === pinId);
  if (!a || !b) { cancelSwapTwo(true); showToast('ピンが見つかりません'); return; }
  const na = getLabelNum(a.label), nb = getLabelNum(b.label);
  if (na == null || nb == null) { cancelSwapTwo(true); showToast('番号のないピンは反転/入替できません'); return; }
  const shift = !!(evt && (evt.shiftKey || (evt.originalEvent && evt.originalEvent.shiftKey)));
  const ia = pins.indexOf(a), ib = pins.indexOf(b);
  const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
  pushUndo();
  if (shift || hi - lo === 1) {
    // 2本だけ入替（隣同士は反転と同じ結果なのでこちらで十分）
    a.label = setLabelNum(a.label, nb);
    b.label = setLabelNum(b.label, na);
    pins[ia] = b; pins[ib] = a;   // 配列位置も交換（配列順=番号順の維持）
    cancelSwapTwo(true);
    saveToStorage();
    showToast(`🔁 ${na}番 ⇄ ${nb}番 を入れ替えました（元に戻すは↩）`);
    return;
  }
  // 範囲反転: lo〜hi の区間を逆順にし、番号は「位置」に対して据え置き（枝番・欠番のパターンは保たれる）
  const seg = pins.slice(lo, hi + 1);
  const nums = seg.map(p => getLabelNum(p.label));
  const rev = seg.slice().reverse();
  rev.forEach((p, k) => { if (nums[k] != null) p.label = setLabelNum(p.label, nums[k]); });
  pins.splice(lo, seg.length, ...rev);
  const from = Math.min(na, nb), to = Math.max(na, nb);
  cancelSwapTwo(true);
  saveToStorage();
  showToast(`↔ ${from}〜${to} の ${seg.length}本を反転しました（元に戻すは↩）`);
}

// R = 2本入替 開始/中止、Esc = 中止（並べ替えモード側のEsc処理とは独立）
(function () {
  function isTyping(e) {
    if (e.isComposing || e.keyCode === 229) return true;
    const t = e.target; if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }
  function overlayOpen() {
    return ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal', 'legend-modal', 'submit-modal']
      .some(function (id) { var el = document.getElementById(id); return el && el.classList.contains('show'); });
  }
  document.addEventListener('keydown', function (e) {
    if (isTyping(e) || overlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      toggleSwapTwoMode();
    } else if (e.key === 'Escape' && swapTwoMode) {
      e.preventDefault();
      cancelSwapTwo();
    }
  });
})();

// --- なぞり並べ替えモード ---
let traceReorderMode = false;
let traceReorderPoints = [];
let traceReorderLine = null;
let traceHighlightedIds = new Set(); // ハイライト中のピンID

function toggleTraceReorder() {
  if (traceReorderMode) {
    cancelTraceReorder();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  exitAllOtherModes('traceReorder');
  normalizePinOrderByLabel();
  traceReorderMode = true;
  pinMode = false;
  traceReorderPoints = [];
  document.getElementById('btn-trace-reorder').classList.add('active');
  document.getElementById('btn-trace-reorder').textContent = '👆 なぞり中...';
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('trace-reorder-banner').classList.add('show');

  // 地図のドラッグを無効化（なぞり用）
  map.dragging.disable();
  // ピン上からなぞり始めるとピンがドラッグで動いてしまう（監査#7）→ なぞり中はマーカーのドラッグも無効化。
  // 終了時は refreshAllMarkers() でマーカーが作り直される（draggable:true）ので戻す処理は不要
  Object.values(markers).forEach(m => { if (m.dragging) m.dragging.disable(); });

  // マウス/タッチでなぞり
  map.getContainer().style.cursor = 'crosshair';
  map.on('mousedown', traceReorderStart);
  map.on('touchstart', traceReorderStart);

  showToast('ピンを横切るように線をなぞってください');
}

function traceReorderStart(e) {
  if (!traceReorderMode) return;
  // ミドルボタン: 地図パン移動
  if (e.originalEvent && e.originalEvent.button === 1) {
    e.originalEvent.preventDefault();
    const startPos = { x: e.originalEvent.clientX, y: e.originalEvent.clientY };
    const startCenter = map.getCenter();
    function onMiddleMove(ev) {
      const dx = ev.clientX - startPos.x;
      const dy = ev.clientY - startPos.y;
      const startPoint = map.latLngToContainerPoint(startCenter);
      map.panTo(map.containerPointToLatLng([startPoint.x - dx, startPoint.y - dy]), { animate: false });
    }
    function onMiddleUp() {
      document.removeEventListener('mousemove', onMiddleMove);
      document.removeEventListener('mouseup', onMiddleUp);
    }
    document.addEventListener('mousemove', onMiddleMove);
    document.addEventListener('mouseup', onMiddleUp);
    return;
  }
  traceReorderPoints = [];
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }

  const latlng = e.latlng || (e.touches && map.mouseEventToLatLng(e.touches[0]));
  if (!latlng) return;
  traceReorderPoints.push(latlng);

  traceReorderLine = L.polyline(traceReorderPoints, {
    color: '#E65100', weight: 3, opacity: 0.7
  }).addTo(map);

  map.on('mousemove', traceReorderMove);
  map.on('touchmove', traceReorderMove);
  map.on('mouseup', traceReorderEnd);
  map.on('touchend', traceReorderEnd);
}

function traceReorderMove(e) {
  if (!traceReorderMode || !traceReorderLine) return;
  const latlng = e.latlng || (e.touches && map.mouseEventToLatLng(e.touches[0]));
  if (!latlng) return;
  traceReorderPoints.push(latlng);
  traceReorderLine.setLatLngs(traceReorderPoints);

  // リアルタイムハイライト: 線の近くのピンをオレンジに
  const threshold = getTraceThresholdPx();
  pins.forEach(pin => {
    if (isHiddenByGroup(pin)) return;
    const pinPx = map.latLngToContainerPoint([pin.lat, pin.lng]);
    const curPx = map.latLngToContainerPoint(latlng);
    const distPx = Math.sqrt(Math.pow(pinPx.x - curPx.x, 2) + Math.pow(pinPx.y - curPx.y, 2));
    if (distPx < threshold && !traceHighlightedIds.has(pin.id)) {
      traceHighlightedIds.add(pin.id);
      const m = markers[pin.id];
      if (m) {
        const el = m.getElement();
        if (el) {
          const icon = el.querySelector('.pin-icon');
          if (icon) {
            icon.style.background = '#E65100';
            icon.style.color = 'white';
            icon.style.transition = 'background 0.15s';
          }
        }
      }
    }
  });
}

// ピクセル単位の閾値（ピンサイズに連動）
function getTraceThresholdPx() {
  return getPinSize() * 0.8 + 5; // ピンの半径+少し余裕
}

function traceReorderEnd() {
  map.off('mousemove', traceReorderMove);
  map.off('touchmove', traceReorderMove);
  map.off('mouseup', traceReorderEnd);
  map.off('touchend', traceReorderEnd);
  // 即時反映（モードは継続）
  if (traceReorderPoints.length >= 2) {
    applyTraceReorder();
  }
}

// 並べ替え実行（モード継続）
function applyTraceReorder() {
  if (traceReorderPoints.length < 2) return;

  // 全てピクセル座標で計算（距離も順序も統一）
  const segsPx = [];
  let cumLen = 0;
  for (let i = 0; i < traceReorderPoints.length - 1; i++) {
    const aPx = map.latLngToContainerPoint(traceReorderPoints[i]);
    const bPx = map.latLngToContainerPoint(traceReorderPoints[i + 1]);
    const dx = bPx.x - aPx.x, dy = bPx.y - aPx.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    segsPx.push({ aPx, bPx, dx, dy, segLen, cumLen });
    cumLen += segLen;
  }

  const thresholdPx = getTraceThresholdPx();
  const visiblePins = pins.filter(p => !isHiddenByGroup(p));
  const nearPins = [];

  visiblePins.forEach(pin => {
    const pinPx = map.latLngToContainerPoint([pin.lat, pin.lng]);
    let minDistPx = Infinity;
    let bestT = 0;

    for (const seg of segsPx) {
      let t = 0;
      if (seg.segLen > 0) {
        t = Math.max(0, Math.min(1,
          ((pinPx.x - seg.aPx.x) * seg.dx + (pinPx.y - seg.aPx.y) * seg.dy) / (seg.segLen * seg.segLen)
        ));
      }
      const px = seg.aPx.x + t * seg.dx;
      const py = seg.aPx.y + t * seg.dy;
      const dist = Math.sqrt(Math.pow(pinPx.x - px, 2) + Math.pow(pinPx.y - py, 2));
      if (dist < minDistPx) {
        minDistPx = dist;
        bestT = seg.cumLen + t * seg.segLen;
      }
    }

    if (minDistPx < thresholdPx) {
      nearPins.push({ pin, t: bestT });
    }
  });

  if (nearPins.length < 2) {
    showToast('近くにピンが足りません');
    if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }
    traceReorderPoints = [];
    traceHighlightedIds.clear();
    refreshAllMarkers();
    return;
  }

  pushUndo();
  nearPins.sort((a, b) => a.t - b.t);

  const targetIds = new Set(nearPins.map(p => p.pin.id));
  let minIdx = pins.length;
  pins.forEach((p, i) => {
    if (targetIds.has(p.id) && i < minIdx) minIdx = i;
  });

  const remaining = pins.filter(p => !targetIds.has(p.id));
  const reordered = nearPins.map(p => p.pin);
  remaining.splice(minIdx, 0, ...reordered);
  pins = remaining;

  // 線を消してリセット（モードは継続）
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }
  traceReorderPoints = [];
  traceHighlightedIds.clear();

  relabelPins();
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  showToast(`${nearPins.length}件を${minIdx + 1}番から並べ替え`);
}

function finishTraceReorder() {
  cancelTraceReorder();
}

function cancelTraceReorder() {
  traceReorderMode = false;
  traceReorderPoints = [];
  traceHighlightedIds.clear();
  if (traceReorderLine) { map.removeLayer(traceReorderLine); traceReorderLine = null; }

  map.dragging.enable();
  map.getContainer().style.cursor = '';
  map.off('mousedown', traceReorderStart);
  map.off('touchstart', traceReorderStart);
  map.off('mousemove', traceReorderMove);
  map.off('touchmove', traceReorderMove);
  map.off('mouseup', traceReorderEnd);
  map.off('touchend', traceReorderEnd);

  document.getElementById('btn-trace-reorder').classList.remove('active');
  document.getElementById('btn-trace-reorder').textContent = '👆 なぞり順';
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('trace-reorder-banner').classList.remove('show');
}

// --- 連結モード ---
let concatMode = false;
let concatFirst = null;  // 前半の終点ピン

function toggleConcatMode() {
  if (concatMode) {
    cancelConcat();
    return;
  }
  if (pins.length < 2) {
    showToast('ピンが2件以上必要です');
    return;
  }
  exitAllOtherModes('concat');
  normalizePinOrderByLabel();
  concatMode = true;
  pinMode = false;
  concatFirst = null;
  document.getElementById('btn-concat').classList.add('active');
  document.getElementById('btn-mode').style.display = 'none';
  document.getElementById('concat-banner').classList.add('show');
  showToast('前半の終点ピンをタップしてください');
}

function handleConcatTap(pinId) {
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;

  const pinNum = getLabelNum(pin.label);

  if (!concatFirst) {
    // 1つ目: 前半の終点
    concatFirst = pin;
    const numText = pinNum ? `#${pinNum}` : `id=${pin.id}`;
    document.getElementById('concat-status').textContent = `${numText} を選択済み → 次は後半の始点をタップ`;
    // ハイライト
    const m = markers[pin.id];
    if (m) {
      const el = m.getElement();
      if (el) {
        const icon = el.querySelector('.pin-icon');
        if (icon) { icon.style.background = '#E91E63'; icon.style.transition = 'background 0.15s'; }
      }
    }
    showToast(`${numText} の後ろに繋げる先をタップ`);
  } else {
    // 2つ目: 後半の始点
    if (pin.id === concatFirst.id) {
      showToast('同じピンです。別のピンをタップしてください');
      return;
    }

    const firstNum = getLabelNum(concatFirst.label);
    const secondNum = pinNum;

    // pins配列でのインデックスを取得
    const firstIdx = pins.indexOf(concatFirst);
    const secondIdx = pins.indexOf(pin);

    if (firstIdx === -1 || secondIdx === -1) {
      showToast('ピンが見つかりません');
      cancelConcat();
      return;
    }
    // 逆方向（後半の始点が前半の終点より前）だと slice が重なりピンが複製される（監査#1）→ 断る
    if (secondIdx <= firstIdx) {
      showToast(`後半の始点は #${firstNum || (firstIdx + 1)} より後ろのピンを選んでください`);
      return;
    }

    pushUndo();

    // 前半: 0〜firstIdx、後半: secondIdx〜末尾、スキップ: firstIdx+1〜secondIdx-1
    const partA = pins.slice(0, firstIdx + 1);
    const partB = pins.slice(secondIdx);
    const skipped = pins.slice(firstIdx + 1, secondIdx);

    pins = [...partA, ...partB, ...skipped];

    const numA = firstNum || (firstIdx + 1);
    const numB = secondNum || (secondIdx + 1);

    // ラベル番号を配列順に振り直し
    relabelPins();

    showToast(`#${numA} → #${numB} に連結しました（${skipped.length}件を後方へ移動）`);

    // マーカー再構築は cancelConcat 内の refreshAllMarkers に任せる（二重再構築防止）
    saveToStorage();
    updatePinCount();
    cancelConcat();
  }
}

function cancelConcat() {
  concatMode = false;
  concatFirst = null;
  document.getElementById('btn-concat').classList.remove('active');
  document.getElementById('btn-mode').style.display = '';
  updateModeBtn();
  document.getElementById('concat-banner').classList.remove('show');
  refreshAllMarkers();
}

// --- 並べ替えのキーボードショートカット（PC作業用） ---
// N=開始 / Backspace・Z=戻す / Enter=完了 / Esc=取消。
// 200件超をタップし続ける作業なので、押し間違いの「戻す」を手元で叩けるのが効く。
// 戻す操作は本来「直前に取り込んだ紫ピンを地図から探してクリック」で、団子の中だと特に面倒だった。
(function () {
  // 入力中（開始番号・検索ボックス・ラベル編集など）は横取りしない。IME変換中も無視。
  function isTyping(e) {
    if (e.isComposing || e.keyCode === 229) return true;
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable;
  }

  // モーダル/凡例等が開いている時は、Escは「それを閉じる」が優先（core.js側が処理する）。
  // ここで並べ替えまで巻き込むと、モーダルを閉じたつもりが作業全消しになる。
  function overlayOpen() {
    return ['pin-modal', 'help-modal', 'sync-modal', 'result-modal', 'place-modal', 'legend-modal', 'submit-modal']
      .some(function (id) {
        var el = document.getElementById(id);
        return el && el.classList.contains('show');
      });
  }

  document.addEventListener('keydown', function (e) {
    if (isTyping(e) || overlayOpen()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // ブラウザ標準操作は邪魔しない

    const k = e.key;
    const isN = (k === 'n' || k === 'N');

    // --- 並べ替えモードに入っていない時: N で開始 ---
    if (!reorderMode) {
      if (!isN) return;
      e.preventDefault();
      // 他のモード（スタンプ・グループ化・まとめて移動等）が動いている時に黙って乗っ取ると、
      // そちらの選択途中の状態が消える。キーの誤爆で起きると原因が分からないので明示的に断る。
      const busy = typeof activeModeName === 'function' ? activeModeName('reorder') : null;
      if (busy) {
        showToast(`「${(typeof MODE_LABELS !== 'undefined' && MODE_LABELS[busy]) || busy}」モード中です。先に終了してください`);
        return;
      }
      toggleReorderMode();
      return;
    }

    // --- 並べ替えモード中 ---
    if (isN) {
      // ここで toggleReorderMode() を呼ぶと cancelReorder＝取り込み全破棄。
      // 誤爆で作業が飛ぶので、終了はEnter/Escに限定する。
      e.preventDefault();
      showToast('並べ替え中です（Enter=完了 / Esc=取消）');
      return;
    }
    if (k === 'Backspace' || k === 'z' || k === 'Z') {
      // 戻す（🏢まとめ取りなら丸ごと）。Backspaceは押しっぱなしで連続リピートも効く
      e.preventDefault();
      if (!undoLastTake()) showToast('戻せる取り込みがありません');
    } else if (k === 'Enter') {
      e.preventDefault();
      finishReorder();
    } else if (k === 'Escape') {
      // 取消は全部捨てる操作。作業が乗っている時だけ確認を挟む
      e.preventDefault();
      if (reorderedPins.length > 0 &&
          !confirm(`並べ替えを取消します。取り込み済みの${reorderedPins.length}件は破棄されます。よろしいですか？`)) return;
      cancelReorder();
    }
  });
})();

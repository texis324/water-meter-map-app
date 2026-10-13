// --- 📤 団子からピンを引き出す（スタック・ムーブ） ---
// 2026-09-17 Tench要望「被ってるピンを右クリックでリストが出るけど、その時にドラッグで一つ引き出せたり、
//   いくつか選択して外に出したりできるようにしたい」
//
// 団子一覧（core.js の openStackList）に2つの出し方を足す:
//   A) 行をドラッグして地図へ落とす → そのピンだけがそこへ移動。☑した行をドラッグすると☑した分まとめて。
//      別のピンの上に落とすと、そのピンと同じ座標にぴったり重なる（別の団子へ移す用途）。
//   B) ☑して「📤 選んだN本を外へ」→ 一覧が閉じて「置き先をクリック」待ち。地図クリック=そこへ／ピンをクリック=そのピンに重ねる。
//      ポップアップが置き先を隠している時・地図を動かしてから置きたい時はこちら。
// どちらも移動先は1点（出したピン同士は重なったまま）。↩1回で戻る。
let stackMoveMode = false;
let stackMovePins = [];

// list を latlng へ（全件同じ座標）。exact=true は参照スナップせず座標ぴったり（既存ピンに重ねる時）
function stackMoveTo(list, latlng, exact) {
  list = list.filter(p => pins.includes(p));
  if (!list.length || !latlng) return 0;
  let lat = latlng.lat, lng = latlng.lng;
  if (!exact && typeof snapToReference === 'function') {
    const s = snapToReference(lat, lng);
    lat = s.lat; lng = s.lng;
  }
  pushUndo();
  list.forEach(p => { p.lat = lat; p.lng = lng; });
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  return list.length;
}

// 団子(同一座標)の中で並び順を入れ替える（Tench要望 2026-10-13「集合住宅の一覧をドラッグで並び替えたい」）
// 一覧に出ている番号つきピンの「番号の集合」はそのまま、並び順に合わせて小さい番号から割り当て直す。
// 例: 191,192,193,194 の4室で 194 を一番上へ → 194番の部屋が191に、191〜193が192〜194になる。
// 番号なしのピンは対象外（一覧の末尾のまま）。old_no・座標・色・メモは触らない。↩1回で戻る。
function stackReorderApply(same, movingPins, insertBeforePin) {
  const numbered = same.filter(p => getLabelNum(p.label) !== null)
    .sort((a, b) => getLabelNum(a.label) - getLabelNum(b.label));
  const mv = movingPins.filter(p => numbered.includes(p));
  if (!mv.length) return 0;
  const rest = numbered.filter(p => !mv.includes(p));
  let at = insertBeforePin ? rest.indexOf(insertBeforePin) : rest.length;
  if (at < 0) at = rest.length;
  const order = [...rest.slice(0, at), ...mv, ...rest.slice(at)];
  const nums = numbered.map(p => getLabelNum(p.label));       // すでに昇順
  const before = numbered.map(p => p.id).join(',');
  if (order.map(p => p.id).join(',') === before) return 0;    // 並びが変わらない
  pushUndo();
  order.forEach((p, k) => { p.label = setLabelNum(p.label, nums[k]); });
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  return mv.length;
}

function stackMoveDescribe(list) {
  if (list.length === 1) {
    const n = getLabelNum(list[0].label);
    return `#${n !== null ? n : '–'} ${stripLabelNum(list[0].label).slice(0, 16)}`;
  }
  const nums = list.map(p => getLabelNum(p.label)).filter(n => n !== null);
  return `${list.length}本` + (nums.length ? `（🔢 ${formatNumRanges(nums)}）` : '');
}

// 画面座標の真下にあるピン（マーカーアイコン）を返す。無ければ null
function stackMovePinAt(clientX, clientY) {
  const under = document.elementFromPoint(clientX, clientY);
  const icon = under && under.closest ? under.closest('.leaflet-marker-icon') : null;
  if (!icon) return null;
  for (const id in markers) {
    if (markers[id] && markers[id]._icon === icon) return pins.find(p => String(p.id) === String(id)) || null;
  }
  return null;
}

// openStackList から呼ばれる。el=ポップアップ要素 / same=その団子のピン（番号順）
function wireStackMove(el, popup, same) {
  const rows = Array.from(el.querySelectorAll('.stack-row'));
  const chks = rows.map(r => r.querySelector('.stack-chk'));
  const chkAll = el.querySelector('.stack-chk-all');
  const btn = el.querySelector('.stack-move-btn');
  if (!rows.length || !btn || !chkAll || chks.some(c => !c)) return;
  const pinOfRow = r => same.find(p => p.id === parseInt(r.getAttribute('data-pin-id')));
  const checkedPins = () => rows.filter((r, i) => chks[i].checked).map(pinOfRow).filter(Boolean);
  let lastIdx = -1;

  function sync() {
    const n = chks.filter(c => c.checked).length;
    rows.forEach((r, i) => r.classList.toggle('stack-row-checked', chks[i].checked));
    btn.disabled = n === 0;
    btn.textContent = n ? `📤 選んだ${n}本を外へ` : '📤 ☑した分を外へ';
    chkAll.checked = n === chks.length;
    chkAll.indeterminate = n > 0 && n < chks.length;
  }

  chks.forEach((c, i) => {
    c.addEventListener('click', ev => {
      ev.stopPropagation();   // 行タップ（詳細編集）に抜けないように
      if (ev.shiftKey && lastIdx >= 0) {   // Shift+クリック = 前に触った行からここまで同じ状態に
        const a = Math.min(lastIdx, i), b = Math.max(lastIdx, i);
        for (let k = a; k <= b; k++) chks[k].checked = c.checked;
      }
      lastIdx = i;
      sync();
    });
  });
  chkAll.addEventListener('click', ev => {
    ev.stopPropagation();
    chks.forEach(c => { c.checked = chkAll.checked; });
    sync();
  });
  btn.addEventListener('click', ev => {
    ev.stopPropagation();
    const list = checkedPins();
    if (!list.length) return;
    map.closePopup(popup);
    startStackMove(list);
  });
  sync();

  // --- A) 行ドラッグ（マウス/ペンのみ。タッチは一覧のスクロールと衝突するので B を使う） ---
  rows.forEach((row, i) => {
    row.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'touch' || ev.button !== 0) return;
      if (ev.target.closest('.stack-chk')) return;
      const sx = ev.clientX, sy = ev.clientY;
      let dragging = false, ghost = null, list = null, mode = 'pull', reorderTarget;
      const bodyEl = el.querySelector('.stack-body');
      const pointInBody = (x, y) => {
        if (!bodyEl) return false;
        const r = bodyEl.getBoundingClientRect();
        return x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4;
      };
      const clearDropMarks = () => rows.forEach(r => r.classList.remove('stack-drop-before', 'stack-drop-after'));
      // ポインタの高さから「どの行の前に入れるか」を決める（動かしている行は数えない）
      const dropTargetAt = (y, moving) => {
        const others = rows.filter(r => !moving.some(p => p.id === parseInt(r.getAttribute('data-pin-id'))));
        for (const r of others) {
          const b = r.getBoundingClientRect();
          if (y < b.top + b.height / 2) return { row: r, pin: pinOfRow(r), lastRow: null };
        }
        return { row: null, pin: null, lastRow: others[others.length - 1] || null };
      };

      const cleanup = () => {
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('keydown', onKey, true);
        if (ghost) { ghost.remove(); ghost = null; }
        clearDropMarks();
        rows.forEach(r => r.classList.remove('stack-row-dragging'));
        el.style.opacity = '';
        el.style.pointerEvents = '';
        document.body.classList.remove('stack-dragging');
      };
      // ドラッグ後に出る click を1回だけ飲む（行→詳細モーダル、地図→ピン追加 が暴発するため）
      const swallowClick = () => {
        const eat = e => { e.stopPropagation(); e.preventDefault(); };
        window.addEventListener('click', eat, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', eat, true), 80);
      };
      const onMove = e => {
        if (!dragging) {
          if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
          dragging = true;
          // ☑した行を掴んだら☑した分まとめて。☑していない行ならその1本だけ
          const chosen = checkedPins();
          list = (chks[i].checked && chosen.length > 1) ? chosen : [pinOfRow(row)].filter(Boolean);
          ghost = document.createElement('div');
          ghost.className = 'stack-ghost';
          document.body.appendChild(ghost);
          document.body.classList.add('stack-dragging');
          list.forEach(p => { const r = rows.find(x => parseInt(x.getAttribute('data-pin-id')) === p.id); if (r) r.classList.add('stack-row-dragging'); });
        }
        ghost.style.left = (e.clientX + 14) + 'px';
        ghost.style.top = (e.clientY + 14) + 'px';
        // 一覧の本体の中なら「並び替え」、外なら「地図へ引き出し」
        reorderTarget = undefined;
        clearDropMarks();
        if (pointInBody(e.clientX, e.clientY) && list.every(p => getLabelNum(p.label) !== null)) {
          mode = 'reorder';
          el.style.opacity = ''; el.style.pointerEvents = '';
          const t = dropTargetAt(e.clientY, list);
          reorderTarget = t.pin;                                   // null=最後へ
          if (t.row) t.row.classList.add('stack-drop-before'); else if (t.lastRow) t.lastRow.classList.add('stack-drop-after');
          ghost.textContent = '↕ ' + stackMoveDescribe(list) + ' を並び替え';
        } else {
          mode = 'pull';
          el.style.opacity = '0.3';            // 一覧の下にも落とせるよう透かして素通しに
          el.style.pointerEvents = 'none';
          ghost.textContent = '📤 ' + stackMoveDescribe(list);
        }
      };
      const onKey = e => {
        if (e.key !== 'Escape') return;
        e.preventDefault(); e.stopPropagation();
        const was = dragging;
        cleanup();
        if (was) showToast('📤 引き出しを取り消しました');
      };
      const onUp = e => {
        const was = dragging, moving = list, wasReorder = (mode === 'reorder'), target = reorderTarget;
        if (was && wasReorder) {
          cleanup();
          swallowClick();
          const before = same.filter(p => getLabelNum(p.label) !== null).sort((a, b) => getLabelNum(a.label) - getLabelNum(b.label));
          const nums = before.map(p => getLabelNum(p.label));
          const n = stackReorderApply(same, moving, target);
          if (!n) { showToast('↕ 並びは変わりません'); return; }
          const after = same.filter(p => getLabelNum(p.label) !== null).sort((a, b) => getLabelNum(a.label) - getLabelNum(b.label));
          const first = moving[0];
          showToast(`↕ ${stackMoveDescribe(moving)} を並び替えました（#${first ? getLabelNum(first.label) : '–'} に・番号 ${formatNumRanges(nums)} の中で振り直し・↩で戻せます）`);
          map.closePopup(popup);
          openStackList(after[0] || same[0]);   // 続けて並び替えられるよう開き直す
          return;
        }
        const under = was ? document.elementFromPoint(e.clientX, e.clientY) : null;   // cleanup 前＝一覧が素通しのうちに判定
        const onPin = was ? stackMovePinAt(e.clientX, e.clientY) : null;
        cleanup();
        if (!was) return;   // 動かしていない＝ただのクリック（詳細編集へ）
        swallowClick();
        if (!under || !map.getContainer().contains(under) || under.closest('.leaflet-control')) {
          showToast('📤 地図の上で離してください（取り消しました）');
          return;
        }
        let n, msg;
        if (onPin) {
          if (onPin.lat === same[0].lat && onPin.lng === same[0].lng) { showToast('📤 元の団子の上です（そのまま）'); return; }
          n = stackMoveTo(moving, L.latLng(onPin.lat, onPin.lng), true);
          const tn = getLabelNum(onPin.label);
          msg = `📤 ${stackMoveDescribe(moving)} を #${tn !== null ? tn : '–'} に重ねました（↩で戻せます）`;
        } else {
          n = stackMoveTo(moving, map.mouseEventToLatLng(e), false);
          msg = `📤 ${stackMoveDescribe(moving)} を引き出しました（↩で戻せます）`;
        }
        if (!n) return;
        map.closePopup(popup);
        showToast(msg);
        // 1本ずつ続けて引き出せるよう、残りが団子のままなら一覧を開き直す
        const rest = same.filter(p => !moving.includes(p));
        if (moving.length === 1 && rest.length >= 2) openStackList(rest[0]);
      };
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('keydown', onKey, true);
    });
  });
}

// --- B) 置き先クリック待ち ---
function startStackMove(list) {
  list = (list || []).filter(p => pins.includes(p));
  if (!list.length) return;
  exitAllOtherModes('stackMove');
  stackMoveMode = true;
  stackMovePins = list;
  document.getElementById('stack-move-desc').textContent = stackMoveDescribe(list);
  document.getElementById('stack-move-banner').classList.add('show');
  map.getContainer().style.cursor = 'crosshair';
  // タップがドラッグに化けないように（終了時の refreshAllMarkers で元に戻る）
  for (const id in markers) {
    const m = markers[id];
    if (m && m.dragging) m.dragging.disable();
  }
  showToast(`📤 ${stackMoveDescribe(list)} の置き先をクリックしてください（Esc=取消）`);
}

// core.js の 地図click / マーカーclick から呼ばれる。onPin があればそのピンにぴったり重ねる
function stackMovePlace(latlng, onPin) {
  if (!stackMoveMode) return;
  const moving = stackMovePins;
  if (onPin && moving.includes(onPin)) { showToast('それは移動中のピンです。置き先をクリックしてください'); return; }
  if (onPin && moving.length && onPin.lat === moving[0].lat && onPin.lng === moving[0].lng) { showToast('📤 元の団子の上です。別の場所をクリックしてください'); return; }
  exitStackMove();
  const n = onPin ? stackMoveTo(moving, L.latLng(onPin.lat, onPin.lng), true) : stackMoveTo(moving, latlng, false);
  if (!n) { refreshAllMarkers(); return; }
  const tn = onPin ? getLabelNum(onPin.label) : null;
  showToast(onPin
    ? `📤 ${stackMoveDescribe(moving)} を #${tn !== null ? tn : '–'} に重ねました（↩で戻せます）`
    : `📤 ${stackMoveDescribe(moving)} を外に出しました（↩で戻せます）`);
}

function cancelStackMove(silent) {
  if (!stackMoveMode) return;
  exitStackMove();
  refreshAllMarkers();
  if (!silent) showToast('📤 外へ出す を取り消しました');
}

function exitStackMove() {
  stackMoveMode = false;
  stackMovePins = [];
  map.getContainer().style.cursor = '';
  const b = document.getElementById('stack-move-banner');
  if (b) b.classList.remove('show');
}

// Esc で取消
document.addEventListener('keydown', function (e) {
  if (!stackMoveMode || e.key !== 'Escape') return;
  e.preventDefault();
  cancelStackMove();
});

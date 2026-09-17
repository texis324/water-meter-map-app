// --- ↔ 前後のピンの中間へ（要位置確認ピンの仮置き補助） ---
// 2026-09-17 Tench案「要確認のピンは、その番号の前後2つの中間地点に置けば近いところに配置されるはず」
//
// 順路は基本的に隣の家へ進むので、位置が怪しいピン（赤＝要位置確認。住所検索が外れて遠くへ飛んでいる事が多い）は
// 「一つ前の番号のピン」と「一つ後の番号のピン」の間に置けば、だいたいその辺まで寄る。あとは本人が微調整する。
//   ・基準にするのは「番号があり、赤ではなく、今回動かす対象でもない」ピンだけ（赤同士を基準にすると誤差が伝染する）
//   ・赤が連続している所（例: 182〜190 が全部赤）は、手前の基準 A と先の基準 B の間に等間隔で並べる
//   ・連なりの中で今も同じ座標に重なっているピン（団子＝同じ建物）は、重ねたまま1点へ動かす
//   ・片側にしか基準が無い（先頭/末尾）ときは、その基準のすぐ横に少しずつずらして置く
// 色は変えない（赤のまま＝まだ仮置き。位置を確かめたら本人が色を外す）。↩1回で全部戻る。
const BETWEEN_UNSURE_COLOR = '#f44336';

function isUnsurePin(p) { return (p.color || '').toLowerCase() === BETWEEN_UNSURE_COLOR; }

// targets の置き先を計算して [{pin, lat, lng, a, b}] を返す（a/b=基準にした前後のピン。無い側は null）
function betweenPlan(targets) {
  const tset = new Set(targets);
  const seq = pins.map(p => ({ p, n: getLabelNum(p.label) })).filter(x => x.n !== null).sort((x, y) => x.n - y.n);
  const isRef = x => !tset.has(x.p) && !isUnsurePin(x.p);
  const plan = [];
  let i = 0;
  while (i < seq.length) {
    if (isRef(seq[i])) { i++; continue; }
    let j = i;
    while (j < seq.length && !isRef(seq[j])) j++;      // seq[i..j-1] = 基準にならないピンの連なり
    const a = i > 0 ? seq[i - 1].p : null;
    const b = j < seq.length ? seq[j].p : null;
    // 連なりの中で「番号が続いていて今も同じ座標に重なっているピン」は1つの塊（団子＝同じ建物）として扱い、
    // 置き先も同じ1点にする（等間隔に並べると、せっかく重ねた集合住宅がバラけてしまう）
    const slotOf = [];
    let k = 0;
    for (let m = i; m < j; m++) {
      const prev = m > i ? seq[m - 1].p : null;
      if (!prev || prev.lat !== seq[m].p.lat || prev.lng !== seq[m].p.lng) k++;
      slotOf.push(k - 1);
    }
    for (let idx = 0; idx < j - i; idx++) {
      const pin = seq[i + idx].p;
      const m = slotOf[idx];
      if (!tset.has(pin)) continue;                     // 対象外の赤は場所だけ詰めて動かさない
      let lat, lng;
      if (a && b) {
        const t = (m + 1) / (k + 1);
        lat = a.lat + (b.lat - a.lat) * t;
        lng = a.lng + (b.lng - a.lng) * t;
      } else if (a || b) {
        const r = a || b;
        const step = (a ? (m + 1) : (k - m)) * 0.00006;  // 約5.5mずつ東へずらす（基準と団子にならないように）
        lat = r.lat; lng = r.lng + step;
      } else continue;                                   // 基準が1本も無い
      plan.push({ pin, lat, lng, a, b });
    }
    i = j;
  }
  return plan;
}

function betweenApply(plan) {
  if (!plan.length) return 0;
  pushUndo();
  plan.forEach(x => { x.pin.lat = x.lat; x.pin.lng = x.lng; });
  refreshAllMarkers();
  saveToStorage();
  updatePinCount();
  return plan.length;
}

function betweenNumTxt(p) { const n = p ? getLabelNum(p.label) : null; return n !== null ? '#' + n : '–'; }

// ピン詳細モーダルのボタン: このピンを前後の中間へ
function movePinBetweenNeighbors() {
  const pin = pins.find(p => p.id === editingPinId);
  if (!pin) return;
  if (getLabelNum(pin.label) === null) { showToast('このピンには番号が無いので、前後が分かりません'); return; }
  const plan = betweenPlan([pin]);
  if (!plan.length) { showToast('基準にできる前後のピンがありません'); return; }
  const x = plan[0];
  const from = map.distance([pin.lat, pin.lng], [x.lat, x.lng]);
  closeModal();
  betweenApply(plan);
  map.panTo([x.lat, x.lng]);
  const fromTxt = from >= 1000 ? (from / 1000).toFixed(1) + 'km' : Math.round(from) + 'm';
  const where = (x.a && x.b) ? `${betweenNumTxt(x.a)} と ${betweenNumTxt(x.b)} の中間` : `${betweenNumTxt(x.a || x.b)} のすぐ横`;
  showToast(`↔ ${betweenNumTxt(pin)} を ${where} に置きました（${fromTxt}先から・↩で戻せます）`);
}

// モーダルを開いた時にボタンの文言を「#70 と #72 の中間へ」に更新（core.js の openModal から呼ばれる）
function updateBetweenButton(pin) {
  const btn = document.getElementById('btn-pin-between');
  if (!btn) return;
  const plan = (pin && getLabelNum(pin.label) !== null) ? betweenPlan([pin]) : [];
  btn.disabled = !plan.length;
  if (!plan.length) { btn.textContent = '↔ 前後のピンの中間へ移動'; return; }
  const x = plan[0];
  btn.textContent = (x.a && x.b)
    ? `↔ 前後の中間へ移動（${betweenNumTxt(x.a)} と ${betweenNumTxt(x.b)} の間）`
    : `↔ ${betweenNumTxt(x.a || x.b)} のすぐ横へ移動`;
}

// 編集メニュー: 赤ピン（要位置確認）を全部まとめて前後の中間へ
function moveAllUnsureBetween() {
  const targets = pins.filter(p => isUnsurePin(p) && getLabelNum(p.label) !== null);
  if (!targets.length) { showToast('赤ピン（要位置確認）がありません'); return; }
  const plan = betweenPlan(targets);
  if (!plan.length) { showToast('基準にできる赤以外のピンがありません'); return; }
  const nums = plan.map(x => getLabelNum(x.pin.label));
  const far = plan.filter(x => map.distance([x.pin.lat, x.pin.lng], [x.lat, x.lng]) > 30).length;
  if (!confirm(`赤ピン（要位置確認）${plan.length}本を、それぞれ番号の前後にある「赤ではないピン」の間へ仮置きします。\n\n🔢 ${formatNumRanges(nums)}\n（うち30m以上動くのは ${far}本。赤が続く所は等間隔に並べ、重なっている団子は重ねたまま動かします）\n\n色は赤のまま残ります。↩戻す1回で全部戻せます。`)) return;
  exitAllOtherModes(null);
  const n = betweenApply(plan);
  showToast(`↔ 赤ピン ${n}本を前後の中間へ仮置きしました（↩で戻せます）`);
}

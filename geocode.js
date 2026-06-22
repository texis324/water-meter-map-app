// --- 逆ジオコーディング ---
let reversePopup = null;
// 並行fetch対策: 連打時に前回リクエストをキャンセルする
let reverseGeocodeAbortController = null;

// 番地を正規化（全角→半角、ハイフン統一）して比較用文字列を返す
function normalizeBanchi(str) {
  return str.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
            .replace(/[－ー−]/g, '-')
            .replace(/\s+/g, '');
}

// ラベルから番地部分を抽出（例: "3. 伊勢市尾上町４－６ 大西 基" → "4-6"）
function extractBanchi(label) {
  const m = label.match(/尾上町([０-９0-9－\-ー−]+)/);
  return m ? normalizeBanchi(m[1]) : '';
}

function reverseGeocode(lat, lng) {
  const apiKey = typeof GOOGLE_API_KEY !== 'undefined' ? GOOGLE_API_KEY : '';
  if (!apiKey) { showToast('APIキーが未設定です'); return; }
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=ja&key=${apiKey}`;

  // 前回のリクエストが進行中なら中断（連打時のpopup上書き/復活レース対策）
  if (reverseGeocodeAbortController) {
    reverseGeocodeAbortController.abort();
  }
  reverseGeocodeAbortController = new AbortController();
  const myController = reverseGeocodeAbortController;

  fetch(url, { signal: myController.signal }).then(r => r.json()).then(data => {
    // 自分が最新のリクエストでない場合は結果を破棄
    if (myController !== reverseGeocodeAbortController) return;
    if (data.status === 'OK' && data.results.length > 0) {
      const addr = data.results[0].formatted_address.replace(/^日本、〒[\d－\-]+\s*/, '');
      // 住所から番地を抽出
      const banchiMatch = addr.match(/尾上町([0-9０-９－\-ー−]+)/);
      const clickedBanchi = banchiMatch ? normalizeBanchi(banchiMatch[1]) : '';

      // 一致するピンを検索
      let matched = [];
      if (clickedBanchi) {
        matched = pins.filter(p => extractBanchi(p.label || '') === clickedBanchi);
      }

      // 一致なしの場合、重複ピンの中から近い順に候補表示
      let nearby = [];
      if (matched.length === 0) {
        // 同じ座標に2件以上あるピンのみ候補にする
        const dupPins = pins.filter(p => pins.some(q => q.id !== p.id && q.lat === p.lat && q.lng === p.lng));
        nearby = dupPins.map(p => ({
          pin: p,
          dist: Math.sqrt(Math.pow(p.lat - lat, 2) + Math.pow(p.lng - lng, 2))
        })).sort((a, b) => a.dist - b.dist).slice(0, 5);
      }

      if (reversePopup) map.closePopup(reversePopup);

      // 番号指定で呼び寄せる入力欄（共通）
      const callInput = `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #ddd;display:flex;gap:4px;align-items:center;">
        <span style="font-size:12px;font-weight:bold;white-space:nowrap;">📢 呼出:</span>
        <input type="number" id="call-pin-num" min="1" placeholder="#" style="width:60px;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:16px;text-align:center;" onkeydown="if(event.key==='Enter'){callPinHere(${lat},${lng});event.preventDefault();}">
        <button onclick="callPinHere(${lat},${lng})" style="padding:3px 10px;border:none;border-radius:4px;background:#1976D2;color:white;font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap;">移動</button>
      </div>`;

      // 近くのピンの番号を取得して、その番号に近い重複ピンを候補にする
      const getNum = lbl => { const m = (lbl||'').match(/^(\d+)\./); return m ? parseInt(m[1]) : null; };
      const nearbyNums = pins.map(p => ({
        num: getNum(p.label),
        dist: Math.sqrt(Math.pow(p.lat - lat, 2) + Math.pow(p.lng - lng, 2))
      })).filter(x => x.num !== null).sort((a, b) => a.dist - b.dist).slice(0, 5).map(x => x.num);
      const avgNum = nearbyNums.length > 0 ? Math.round(nearbyNums.reduce((a,b)=>a+b,0) / nearbyNums.length) : 0;

      // 重複ピンを番号の近さ順で候補リスト生成
      const dupPins = pins.filter(p => pins.some(q => q.id !== p.id && q.lat === p.lat && q.lng === p.lng));
      const candidates = dupPins.map(p => ({ pin: p, num: getNum(p.label) || 0 }))
        .sort((a, b) => b.num - a.num);
      const candidateHtml = candidates.map(c => {
        const p = c.pin;
        const isNearest = c.num === candidates.reduce((best, x) =>
          Math.abs(x.num - avgNum) < Math.abs(best.num - avgNum) ? x : best, candidates[0]).num;
        return `<div id="cand-${c.num}" style="margin:2px 0;display:flex;align-items:center;gap:4px;${isNearest ? 'background:#E3F2FD;border-radius:4px;padding:2px;' : ''}">
          <span style="flex:1;font-size:11px;">${escapeHtml(p.label || 'ピン')}</span>
          <button onclick="moveSinglePin(${p.id},${lat},${lng})" style="padding:2px 8px;border:none;border-radius:4px;background:#4CAF50;color:white;font-size:11px;cursor:pointer;white-space:nowrap;">移動</button>
        </div>`;
      }).join('');
      const candidateSection = candidates.length > 0
        ? `<div style="font-size:11px;color:#999;margin:4px 0;">候補（#${avgNum}付近）:</div>
           <div id="candidate-list" style="max-height:120px;overflow-y:auto;border-top:1px solid #eee;padding-top:4px;">${candidateHtml}</div>`
        : '';

      if (matched.length > 0) {
        const names = matched.map(p => {
          return `<div style="margin:2px 0;">${escapeHtml(p.label || 'ピン')}</div>`;
        }).join('');
        reversePopup = L.popup({ closeButton: true, className: 'reverse-popup', maxWidth: 400 })
          .setLatLng([lat, lng])
          .setContent(`<b>📍 ${escapeHtml(addr)}</b><hr style="margin:4px 0;">
            <div style="font-size:12px;color:#1976D2;font-weight:bold;">一致するピン: ${matched.length}件</div>
            <div style="max-height:80px;overflow-y:auto;font-size:12px;">${names}</div>
            <button onclick="moveMatchedPins(${lat},${lng},'${clickedBanchi}')" style="margin-top:4px;padding:4px 12px;border:none;border-radius:4px;background:#4CAF50;color:white;font-weight:bold;cursor:pointer;width:100%;">📍 ここにピンを移動</button>
            ${callInput}`)
          .openOn(map);
      } else {
        reversePopup = L.popup({ closeButton: true, className: 'reverse-popup', maxWidth: 400 })
          .setLatLng([lat, lng])
          .setContent(`<b>📍 ${escapeHtml(addr)}</b>
            ${candidateSection}
            ${callInput}`)
          .openOn(map);
        // 該当番号付近に自動スクロール
        setTimeout(() => {
          if (candidates.length === 0) return;
          const nearest = candidates.reduce((best, x) =>
            Math.abs(x.num - avgNum) < Math.abs(best.num - avgNum) ? x : best, candidates[0]);
          if (!nearest) return;
          const el = document.getElementById('cand-' + nearest.num);
          if (el) el.scrollIntoView({ block: 'center' });
        }, 100);
      }
    } else {
      showToast('住所を取得できませんでした');
    }
    // 完了したら自分のコントローラーをクリア
    if (myController === reverseGeocodeAbortController) {
      reverseGeocodeAbortController = null;
    }
  }).catch(err => {
    // AbortError（新しいリクエストにより中断）はtoastを出さない
    if (err && err.name === 'AbortError') return;
    showToast('住所取得エラー');
  });
}

// 番号指定でピンをクリック位置に呼び寄せる
function callPinHere(lat, lng) {
  const input = document.getElementById('call-pin-num');
  if (!input) return;
  const num = parseInt(input.value);
  if (!num || num < 1) { showToast('番号を入力してください'); return; }
  const pin = pins.find(p => {
    const m = (p.label || '').match(/^(\d+)\./);
    return m && parseInt(m[1]) === num;
  });
  if (!pin) { showToast(`#${num} のピンが見つかりません`); return; }
  pushUndo();
  pin.lat = lat;
  pin.lng = lng;
  if (reversePopup) map.closePopup(reversePopup);
  refreshAllMarkers();
  saveToStorage();
  showToast(`#${num} ${pin.label} をここに移動しました`);
}

// 個別ピンをクリック位置に移動
function moveSinglePin(pinId, lat, lng) {
  const pin = pins.find(p => p.id === pinId);
  if (!pin) return;
  pushUndo();
  pin.lat = lat;
  pin.lng = lng;
  if (reversePopup) map.closePopup(reversePopup);
  refreshAllMarkers();
  saveToStorage();
  showToast(`${pin.label || 'ピン'} を移動しました`);
}

// 一致ピンをクリック位置に移動
function moveMatchedPins(lat, lng, banchi) {
  const matched = pins.filter(p => extractBanchi(p.label || '') === banchi);
  if (matched.length === 0) return;
  pushUndo();
  matched.forEach(p => {
    p.lat = lat;
    p.lng = lng;
  });
  if (reversePopup) map.closePopup(reversePopup);
  refreshAllMarkers();
  saveToStorage();
  showToast(`${matched.length}件のピンをここに移動しました`);
}

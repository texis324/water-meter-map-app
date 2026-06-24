// legend.js — ピンの色の意味(凡例)機能
// 各色に意味ラベルを付け、編集モーダル＋地図左下の常時表示凡例を出す。
// 保存: localStorage 'waterMeterColorLegend' = { 色(lowercase): 意味 }
// 色の比較は全て小文字化して行う(データは #FFA500 等の大文字・プリセットは大小混在のため)。
(function () {
  'use strict';
  const LS_KEY = 'waterMeterColorLegend';
  const SHOW_KEY = 'waterMeterLegendShow';
  // 分かっている既定の意味(未設定の色にだけ補完)
  const DEFAULTS = { '#f44336': '要位置確認（自動・未確定）' };

  function norm(c) { return (c || '').trim().toLowerCase(); }
  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function loadLegend() {
    let m = {};
    try { m = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) {}
    const out = {};
    Object.keys(DEFAULTS).forEach(k => { out[norm(k)] = DEFAULTS[k]; });
    Object.keys(m).forEach(k => { out[norm(k)] = m[k]; });
    return out;
  }
  function saveLegend(m) {
    // 既定値と同一のものは保存しない(将来DEFAULT変更を反映できるように)
    const store = {};
    Object.keys(m).forEach(k => { if (!(DEFAULTS[k] && DEFAULTS[k] === m[k])) store[k] = m[k]; });
    localStorage.setItem(LS_KEY, JSON.stringify(store));
    pushLegendToCloud();
  }

  let legend = loadLegend();

  // ---- クラウド同期(全デバイス共有: meta/legend ドキュメント) ----
  // 色の意味は全エリア共通。ログイン時に cloud→local を反映し、編集時に local→cloud へ push。
  const CLOUD = (typeof firebase !== 'undefined' && firebase.firestore);
  function legendDoc() { return firebase.firestore().collection('meta').doc('legend'); }
  function legendUser() { try { return firebase.auth().currentUser; } catch (e) { return null; } }
  function storeOf(m) {
    const s = {};
    Object.keys(m).forEach(k => { if (!(DEFAULTS[k] && DEFAULTS[k] === m[k])) s[k] = m[k]; });
    return s;
  }
  function pushLegendToCloud() {
    if (!CLOUD || !legendUser()) return;
    try {
      legendDoc().set({
        legend: storeOf(legend),
        clientTime: Date.now(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { console.warn('[legend] push失敗', e); }
  }
  function pullLegendFromCloud() {
    if (!CLOUD || !legendUser()) return;
    legendDoc().get().then(function (snap) {
      if (!snap.exists) return;
      const cl = (snap.data() && snap.data().legend) || {};
      const store = {};
      Object.keys(cl).forEach(function (k) {
        if (!(DEFAULTS[norm(k)] && DEFAULTS[norm(k)] === cl[k])) store[norm(k)] = cl[k];
      });
      localStorage.setItem(LS_KEY, JSON.stringify(store));
      legend = loadLegend();
      if (window.refreshMapLegend) window.refreshMapLegend();
      console.log('[legend] cloud pull: ' + Object.keys(store).length + '色');
    }).catch(function (e) { console.warn('[legend] pull失敗', e); });
  }
  if (CLOUD) {
    try { firebase.auth().onAuthStateChanged(function (u) { if (u) pullLegendFromCloud(); }); } catch (e) {}
  }

  // 現在地図で使われている色 -> 件数 (空文字=通常ピンは除外)
  function usedColors() {
    const c = {};
    // pins は core.js の let 宣言(window には乗らない)。他JSと同様 bare 参照する。
    const arr = (typeof pins !== 'undefined' && pins) ? pins : [];
    arr.forEach(p => {
      const col = norm(p.color);
      if (!col) return;
      c[col] = (c[col] || 0) + 1;
    });
    return c;
  }

  // 他ファイルから色の意味を引きたい時用
  window.getColorMeaning = function (hex) { return legend[norm(hex)] || ''; };

  function legendVisible() { return localStorage.getItem(SHOW_KEY) !== 'off'; }

  // ---- 地図左下の常時表示凡例 ----
  function ensureMapBox() {
    let box = document.getElementById('map-legend');
    if (!box) { box = document.createElement('div'); box.id = 'map-legend'; document.body.appendChild(box); }
    return box;
  }

  window.refreshMapLegend = function () {
    const box = ensureMapBox();
    const used = usedColors();
    const cols = Object.keys(used).filter(c => legend[c]).sort((a, b) => used[b] - used[a]);
    if (!legendVisible() || cols.length === 0) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.innerHTML =
      '<div class="ml-head"><span>🏷 色の凡例</span><span id="ml-edit">編集</span></div>' +
      cols.map(c =>
        `<div class="ml-row"><span class="ml-dot" style="background:${c}"></span>` +
        `<span class="ml-txt">${esc(legend[c])}</span><span class="ml-cnt">${used[c]}</span></div>`
      ).join('');
    const e = document.getElementById('ml-edit');
    if (e) e.onclick = window.openLegend;
  };

  // ---- 編集モーダル ----
  function renderRows() {
    const body = document.getElementById('legend-body');
    if (!body) return;
    const used = usedColors();
    const keys = [...new Set([...Object.keys(used), ...Object.keys(legend)])];
    if (keys.length === 0) {
      body.innerHTML = '<div style="color:#888;font-size:13px;padding:8px 0;line-height:1.6;">色付きのピンがまだありません。<br>ピンを右クリック→🎨ピン色 で色を付けると、ここに意味を登録できます。</div>';
      return;
    }
    keys.sort((a, b) => (used[b] || 0) - (used[a] || 0));
    body.innerHTML = keys.map(c =>
      `<div class="legend-erow">` +
      `<span class="legend-dot" style="background:${c}"></span>` +
      `<div class="legend-meta">` +
      `<input class="legend-input" data-color="${c}" value="${esc(legend[c] || '').replace(/"/g, '&quot;')}" placeholder="意味（例: アパート / 閉栓 / 要注意）">` +
      `<span class="legend-sub">${c} ・ ${(used[c] || 0)}件</span>` +
      `</div></div>`
    ).join('');
    body.querySelectorAll('.legend-input').forEach(inp => {
      inp.addEventListener('change', () => {
        const col = inp.getAttribute('data-color');
        const v = inp.value.trim();
        if (v) legend[col] = v; else delete legend[col];
        saveLegend(legend);
        window.refreshMapLegend();
      });
    });
  }

  window.openLegend = function () {
    legend = loadLegend();
    renderRows();
    const t = document.getElementById('legend-show-toggle');
    if (t) t.checked = legendVisible();
    const m = document.getElementById('legend-modal');
    if (m) m.classList.add('show');
  };
  window.closeLegend = function () {
    const m = document.getElementById('legend-modal');
    if (m) m.classList.remove('show');
  };
  window.toggleMapLegend = function () {
    localStorage.setItem(SHOW_KEY, legendVisible() ? 'off' : 'on');
    window.refreshMapLegend();
    if (typeof showToast === 'function') showToast(legendVisible() ? '地図に凡例を表示' : '地図の凡例を非表示');
  };

  // 初回描画(pins復元後に間に合うよう少し遅延)
  setTimeout(function () { try { window.refreshMapLegend(); } catch (e) {} }, 700);
})();

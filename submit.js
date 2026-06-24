// submit.js — 会社提出用「旧順表」生成
// old_no(古い順序/Mscope元番号)を持つピンを旧番号順に並べ、
// 新番号(現在の検針順=labelの先頭番号)を隣に出す。画面表示＋CSVダウンロード。
// 運用: 地図では新しい順(歩きたい順)で作業 → この表が「旧順に並べ、新番号を隣に書いた」提出形。
(function () {
  'use strict';
  function arr() { return (typeof pins !== 'undefined' && pins) ? pins : []; }

  // label "新No. 住所 使用者名" を {no, rest} に分解
  function parseLabel(label) {
    const m = (label || '').match(/^\s*(\d+(?:\.\d+)?)[\.．]\s*(.*)$/);
    return m ? { no: m[1], rest: m[2] } : { no: '', rest: (label || '') };
  }
  function hasOld(p) { return p.old_no !== undefined && p.old_no !== null && String(p.old_no).trim() !== ''; }

  function buildRows() {
    const rows = arr().filter(hasOld).map(p => {
      const pl = parseLabel(p.label);
      return { oldNo: String(p.old_no).trim(), newNo: pl.no, content: pl.rest, memo: p.memo || '' };
    });
    rows.sort((a, b) => {
      const x = parseFloat(a.oldNo), y = parseFloat(b.oldNo);
      if (isNaN(x) || isNaN(y)) return String(a.oldNo).localeCompare(String(b.oldNo));
      return x - y;
    });
    return rows;
  }

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  window.openSubmit = function () {
    const total = arr().length;
    const rows = buildRows();
    const info = document.getElementById('submit-info');
    const body = document.getElementById('submit-body');
    if (!info || !body) return;
    if (rows.length === 0) {
      info.innerHTML = '⚠️ このエリアは<b>旧番号(古い順序)が未復元</b>です。<br>会社のMscope元データから旧番号を取り込む必要があります（倭町・小木2区は復元済み）。';
      body.innerHTML = '';
    } else {
      info.innerHTML = `旧番号順 <b>${rows.length}</b>件` +
        (rows.length < total ? ` <span style="color:#c00;">（旧番号なし ${total - rows.length}件は除外）</span>` : '') +
        '<br><span style="color:#777;">「新No」列が希望の検針順路です。会社へはこの旧番号順の並びで提出します。</span>';
      body.innerHTML = '<table class="submit-table"><thead><tr><th>旧No</th><th>新No</th><th>住所・使用者</th><th>メモ</th></tr></thead><tbody>' +
        rows.map(r => `<tr><td>${esc(r.oldNo)}</td><td><b>${esc(r.newNo)}</b></td><td>${esc(r.content)}</td><td class="submit-memo">${esc(r.memo)}</td></tr>`).join('') +
        '</tbody></table>';
    }
    document.getElementById('submit-modal').classList.add('show');
  };
  window.closeSubmit = function () { document.getElementById('submit-modal').classList.remove('show'); };

  window.downloadSubmitCsv = function () {
    const rows = buildRows();
    if (rows.length === 0) { if (typeof showToast === 'function') showToast('旧番号付きのデータがありません'); return; }
    const area = (typeof detectAreaName === 'function') ? (detectAreaName() || 'area') : 'area';
    const head = ['旧No', '新No', '住所・使用者', 'メモ'];
    const csv = [head].concat(rows.map(r => [r.oldNo, r.newNo, r.content, r.memo]))
      .map(line => line.map(c => {
        const s = String(c == null ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `提出_旧順_${area}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('CSVを書き出しました');
  };
})();

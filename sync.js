// sync.js — Firebase クラウド同期 (スマホ⇔PC)
// 方針: Googleログイン(tenyu.horihataのみ) + Firestore に「エリア単位で丸ごとJSON」保存。
//       差分同期せず全体上書き = 1人編集の検針に最適。last-write-wins(clientTimeで判定)。
// 後方互換: SDK未ロード/未ログインなら従来どおり localStorage のみで動作。
(function () {
  'use strict';

  // ---- Firebase 設定 (web app: water-meter-map / project: water-meter-sync-tj) ----
  // apiKey は公開されても問題ない種類のキー(Firestoreルール+APIキー制限で保護)。
  var firebaseConfig = {
    apiKey: "AIzaSyBpfl-vuABU-N3XuSOJxSAKsQu4D24RZjQ",
    authDomain: "water-meter-sync-tj.firebaseapp.com",
    projectId: "water-meter-sync-tj",
    storageBucket: "water-meter-sync-tj.firebasestorage.app",
    messagingSenderId: "266378486417",
    appId: "1:266378486417:web:b6d576c6a151980df69530"
  };
  var ALLOWED_EMAIL = "tenyu.horihata@gmail.com";

  var enabled = (typeof firebase !== 'undefined' && firebase.initializeApp);
  var auth = null, db = null;
  var currentUser = null;
  var pushTimer = null;
  var pushing = false;
  var applyingRemote = false; // pull適用中は push を抑制(ライフサイクルガード)

  // ---- 小物 ----
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); else console.log('[sync]', msg); }
  function localMtime() { return parseInt(localStorage.getItem('waterMeterLocalMtime') || '0', 10) || 0; }
  function setLocalMtime(t) { localStorage.setItem('waterMeterLocalMtime', String(t)); }
  function autoSyncOn() { return localStorage.getItem('waterMeterAutoSync') !== 'off'; } // 既定ON
  function isMobile() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent); }

  function currentArea() {
    try {
      var a = (typeof detectAreaName === 'function') ? detectAreaName() : '';
      return a || '_default';
    } catch (e) { return '_default'; }
  }
  function currentBlob() {
    var meta = (typeof currentSnapshotDate !== 'undefined' && currentSnapshotDate)
      ? { snapshotDate: currentSnapshotDate } : undefined;
    return { pins: pins, nextId: nextId, savedTraces: savedTraces, pinGroups: pinGroups, meta: meta };
  }

  // ---- 同期ステータス表示 ----
  function setSyncStatus(state, info) {
    var el = document.getElementById('sync-status');
    var map = { out: '', synced: '☁︎✓', pending: '☁︎…', syncing: '☁︎↻', error: '☁︎⚠' };
    if (el) { el.textContent = map[state] || ''; el.title = info ? ('同期: ' + info) : ''; }
    var btn = document.getElementById('btn-sync');
    if (btn) btn.classList.toggle('active', state === 'synced' || state === 'syncing' || state === 'pending');
  }

  // ============ Push ============
  function scheduleCloudPush() {
    if (!currentUser || !autoSyncOn()) return;
    if (!pins || pins.length === 0) return; // 空をpushして上書きする事故を防ぐ
    clearTimeout(pushTimer);
    setSyncStatus('pending');
    pushTimer = setTimeout(function () { cloudPush(); }, 1500);
  }

  function cloudPush(opts) {
    opts = opts || {};
    if (!enabled || !currentUser) { return Promise.resolve(false); }
    if (pushing) { // ロック: 進行中なら少し待って再試行
      clearTimeout(pushTimer);
      pushTimer = setTimeout(function () { cloudPush(opts); }, 800);
      return Promise.resolve(false);
    }
    if ((!pins || pins.length === 0) && !opts.allowEmpty) {
      toast('ピンが無いのでクラウド保存をスキップしました');
      return Promise.resolve(false);
    }
    pushing = true;
    setSyncStatus('syncing');
    var area = currentArea();
    var t = localMtime() || Date.now();
    return db.collection('areas').doc(area).set({
      blob: JSON.stringify(currentBlob()),
      count: pins.length,
      area: area,
      clientTime: t,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      device: (navigator.userAgent || '').slice(0, 120)
    }).then(function () {
      setSyncStatus('synced', area + ' / ' + pins.length + '件');
      console.log('[sync] push OK area=' + area + ' ' + pins.length + '件');
      return true;
    }).catch(function (e) {
      console.error('[sync] push失敗', e);
      setSyncStatus('error', e.message || e.code);
      toast('クラウド保存に失敗: ' + (e.message || e.code));
      return false;
    }).then(function (r) { pushing = false; return r; });
  }

  // ============ Pull ============
  function applyBlob(data, clientTime) {
    applyingRemote = true;
    try {
      pins.forEach(function (p) { if (markers[p.id]) map.removeLayer(markers[p.id]); });
      pins = []; markers = {};
      if (typeof routeLine !== 'undefined' && routeLine) { map.removeLayer(routeLine); routeLine = null; }
      nextId = data.nextId || 1;
      savedTraces = data.savedTraces || [];
      pinGroups = data.pinGroups || [];
      if (typeof redrawSavedTraces === 'function') redrawSavedTraces();
      _bulkLoading = true;
      (data.pins || []).forEach(function (p) { addPin(p.lat, p.lng, p.label, p.memo, p.id, Object.assign({}, p)); });
      _bulkLoading = false;
      if (pins.length > 0) nextId = Math.max(nextId, Math.max.apply(null, pins.map(function (p) { return p.id || 0; }))) + 1;
      if (typeof warnIfDuplicates === 'function') warnIfDuplicates();
      if (data.meta && data.meta.snapshotDate && typeof currentSnapshotDate !== 'undefined') {
        currentSnapshotDate = data.meta.snapshotDate;
        if (typeof showStaleSnapshotWarning === 'function') showStaleSnapshotWarning(currentSnapshotDate);
      }
      _origSave(); // ローカル保存(applyingRemote中なのでpushは予約されない)
      setLocalMtime(clientTime || Date.now());
      if (pins.length > 0) {
        var group = L.featureGroup(Object.values(markers));
        map.fitBounds(group.getBounds().pad(0.1));
      }
    } finally {
      applyingRemote = false;
    }
  }

  function cloudPull(area, opts) {
    opts = opts || {};
    if (!enabled || !currentUser) { toast('ログインしてください'); return Promise.resolve(false); }
    area = area || currentArea();
    setSyncStatus('syncing');
    return db.collection('areas').doc(area).get().then(function (snap) {
      if (!snap.exists) {
        if (!opts.silent) toast('クラウドに「' + area + '」のデータはありません');
        setSyncStatus('synced', area);
        return false;
      }
      var d = snap.data();
      applyBlob(JSON.parse(d.blob), d.clientTime || 0);
      setSyncStatus('synced', area + ' / ' + pins.length + '件');
      if (!opts.silent) toast('⬇️ クラウドから取得: ' + area + ' ' + pins.length + '件');
      return true;
    }).catch(function (e) {
      console.error('[sync] pull失敗', e);
      setSyncStatus('error', e.message || e.code);
      toast('クラウド取得に失敗: ' + (e.message || e.code));
      return false;
    });
  }

  // ============ ログイン時の自動すり合わせ ============
  function reconcileOnLogin() {
    var area = currentArea();
    var hasLocal = pins && pins.length > 0;
    return db.collection('areas').doc(area).get().then(function (snap) {
      var cloud = snap.exists ? snap.data() : null;
      var lt = localMtime();
      var ct = cloud ? (cloud.clientTime || 0) : 0;
      if (!cloud && hasLocal) {
        return cloudPush();
      } else if (cloud && !hasLocal) {
        return cloudPull(area, { silent: true }).then(function () {
          toast('⬇️ クラウドから「' + area + '」を取得しました');
        });
      } else if (cloud && hasLocal) {
        if (ct > lt + 1000) { // クラウドが明確に新しい
          if (confirm('クラウドのデータ（' + area + '）の方が新しいようです。\nクラウド版を読み込みますか？\n（キャンセル＝ローカル版を保持してクラウドへ上書き）')) {
            return cloudPull(area, { silent: true }).then(function () { toast('⬇️ クラウド版を読み込みました'); });
          } else {
            return cloudPush();
          }
        } else if (lt > ct + 1000) {
          return cloudPush();
        } else {
          setSyncStatus('synced', area);
        }
      } else {
        setSyncStatus('synced', area);
      }
    }).catch(function (e) {
      console.error('[sync] reconcile失敗', e);
      setSyncStatus('error', e.message || e.code);
    });
  }

  // ============ クラウド上のエリア一覧 ============
  function listCloudAreas() {
    var box = document.getElementById('sync-area-list');
    if (!box) return;
    if (!currentUser) { box.innerHTML = ''; return; }
    box.innerHTML = '<span style="color:#999;">読み込み中…</span>';
    db.collection('areas').get().then(function (qs) {
      if (qs.empty) { box.innerHTML = '<span style="color:#999;">まだクラウドにデータがありません</span>'; return; }
      var rows = [];
      qs.forEach(function (doc) {
        var d = doc.data();
        var when = '';
        try { if (d.updatedAt && d.updatedAt.toDate) when = d.updatedAt.toDate().toLocaleString('ja-JP'); } catch (e) {}
        var id = doc.id.replace(/"/g, '&quot;');
        rows.push('<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #eee;">' +
          '<span><b>' + doc.id + '</b> <span style="color:#888;">(' + (d.count || 0) + '件' + (when ? ' / ' + when : '') + ')</span></span>' +
          '<button class="sync-pull-one" data-area="' + id + '" style="padding:2px 8px;border:none;border-radius:4px;background:#FF9800;color:#fff;cursor:pointer;font-size:12px;white-space:nowrap;">⬇️ 取得</button>' +
          '</div>');
      });
      box.innerHTML = rows.join('');
      Array.prototype.forEach.call(box.querySelectorAll('.sync-pull-one'), function (b) {
        b.addEventListener('click', function () {
          var a = this.getAttribute('data-area');
          if (confirm('「' + a + '」をクラウドから読み込みます。\n現在の表示は置き換わります。よろしいですか？')) {
            cloudPull(a, {}).then(function () { closeSyncModal(); });
          }
        });
      });
    }).catch(function (e) {
      box.innerHTML = '<span style="color:#c00;">一覧取得に失敗: ' + (e.message || e.code) + '</span>';
    });
  }

  // ============ 認証 ============
  function doSignIn() {
    if (!enabled) { toast('同期は利用できません（オフライン）'); return; }
    var provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    if (isMobile()) {
      auth.signInWithRedirect(provider);
    } else {
      auth.signInWithPopup(provider).catch(handleAuthError);
    }
  }
  function handleAuthError(e) {
    console.error('[sync] auth error', e);
    if (!e || !e.code) return;
    if (e.code === 'auth/operation-not-allowed') {
      toast('⚠️ Google認証が未有効です（Firebase Console での有効化が必要）');
    } else if (e.code === 'auth/popup-blocked') {
      auth.signInWithRedirect(new firebase.auth.GoogleAuthProvider());
    } else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
      toast('ログイン失敗: ' + (e.message || e.code));
    }
  }

  // ============ UI ============
  function updateSyncUI() {
    var loginArea = document.getElementById('sync-login-area');
    var userArea = document.getElementById('sync-user-area');
    var emailEl = document.getElementById('sync-user-email');
    var areaEl = document.getElementById('sync-current-area');
    var autoEl = document.getElementById('sync-auto');
    if (currentUser) {
      if (loginArea) loginArea.style.display = 'none';
      if (userArea) userArea.style.display = 'block';
      if (emailEl) emailEl.textContent = currentUser.email;
      if (areaEl) areaEl.textContent = '現在のエリア（保存先）: ' + currentArea() + ' / ' + (pins ? pins.length : 0) + '件';
      if (autoEl) autoEl.checked = autoSyncOn();
      listCloudAreas();
    } else {
      if (loginArea) loginArea.style.display = 'block';
      if (userArea) userArea.style.display = 'none';
    }
  }

  // ============ 公開関数(onclick用) ============
  window.openSyncModal = function () {
    var m = document.getElementById('sync-modal');
    if (m) m.classList.add('show');
    updateSyncUI();
  };
  window.closeSyncModal = function () {
    var m = document.getElementById('sync-modal');
    if (m) m.classList.remove('show');
  };
  window.syncSignIn = doSignIn;
  window.syncSignOut = function () { if (auth) auth.signOut(); };
  window.syncPushNow = function () {
    cloudPush({}).then(function (ok) { if (ok) toast('⬆️ クラウドへ保存しました'); });
  };
  window.syncPullNow = function () {
    if (confirm('クラウドから「' + currentArea() + '」を読み込みます。\n現在の表示は置き換わります。よろしいですか？')) {
      cloudPull(currentArea(), {});
    }
  };
  window.syncToggleAuto = function (on) {
    localStorage.setItem('waterMeterAutoSync', on ? 'on' : 'off');
    toast(on ? '自動同期: ON' : '自動同期: OFF');
    if (on) scheduleCloudPush();
  };

  // ============ 初期化 ============
  // saveToStorage をラップ(storage.js 読込後・このファイルで上書き)
  var _origSave = window.saveToStorage || function () {};
  window.saveToStorage = function () {
    _origSave.apply(this, arguments);
    if (applyingRemote) return;
    setLocalMtime(Date.now());
    scheduleCloudPush();
  };
  if (!enabled) {
    console.warn('[sync] Firebase SDK 未ロード — クラウド同期は無効（ローカルのみ動作）');
    setSyncStatus('out');
    return;
  }

  firebase.initializeApp(firebaseConfig);
  auth = firebase.auth();
  db = firebase.firestore();

  auth.getRedirectResult().catch(handleAuthError);
  auth.onAuthStateChanged(function (user) {
    if (user) {
      if (user.email !== ALLOWED_EMAIL) {
        toast('このアカウント(' + user.email + ')は許可されていません');
        auth.signOut();
        return;
      }
      currentUser = user;
      setSyncStatus('synced');
      updateSyncUI();
      reconcileOnLogin();
    } else {
      currentUser = null;
      setSyncStatus('out');
      updateSyncUI();
    }
  });

  console.log('[sync] 初期化完了 project=' + firebaseConfig.projectId);
})();

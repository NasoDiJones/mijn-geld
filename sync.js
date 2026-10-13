// Mijn Geld - optionele login + cloud sync (Supabase). Zonder login werkt de app precies als voorheen.
(function () {
  'use strict';
  var SUPABASE_URL = 'https://zsqxzyqpyvnnwigwrsoa.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_WocraeDzyG44zL01tOU02A_DyT1P9n3'; // publieke client-sleutel
  var META_KEY = 'mijnGeldApp.sync';
  var DEBOUNCE_MS = 1500;
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  var client = null, user = null, timer = null, applying = false, busy = false, status = '';
  var meta = readMeta();

  function readMeta() { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { return {}; } }
  function writeMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) {} }
  function $(id) { return document.getElementById(id); }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function online() { return navigator.onLine !== false; }

  function setStatus(s) {
    status = s;
    var el = $('sync-status');
    if (el) el.textContent = ({ ok: '✓ gesynchroniseerd', offline: 'offline', busy: 'bezig…', error: '⚠︎ fout' })[s] || '';
  }

  function renderUi() {
    var out = $('sync-logged-out'), inn = $('sync-logged-in');
    if (!out || !inn) return;
    var rec = $('sync-recovery'), inRec = recovering && !!user;
    if (rec) rec.classList.toggle('hidden', !inRec);
    out.classList.toggle('hidden', !!user);
    inn.classList.toggle('hidden', !user || inRec);
    if (user && $('sync-user-email')) $('sync-user-email').textContent = user.email || '';
    if (!user) setStatus('');
  }

  function localRaw() { return localStorage.getItem('mijnGeldApp'); }
  function localData() { try { return JSON.parse(localRaw()); } catch (e) { return null; } }
  function hasData(d) {
    if (!d || typeof d !== 'object') return false;
    return ['transactions', 'pots', 'goals', 'recurring'].some(function (k) { return Array.isArray(d[k]) && d[k].length > 0; });
  }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function applyRemote(data) {
    applying = true;
    try {
      localStorage.setItem('mijnGeldApp', JSON.stringify(data));
      loadState();
      if (typeof ensurePeriodDefaults === 'function') ensurePeriodDefaults();
      if (typeof repairRecurringData === 'function') repairRecurringData();
      if (typeof runAutoBooking === 'function') runAutoBooking();
      localStorage.setItem('mijnGeldApp', JSON.stringify(window.mgGetState ? window.mgGetState() : JSON.parse(localRaw())));
      if (typeof render === 'function') render();
    } finally { applying = false; }
  }

  async function fetchRemote() {
    var r = await client.from('app_state').select('data, updated_at, updated_by').eq('household_id', meta.householdId).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }

  async function upload() {
    if (!client || !user || !meta.householdId) return;
    if (!online()) { setStatus('offline'); return; }
    var data = localData();
    if (!data) return;
    setStatus('busy');
    var now = new Date().toISOString();
    var r = await client.from('app_state').upsert({ household_id: meta.householdId, data: data, updated_at: now, updated_by: user.id });
    if (r.error) throw r.error;
    meta.lastSyncedAt = now; meta.dirty = false; writeMeta();
    setStatus('ok');
  }

  function fail(e) { console.warn('Sync', e); setStatus(online() ? 'error' : 'offline'); }
  async function safe(fn) { try { await fn(); } catch (e) { fail(e); } }

  async function pullOrPush(remote) {
    if (meta.dirty) return upload(); // lokale wijziging is de nieuwste (last-write-wins)
    if (remote && remote.data && remote.updated_at !== meta.lastSyncedAt) {
      applyRemote(remote.data);
      meta.lastSyncedAt = remote.updated_at; writeMeta();
    }
    setStatus('ok');
  }

  async function afterLogin() {
    if (busy) return; busy = true;
    try {
      setStatus('busy');
      var hid = await client.rpc('join_or_create_household');
      if (hid.error) throw hid.error;
      if (meta.householdId !== hid.data) { meta = { householdId: hid.data, initialized: false }; writeMeta(); }
      var remote = await fetchRemote();
      if (meta.initialized) { await pullOrPush(remote); return; }
      var local = localData();
      if (!remote || !hasData(remote.data)) {
        if (hasData(local)) await upload();
      } else if (!hasData(local) || same(local, remote.data)) {
        applyRemote(remote.data);
      } else {
        var useLocal = confirm('Er staan al gegevens in de cloud die verschillen van dit toestel.\n\nOK = Gegevens van dit toestel gebruiken\nAnnuleren = Gegevens uit de cloud gebruiken\n\n(Een kopie van dit toestel wordt eerst bewaard.)');
        localStorage.setItem('mijnGeldApp.voorSync', localRaw());
        if (useLocal) await upload(); else applyRemote(remote.data);
      }
      if (remote && !meta.lastSyncedAt) meta.lastSyncedAt = remote.updated_at;
      meta.initialized = true; writeMeta();
      setStatus('ok');
    } catch (e) { fail(e); }
    finally { busy = false; }
  }

  async function syncNow() {
    if (!client || !user || !meta.initialized || busy) return;
    busy = true;
    try { await safe(async function () { await pullOrPush(await fetchRemote()); }); }
    finally { busy = false; }
  }

  // Aangeroepen door saveState() in app.js
  window.mgSyncOnSave = function () {
    if (applying || !user || !meta.initialized) return;
    meta.dirty = true; writeMeta();
    if (!online()) { setStatus('offline'); return; }
    clearTimeout(timer);
    timer = setTimeout(function () { safe(upload); }, DEBOUNCE_MS);
  };

  var recovering = false;
  var APP_URL = 'https://nasodijones.github.io/mijn-geld/';
  function redirectUrl() { return /nasodijones\.github\.io/.test(location.host) ? APP_URL : location.origin + location.pathname; }
  function msg(text, kind) {
    var el = $('sync-msg'); if (!el) { if (text) alert(text); return; }
    el.textContent = text || '';
    el.className = 'text-xs mb-2 mt-1 ' + (kind === 'ok' ? 'text-emerald-600' : 'text-rose-600') + (text ? '' : ' hidden');
  }
  function nlError(e) {
    var m = ((e && (e.code || '')) + ' ' + (e && e.message || '')).toLowerCase();
    var st = e && e.status;
    if (/email.?not.?confirmed/.test(m)) return 'Je e-mail is nog niet bevestigd. Klik eerst op de link in de bevestigingsmail.';
    if (/invalid.?(login.?)?credentials|invalid_grant/.test(m)) return 'E-mailadres of wachtwoord klopt niet.';
    if (st === 429 || /rate.?limit|too many|over_email_send|security purposes/.test(m)) return 'Te veel pogingen. Wacht een paar minuten en probeer het opnieuw.';
    if (/already.?registered|user_already_exists|already exists/.test(m)) return 'Er bestaat al een account met dit e-mailadres. Log in of kies "Wachtwoord vergeten".';
    if (/weak|password should|at least/.test(m)) return 'Wachtwoord is te zwak. Gebruik minimaal 8 tekens.';
    if (/same.?password|different from the old/.test(m)) return 'Kies een ander wachtwoord dan je oude.';
    if (/fetch|network/.test(m)) return 'Geen verbinding. Controleer je internet.';
    return 'Er ging iets mis: ' + (e && e.message || 'onbekende fout');
  }
  function creds(needPw) {
    if (!client) { msg('Inloggen is nu niet beschikbaar (offline?).'); return null; }
    var email = ($('sync-email').value || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { msg('Vul een geldig e-mailadres in.'); return null; }
    var pw = $('sync-password') ? $('sync-password').value : '';
    if (needPw && (pw || '').length < 8) { msg('Wachtwoord moet minimaal 8 tekens zijn.'); return null; }
    return { email: email, password: pw };
  }
  window.mgSyncTogglePw = function (id, btn) {
    var i = $(id); if (!i) return;
    var show = i.type === 'password'; i.type = show ? 'text' : 'password';
    if (btn) { btn.textContent = show ? '🙈' : '👁️'; btn.setAttribute('aria-label', show ? 'Verberg wachtwoord' : 'Toon wachtwoord'); }
  };
  window.mgSyncLogin = async function () {
    var c = creds(true); if (!c) return; msg('');
    var r = await client.auth.signInWithPassword({ email: c.email, password: c.password });
    if (r.error) { msg(nlError(r.error)); return; }
    $('sync-password').value = '';
    toast('Ingelogd ✓');
  };
  window.mgSyncSignUp = async function () {
    var c = creds(true); if (!c) return; msg('');
    var r = await client.auth.signUp({ email: c.email, password: c.password, options: { emailRedirectTo: redirectUrl() } });
    if (r.error) { msg(nlError(r.error)); return; }
    var d = r.data || {};
    if (d.user && Array.isArray(d.user.identities) && d.user.identities.length === 0) { msg('Er bestaat al een account met dit e-mailadres. Log in of kies "Wachtwoord vergeten".'); return; }
    if (d.session) { toast('Account aangemaakt ✓'); return; }
    msg('Bevestig je e-mail via de link in je mail en log daarna hier in met je wachtwoord.', 'ok');
  };
  window.mgSyncForgot = async function () {
    var c = creds(false); if (!c) return; msg('');
    var r = await client.auth.resetPasswordForEmail(c.email, { redirectTo: redirectUrl() });
    if (r.error) { msg(nlError(r.error)); return; }
    msg('Als dit e-mailadres een account heeft, staat er een link in je mail. Open die en kies een nieuw wachtwoord.', 'ok');
  };
  window.mgSyncSetNewPassword = async function () {
    if (!client) return;
    var pw = $('sync-new-password').value || '';
    if (pw.length < 8) { alert('Wachtwoord moet minimaal 8 tekens zijn.'); return; }
    var r = await client.auth.updateUser({ password: pw });
    if (r.error) { alert(nlError(r.error)); return; }
    $('sync-new-password').value = '';
    recovering = false; renderUi();
    toast('Nieuw wachtwoord opgeslagen ✓');
  };

  window.mgSyncInvite = async function () {
    if (!client || !user) return;
    var email = ($('sync-invite-email').value || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { alert('Vul een geldig e-mailadres in.'); return; }
    var r = await client.rpc('invite_member', { invite_email: email });
    if (r.error) { alert('Uitnodigen mislukt: ' + r.error.message); return; }
    $('sync-invite-email').value = '';
    alert(email + ' is uitgenodigd. Laat diegene de app openen en inloggen met dit e-mailadres; jullie delen dan dezelfde gegevens.');
  };

  window.mgSyncNow = function () { if (meta.dirty) return safe(upload); return syncNow(); };

  window.mgSyncLogout = async function () {
    if (!client || !confirm('Uitloggen? Je gegevens blijven op dit toestel staan.')) return;
    if (meta.dirty) await safe(upload);
    await client.auth.signOut();
    meta = {}; writeMeta(); user = null; renderUi();
    toast('Uitgelogd');
  };

  function init() {
    renderUi();
    var lib = window.supabase;
    if (!lib || typeof lib.createClient !== 'function') return;
    client = lib.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'mijnGeldApp.auth' }
    });
    if (/type=recovery/.test(location.hash || '') || /type=recovery/.test(location.search || '')) recovering = true;
    client.auth.onAuthStateChange(function (event, session) {
      if (event === 'PASSWORD_RECOVERY') { recovering = true; if (typeof openModal === 'function') { try { setTimeout(function () { openModal('settings'); }, 0); } catch (e) {} } }
      var was = user;
      user = session ? session.user : null;
      renderUi();
      if (user && (!was || was.id !== user.id)) setTimeout(afterLogin, 0);
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') syncNow(); });
    window.addEventListener('online', function () { if (user) window.mgSyncNow(); });
    window.addEventListener('offline', function () { if (user) setStatus('offline'); });
  }

  window.__mgSync = { meta: function () { return meta; }, status: function () { return status; }, syncNow: syncNow };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

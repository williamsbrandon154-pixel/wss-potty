/* Williams & Sons — Potty Tracker (NFC porta-potty inventory)
   Tag holds a URL like  https://<app>/#/t/<TAG_UID>  -> opens straight to that unit. */
(function () {
  const CFG = window.WSS_CONFIG || {};
  const view = document.getElementById('view');
  if (!CFG.supabaseUrl || !CFG.supabaseAnonKey) {
    view.innerHTML = '<div class="card err">config.js is missing the Supabase URL / key.</div>';
    return;
  }
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);
  // where the app lives, including any sub-folder (GitHub Pages serves it under /wss-potty/) — this is what gets written onto the tags
  const APP_URL = (CFG.appUrl || (location.origin + location.pathname.replace(/[^/]*$/, ''))).replace(/\/$/, '');
  // what actually gets written onto a tag: a permanent address that forwards to the app, so moving the app never means re-writing 128 tags
  const TAG_URL = (CFG.tagUrl || APP_URL).replace(/\/$/, '');
  const $ = (id) => document.getElementById(id);

  // ---------- helpers ----------
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normUid = (s) => String(s || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  const fmtDist = (m) => (m == null ? '' : m < 1000 ? Math.round(m) + ' m' : (m / 1609.34).toFixed(1) + ' mi');
  const ago = (iso) => {
    if (!iso) return 'never';
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + ' min ago';
    if (d < 86400) return Math.floor(d / 3600) + ' hr ago';
    return Math.floor(d / 86400) + ' d ago';
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

  const STATUS = {
    in_yard: ['In Yard', 'st-yard'], deployed: ['Deployed', 'st-out'], field_repair: ['Field Repair', 'st-bad'],
    svc_required: ['Svc Required', 'st-warn'], offline: ['Offline', 'st-bad'], no_tag: ['No Tag', 'st-grey'], in_progress: ['In Progress', 'st-warn'],
  };
  const ACTIONS = [
    ['serviced', 'Serviced ✓', 'act-ok'], ['dropped', 'Dropped here', 'act-blue'], ['picked_up', 'Picked up → Yard', 'act-orange full'],
    ['skipped', 'Skipped', 'act-prob'], ['blocked', 'Blocked', 'act-prob'], ['muddy', 'Muddy', 'act-prob'], ['frozen', 'Frozen', 'act-prob'], ['customer_declined', 'Customer Declined', 'act-prob full'],
    ['field_repair', 'Field Repair', 'act-cond'], ['svc_required', 'Svc Required', 'act-cond'], ['offline', 'Offline', 'act-cond full'],
  ];
  const ACTION_LABEL = Object.fromEntries(ACTIONS.map((a) => [a[0], a[1].replace(' ✓', '')]).concat([['registered', 'Tag registered']]));
  const PROBLEMS = ['skipped', 'blocked', 'muddy', 'frozen', 'customer_declined'];
  const CONDS = ['field_repair', 'svc_required', 'offline'];
  const UNIT_TYPES = ['CONSTRUCTION', 'BLUE 22', 'LIGHT GREY', 'BLUE GREY', 'PEWTER 23', 'HANDI-CAP', 'HANDICAP WITH LOCK', 'LOCKED', 'NEWER PEWTER-LOCKED', 'OLDER LOCKED PEWTER', 'NICE BLUE CONSTRUCTION', 'NEW BLUE-SEASONAL', 'FLUSHABLES', 'SINK', 'HC 23', 'CUSTOMER OWNED', 'OTHER'];

  let session = null, profile = null, yardSite = null, liveSub = null;

  const statusPill = (s) => { const [l, c] = STATUS[s] || [s || '—', 'st-grey']; return `<span class="pill ${c}">${esc(l)}</span>`; };
  const render = (html) => { view.innerHTML = html; window.scrollTo(0, 0); };
  const toast = (msg, isErr) => { const t = document.createElement('div'); t.className = 'toast' + (isErr ? ' err' : ''); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 2800); };
  const setTabs = (active) => {
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === active));
    $('tabs').style.display = session ? 'flex' : 'none';
    $('btnOut').style.display = session ? '' : 'none';
    $('who').textContent = session ? driverName() : '';
  };
  const driverName = () => {
    if (profile && (profile.name || profile.driver_no)) return ((profile.driver_no || '') + ' ' + (profile.name || '')).trim();
    return session ? session.user.email : '';
  };
  async function loadProfile() {
    profile = null;
    if (!session) return;
    const { data } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    profile = data;
  }
  async function loadYard() {
    if (yardSite) return yardSite;
    const { data } = await sb.from('sites').select('*').eq('is_yard', true).limit(1).maybeSingle();
    yardSite = data; return yardSite;
  }
  function getGps() {
    return new Promise((res, rej) => {
      if (!navigator.geolocation) return rej(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(
        (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => rej(e), { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    });
  }
  const UNIT_SEL = '*, sites(id,customer_name,address,city,lat,lng,is_yard)';

  // ---------- routing ----------
  function route() {
    let h = location.hash.replace(/^#\/?/, '');
    if (!h) { const m = location.pathname.match(/^\/t\/([0-9A-Za-z:\-]+)/); if (m) h = 't/' + m[1]; }
    const p = h.split('/');
    return { name: p[0] || 'board', arg: decodeURIComponent(p[1] || '') };
  }
  async function router() {
    const r = route();
    if (!session) {
      if (r.name === 't') sessionStorage.setItem('wss_next', '#/t/' + r.arg);
      return renderLogin();
    }
    switch (r.name) {
      case 't': return renderScan(r.arg);
      case 'unit': return renderUnit(r.arg);
      case 'sites': return renderSites();
      case 'site': return renderSite(r.arg);
      case 'program': return renderProgram();
      case 'import': return renderImport();
      case 'login': location.hash = '#/board'; return;
      default: return renderBoard();
    }
  }
  window.addEventListener('hashchange', router);

  // ---------- auth ----------
  function renderLogin() {
    setTabs('');
    render(`<div class="card"><h1>Potty Tracker</h1><p class="muted">Williams &amp; Sons crew sign-in</p>
      <label>Email<input id="em" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com"></label>
      <label>Password<input id="pw" type="password" autocomplete="current-password"></label>
      <button id="btnLogin" class="btn big">Sign in</button>
      <button id="btnLink" class="btn ghost">Email me a sign-in link instead</button>
      <p id="msg" class="muted"></p></div>`);
    const msg = $('msg');
    $('btnLogin').onclick = async () => {
      msg.textContent = 'Signing in…';
      const { error } = await sb.auth.signInWithPassword({ email: $('em').value.trim(), password: $('pw').value });
      if (error) { msg.textContent = error.message; return; }
      const next = sessionStorage.getItem('wss_next'); sessionStorage.removeItem('wss_next');
      location.hash = next || '#/board';
    };
    $('btnLink').onclick = async () => {
      const email = $('em').value.trim();
      if (!email) { msg.textContent = 'Enter your email first.'; return; }
      msg.textContent = 'Sending…';
      const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL + '/' } });
      msg.textContent = error ? error.message : 'Check your email and tap the link.';
    };
    $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnLogin').click(); });
  }

  // ---------- SCAN (the core) ----------
  function unitHeader(u) {
    const where = u.sites ? (u.sites.is_yard ? 'in the yard' : 'at ' + esc(u.sites.customer_name)) : '';
    return `<div class="card unit-head"><div class="potty-no">Potty #${u.id}</div>
      <div>${esc(u.unit_type || 'Unknown type')} · ${u.owned_by === 'customer' ? 'Customer-owned' : 'Company'} ${statusPill(u.status)}</div>
      <div class="muted">Last: ${esc(ACTION_LABEL[u.last_action] || u.last_action || '—')} · ${ago(u.last_scanned_at)}${where ? ' · ' + where : ''}</div></div>`;
  }
  async function renderScan(rawUid) {
    setTabs('program');
    const uid = normUid(rawUid);
    if (!uid) return render('<div class="card err">No tag ID in this link.</div>');
    render('<div class="card"><p class="muted">Reading tag ' + esc(uid) + '…</p></div>');
    const { data: unit, error } = await sb.from('units').select(UNIT_SEL).eq('tag_uid', uid).maybeSingle();
    if (error) return render(`<div class="card err">${esc(error.message)}</div>`);
    if (!unit) return renderRegister(uid);
    render(unitHeader(unit) + '<div class="card"><p class="muted">📡 Getting your location…</p></div>');
    let gps = null, cands = [];
    try { gps = await getGps(); } catch (e) { gps = null; }
    if (gps) {
      const { data } = await sb.rpc('nearest_sites', { p_lat: gps.lat, p_lng: gps.lng, p_limit: 6 });
      cands = data || [];
    }
    renderScanForm(unit, gps, cands);
  }
  function renderScanForm(unit, gps, cands) {
    const NEAR_M = 600;
    let sel = null;                     // {id, customer_name, address, is_yard, lat}
    const top = cands[0] && cands[0].dist_m <= NEAR_M ? cands[0] : null;
    if (top) sel = top; else if (unit.sites && !unit.sites.is_yard) sel = unit.sites;
    let note = '';

    function siteRow(s, cls) {
      const on = sel && sel.id === s.id ? ' sel' : '';
      return `<div class="site-pick ${cls || ''}${on}" data-sid="${s.id}"><div><b>${esc(s.customer_name)}</b><div class="muted">${esc([s.address, s.city].filter(Boolean).join(', '))}</div></div><div class="d">${s.dist_m != null ? fmtDist(s.dist_m) : (s.is_yard ? 'yard' : '')}</div></div>`;
    }
    function draw() {
      const gpsLine = gps ? `<p class="muted">📍 GPS ok (±${Math.round(gps.acc)} m)</p>` : `<p class="muted">📍 No GPS fix — pick the site below.</p>`;
      let siteHtml = '';
      if (top) siteHtml += `<h3>You're at</h3>` + siteRow(top, 'top');
      const others = cands.filter((c) => !top || c.id !== top.id).slice(0, 5);
      if (!top && unit.sites && !unit.sites.is_yard) siteHtml += `<h3>Last known site</h3>` + siteRow(unit.sites);
      if (others.length) siteHtml += `<h3>Nearby</h3>` + others.map((s) => siteRow(s)).join('');
      siteHtml += `<details><summary>🔎 Search customer / new site</summary>
        <label>Customer name<input id="q" placeholder="Type a name…" autocomplete="off"></label><div id="qres"></div>
        <button id="btnNew" class="btn ghost">＋ New site here (uses GPS)</button></details>`;
      const actHtml = ACTIONS.map(([k, l, c]) => `<button class="btn ${c}" data-act="${k}">${esc(l)}</button>`).join('');
      render(unitHeader(unit) + `<div class="card">${gpsLine}${siteHtml}
        <p id="selLine" class="muted" style="margin-top:10px">${sel ? '✅ Site: <b>' + esc(sel.customer_name) + '</b>' : '⚠️ No site selected'}</p></div>
        <div class="card"><h3>What happened?</h3><div class="acts">${actHtml}</div>
        <label>Note (optional)<input id="note" placeholder="e.g. gate locked, needs new door"></label></div>`);
      view.querySelectorAll('.site-pick').forEach((el) => el.onclick = () => {
        const id = Number(el.dataset.sid);
        sel = cands.find((c) => c.id === id) || (unit.sites && unit.sites.id === id ? unit.sites : sel);
        draw();
      });
      const q = $('q');
      if (q) q.oninput = debounce(async () => {
        const v = q.value.trim(); const box = $('qres'); if (v.length < 2) { box.innerHTML = ''; return; }
        const { data } = await sb.from('sites').select('id,customer_name,address,city,is_yard,lat,lng').ilike('customer_name', '%' + v + '%').limit(8);
        box.innerHTML = (data || []).map((s) => siteRow(s)).join('') || '<p class="muted">No match.</p>';
        box.querySelectorAll('.site-pick').forEach((el) => el.onclick = () => { sel = (data || []).find((s) => s.id === Number(el.dataset.sid)); cands = [sel].concat(cands.filter((c) => c.id !== sel.id)); draw(); });
      }, 250);
      const bn = $('btnNew');
      if (bn) bn.onclick = async () => {
        const name = prompt('Customer / site name for this location:'); if (!name) return;
        const row = { customer_name: name.trim(), source: 'driver', lat: gps ? gps.lat : null, lng: gps ? gps.lng : null };
        const { data, error } = await sb.from('sites').insert(row).select('id,customer_name,address,city,is_yard,lat,lng').single();
        if (error) return toast(error.message, true);
        sel = data; cands = [sel].concat(cands); toast('Site created'); draw();
      };
      view.querySelectorAll('[data-act]').forEach((b) => b.onclick = () => doAction(b.dataset.act));
    }
    async function doAction(action) {
      note = ($('note') && $('note').value.trim()) || '';
      if (action !== 'picked_up' && !sel) { toast('Pick the site first (or search / new site).', true); return; }
      view.querySelectorAll('[data-act]').forEach((b) => b.disabled = true);
      try {
        await saveScan(unit, action, sel, gps, note);
        renderDone(unit, action, action === 'picked_up' ? (await loadYard()) : sel);
      } catch (e) { toast(e.message || String(e), true); view.querySelectorAll('[data-act]').forEach((b) => b.disabled = false); }
    }
    draw();
  }
  async function saveScan(unit, action, site, gps, note) {
    let siteId = site ? site.id : null;
    if (action === 'picked_up') { const y = await loadYard(); siteId = y ? y.id : null; }
    const upd = { last_scanned_at: new Date().toISOString(), last_action: action };
    if (action === 'serviced' || action === 'dropped') { upd.status = 'deployed'; if (siteId) upd.current_site_id = siteId; }
    else if (action === 'picked_up') { upd.status = 'in_yard'; upd.current_site_id = siteId; }
    else if (PROBLEMS.includes(action)) { if (siteId) upd.current_site_id = siteId; if (unit.status === 'in_yard' || unit.status === 'no_tag') upd.status = 'deployed'; }
    else if (CONDS.includes(action)) { upd.status = action; if (siteId) upd.current_site_id = siteId; }
    const scan = { unit_id: unit.id, tag_uid: unit.tag_uid, driver_id: session.user.id, driver_name: driverName(), action, site_id: siteId,
      lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, gps_accuracy: gps ? gps.acc : null, note: note || null };
    const { error: e1 } = await sb.from('scans').insert(scan); if (e1) throw e1;
    const { error: e2 } = await sb.from('units').update(upd).eq('id', unit.id); if (e2) throw e2;
    // crowd-source coordinates: fill empty ones, and refine approximate ones when the driver is standing right there
    if (site && gps && action !== 'picked_up' && gps.acc != null && gps.acc < 80) {
      const distM = (a1, o1, a2, o2) => { const R = 6371000, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r; const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
      let refine = site.lat == null || site.lng == null;
      if (!refine) { const d = distM(site.lat, site.lng, gps.lat, gps.lng); refine = d > 40 && d < 2500; }
      if (refine) await sb.from('sites').update({ lat: gps.lat, lng: gps.lng }).eq('id', site.id);
    }
  }
  function renderDone(unit, action, site) {
    const where = site ? (site.is_yard ? 'back in the yard' : 'at ' + esc(site.customer_name)) : '';
    render(`<div class="card done"><div class="potty-no">#${unit.id}</div>
      <div class="big">${esc(ACTION_LABEL[action] || action)} ${where ? '— ' + where : ''}</div>
      <p class="muted">${esc(driverName())} · ${when(new Date().toISOString())}</p>
      <button id="btnCopy" class="btn ghost copybtn">Copy “${unit.id}” for Tank Track</button>
      <button class="btn" onclick="location.hash='#/board'">Board</button>
      <button class="btn ghost" onclick="location.hash='#/unit/${unit.id}'">Unit details</button></div>`);
    $('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText(String(unit.id)); toast('Copied ' + unit.id); } catch (e) { toast('Copy failed', true); } };
  }

  // ---------- register an unknown tag ----------
  async function renderRegister(uid) {
    setTabs('program');
    const { data: untagged } = await sb.from('units').select('id,unit_type,owned_by,status,sites(customer_name)').is('tag_uid', null).order('id').limit(200);
    const opts = UNIT_TYPES.map((t) => `<option>${esc(t)}</option>`).join('');
    const link = (untagged || []).map((u) => `<option value="${u.id}">#${u.id} — ${esc(u.unit_type || '?')}${u.sites ? ' @ ' + esc(u.sites.customer_name) : ''}</option>`).join('');
    render(`<div class="card"><h2>New tag</h2><p class="muted">Tag <b>${esc(uid)}</b> isn't registered yet.</p>
      <label>Is this one of the units already on the books (not tagged yet)?<select id="linkSel"><option value="">— No, it's a new unit —</option>${link}</select></label>
      <div id="newFields"><label>Unit type<select id="utype">${opts}</select></label>
      <label>Owned by<select id="owner"><option value="company">Company (ours)</option><option value="customer">Customer-owned</option></select></label></div>
      <button id="btnReg" class="btn big">Register tag &amp; continue</button></div>`);
    $('linkSel').onchange = () => { $('newFields').style.display = $('linkSel').value ? 'none' : ''; };
    $('btnReg').onclick = async () => {
      $('btnReg').disabled = true;
      try {
        let unitId;
        const linkId = $('linkSel').value;
        if (linkId) {
          const { error } = await sb.from('units').update({ tag_uid: uid, status: 'in_yard' }).eq('id', Number(linkId)).is('tag_uid', null);
          if (error) throw error; unitId = Number(linkId);
        } else {
          const { data, error } = await sb.from('units').insert({ tag_uid: uid, unit_type: $('utype').value, owned_by: $('owner').value, status: 'in_yard' }).select('id').single();
          if (error) throw error; unitId = data.id;
        }
        await sb.from('scans').insert({ unit_id: unitId, tag_uid: uid, driver_id: session.user.id, driver_name: driverName(), action: 'registered' });
        toast('Registered as Potty #' + unitId);
        renderScan(uid);
      } catch (e) { toast(e.message, true); $('btnReg').disabled = false; }
    };
  }

  // ---------- BOARD ----------
  async function renderBoard() {
    setTabs('board');
    render('<div class="card"><p class="muted">Loading…</p></div>');
    const { data: units, error } = await sb.from('units').select(UNIT_SEL).order('id');
    if (error) return render(`<div class="card err">${esc(error.message)}</div>`);
    const c = { all: units.length, in_yard: 0, deployed: 0, attention: 0, no_tag: 0 };
    units.forEach((u) => { if (!u.tag_uid) c.no_tag++; if (u.status === 'in_yard') c.in_yard++; else if (u.status === 'deployed' || u.status === 'in_progress') c.deployed++; else c.attention++; });
    let filter = 'all', q = '', showMap = false;
    function matches(u) {
      if (filter === 'in_yard' && u.status !== 'in_yard') return false;
      if (filter === 'deployed' && !(u.status === 'deployed' || u.status === 'in_progress')) return false;
      if (filter === 'attention' && !CONDS.includes(u.status)) return false;
      if (filter === 'no_tag' && u.tag_uid) return false;
      if (filter === 'customer' && u.owned_by !== 'customer') return false;
      if (q) { const s = (u.id + ' ' + (u.unit_type || '') + ' ' + (u.sites ? u.sites.customer_name + ' ' + (u.sites.address || '') : '') + ' ' + (u.tag_uid || '')).toLowerCase(); return s.includes(q); }
      return true;
    }
    function draw() {
      const rows = units.filter(matches);
      const tile = (k, n, l) => `<div class="tile${filter === k ? ' on' : ''}" data-f="${k}"><div class="n">${n}</div><div class="l">${l}</div></div>`;
      render(`<div class="tiles">${tile('all', c.all, 'Total')}${tile('in_yard', c.in_yard, 'In yard')}${tile('deployed', c.deployed, 'Out')}${tile('attention', c.attention, 'Attention')}</div>
        <div class="card"><input id="bq" placeholder="Search potty #, customer, type…" value="${esc(q)}" autocomplete="off">
        <div class="chips"><span class="chip${filter === 'no_tag' ? ' on' : ''}" data-f="no_tag">No tag (${c.no_tag})</span><span class="chip${filter === 'customer' ? ' on' : ''}" data-f="customer">Customer-owned</span><span class="chip${showMap ? ' on' : ''}" id="chipMap">🗺 Map</span></div>
        ${showMap ? '<div id="map"></div>' : ''}</div>
        <ul class="list">${rows.slice(0, 300).map((u) => `<li data-id="${u.id}"><div class="no">#${u.id}</div><div class="t"><div>${esc(u.unit_type || '?')} ${statusPill(u.status)}${u.tag_uid ? '' : ' <span class="pill st-grey">no tag</span>'}</div><div class="s">${u.sites ? esc(u.sites.customer_name) + (u.sites.address ? ' · ' + esc(u.sites.address) : '') : '—'} · ${ago(u.last_scanned_at)}</div></div></li>`).join('') || '<li><div class="t muted">Nothing matches.</div></li>'}</ul>`);
      view.querySelectorAll('.tile,[data-f].chip').forEach((el) => el.onclick = () => { filter = el.dataset.f === filter && el.dataset.f !== 'all' ? 'all' : el.dataset.f; draw(); });
      $('chipMap').onclick = () => { showMap = !showMap; draw(); };
      const bq = $('bq'); bq.oninput = debounce(() => { q = bq.value.trim().toLowerCase(); const pos = bq.selectionStart; draw(); const nb = $('bq'); nb.focus(); nb.setSelectionRange(pos, pos); }, 200);
      view.querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => location.hash = '#/unit/' + li.dataset.id);
      if (showMap && window.L) {
        const pts = rows.filter((u) => u.sites && u.sites.lat != null && u.sites.lng != null && !u.sites.is_yard);
        const m = L.map('map');
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
        if (pts.length) { const g = L.featureGroup(pts.map((u) => L.marker([u.sites.lat, u.sites.lng]).bindPopup(`<b>Potty #${u.id}</b><br>${esc(u.sites.customer_name)}<br><a href="#/unit/${u.id}">details</a>`))).addTo(m); m.fitBounds(g.getBounds().pad(0.2)); }
        else m.setView([41.15, -78.85], 9);
      }
    }
    draw();
    if (!liveSub) {
      liveSub = sb.channel('units-live').on('postgres_changes', { event: '*', schema: 'public', table: 'units' }, () => { if (route().name === 'board') renderBoard(); }).subscribe();
    }
  }

  // ---------- UNIT ----------
  async function renderUnit(id) {
    setTabs('board');
    const { data: u, error } = await sb.from('units').select(UNIT_SEL).eq('id', Number(id)).maybeSingle();
    if (error || !u) return render('<div class="card err">Unit not found.</div>');
    const { data: hist } = await sb.from('scans').select('*, sites(customer_name,is_yard)').eq('unit_id', u.id).order('created_at', { ascending: false }).limit(50);
    const opts = UNIT_TYPES.map((t) => `<option${t === u.unit_type ? ' selected' : ''}>${esc(t)}</option>`).join('') + (u.unit_type && !UNIT_TYPES.includes(u.unit_type) ? `<option selected>${esc(u.unit_type)}</option>` : '');
    render(unitHeader(u) + `<div class="card"><div class="kv">
      <div>Tag</div><div>${u.tag_uid ? '<code>' + esc(u.tag_uid) + '</code>' : '<span class="pill st-grey">not tagged</span>'}</div>
      <div>Site</div><div>${u.sites ? `<a href="#/site/${u.sites.id}">${esc(u.sites.customer_name)}</a><div class="muted">${esc([u.sites.address, u.sites.city].filter(Boolean).join(', '))}</div>` : '—'}</div>
      <div>Notes</div><div>${esc(u.notes || '—')}</div></div>
      ${u.tag_uid ? `<button class="btn" onclick="location.hash='#/t/${u.tag_uid}'">Record an action for this unit</button>` : ''}
      ${u.tag_uid ? `<button id="btnTagLink" class="btn ghost">Copy this potty's tag link</button><p class="muted" style="word-break:break-all"><small>${esc(TAG_URL + '/#/t/' + u.tag_uid)}</small></p>` : ''}
      <details><summary>Edit unit</summary>
        <label>Type<select id="etype">${opts}</select></label>
        <label>Owned by<select id="eown"><option value="company"${u.owned_by === 'company' ? ' selected' : ''}>Company</option><option value="customer"${u.owned_by === 'customer' ? ' selected' : ''}>Customer-owned</option></select></label>
        <label>Notes<textarea id="enotes">${esc(u.notes || '')}</textarea></label>
        <button id="btnSave" class="btn">Save</button></details></div>
      <div class="card"><h3>History</h3><ul class="list hist">${(hist || []).map((h) => `<li><div class="t"><div><b>${esc(ACTION_LABEL[h.action] || h.action)}</b>${h.sites ? ' — ' + esc(h.sites.customer_name) : ''}</div><div class="s">${esc(h.driver_name || '')} · ${when(h.created_at)}${h.note ? ' · ' + esc(h.note) : ''}</div></div></li>`).join('') || '<li><div class="t muted">No scans yet.</div></li>'}</ul></div>`);
    if ($('btnTagLink')) $('btnTagLink').onclick = async () => { try { await navigator.clipboard.writeText(TAG_URL + '/#/t/' + u.tag_uid); toast('Tag link copied'); } catch (e) { toast('Copy failed', true); } };
    $('btnSave').onclick = async () => {
      const { error: e } = await sb.from('units').update({ unit_type: $('etype').value, owned_by: $('eown').value, notes: $('enotes').value.trim() || null }).eq('id', u.id);
      if (e) toast(e.message, true); else { toast('Saved'); renderUnit(id); }
    };
  }

  // ---------- SITES ----------
  async function renderSites() {
    setTabs('sites');
    render(`<div class="card"><input id="sq" placeholder="Search customer or address…" autocomplete="off"></div><ul class="list" id="slist"><li><div class="t muted">Type to search.</div></li></ul>`);
    const run = async () => {
      const v = $('sq').value.trim(); if (v.length < 2) return;
      const { data } = await sb.from('sites').select('id,customer_name,address,city,is_yard').or(`customer_name.ilike.%${v}%,address.ilike.%${v}%`).order('customer_name').limit(40);
      $('slist').innerHTML = (data || []).map((s) => `<li data-id="${s.id}"><div class="t"><div><b>${esc(s.customer_name)}</b>${s.is_yard ? ' <span class="pill st-yard">yard</span>' : ''}</div><div class="s">${esc([s.address, s.city].filter(Boolean).join(', '))}</div></div></li>`).join('') || '<li><div class="t muted">No match.</div></li>';
      $('slist').querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => location.hash = '#/site/' + li.dataset.id);
    };
    $('sq').oninput = debounce(run, 250);
    $('sq').focus();
  }
  async function renderSite(id) {
    setTabs('sites');
    const { data: s } = await sb.from('sites').select('*').eq('id', Number(id)).maybeSingle();
    if (!s) return render('<div class="card err">Site not found.</div>');
    const { data: units } = await sb.from('units').select('*').eq('current_site_id', s.id).order('id');
    const { data: hist } = await sb.from('scans').select('*').eq('site_id', s.id).order('created_at', { ascending: false }).limit(20);
    render(`<div class="card"><h2>${esc(s.customer_name)}${s.is_yard ? ' <span class="pill st-yard">yard</span>' : ''}</h2><p class="muted">${esc([s.address, s.city, s.state, s.zip].filter(Boolean).join(', '))}${s.lat != null ? ` · <a href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank">map</a>` : ' · no coordinates yet'}</p></div>
      <div class="card"><h3>Units here (${(units || []).length})</h3><ul class="list">${(units || []).map((u) => `<li data-id="${u.id}"><div class="no">#${u.id}</div><div class="t"><div>${esc(u.unit_type || '?')} ${statusPill(u.status)}</div><div class="s">${esc(ACTION_LABEL[u.last_action] || '')} · ${ago(u.last_scanned_at)}</div></div></li>`).join('') || '<li><div class="t muted">None recorded here.</div></li>'}</ul></div>
      <div class="card"><h3>Recent activity</h3><ul class="list hist">${(hist || []).map((h) => `<li><div class="t"><div><b>#${h.unit_id}</b> ${esc(ACTION_LABEL[h.action] || h.action)}</div><div class="s">${esc(h.driver_name || '')} · ${when(h.created_at)}</div></div></li>`).join('') || '<li><div class="t muted">Nothing yet.</div></li>'}</ul></div>`);
    view.querySelectorAll('li[data-id]').forEach((li) => li.onclick = () => location.hash = '#/unit/' + li.dataset.id);
  }

  // ---------- PROGRAM / SCAN a tag (Android Web NFC) ----------
  function renderProgram() {
    setTabs('program');
    const ok = 'NDEFReader' in window;
    render(`<div class="card"><h2>Scan a tag</h2>
      <p>On most phones just <b>hold the phone on the potty's tag</b> — it opens this app by itself.</p>
      ${ok ? `<p class="muted">On this phone you can also scan and <b>program</b> tags here (writes the app link onto the tag and registers it).</p><button id="btnNfc" class="btn big">📡 Tap a tag now</button><p id="nfcmsg" class="muted"></p>`
           : `<p class="muted">This browser can't program tags (iPhone). To write the link onto a <i>new</i> tag, use any Android phone in Chrome. Tags that already have the link just work when tapped.</p>`}
      <details><summary>Open a unit by typing its tag ID</summary><label>Tag ID<input id="manUid" placeholder="04B4BAAA6A1190" autocomplete="off"></label><button id="btnMan" class="btn">Open</button></details>
      <details><summary>Office: import customer sites (CSV)</summary><p class="muted"><a href="#/import">Go to import</a></p></details></div>`);
    if (ok) $('btnNfc').onclick = async () => {
      const m = $('nfcmsg'); m.textContent = 'Ready — hold the phone on the tag…';
      try {
        const reader = new NDEFReader();
        await reader.scan();
        reader.onreadingerror = () => { m.textContent = 'Could not read that tag. Try again.'; };
        reader.onreading = async (ev) => {
          const uid = normUid(ev.serialNumber);
          if (!uid) { m.textContent = 'No serial number on this tag.'; return; }
          m.textContent = 'Tag ' + uid + ' — writing app link…';
          try { await new NDEFReader().write({ records: [{ recordType: 'url', data: TAG_URL + '/#/t/' + uid }] }); m.textContent = 'Programmed ✓ opening…'; }
          catch (we) { m.textContent = 'Read OK (write skipped: ' + we.message + ') — opening…'; }
          setTimeout(() => { location.hash = '#/t/' + uid; }, 600);
        };
      } catch (e) { m.textContent = 'NFC error: ' + e.message; }
    };
    $('btnMan').onclick = () => { const u = normUid($('manUid').value); if (u) location.hash = '#/t/' + u; };
  }

  // ---------- IMPORT (office): CSV of sites ----------
  function renderImport() {
    setTabs('sites');
    render(`<div class="card"><h2>Import customer sites</h2><p class="muted">Paste CSV with a header row. Columns (any order): <code>customer_name, address, city, state, zip, lat, lng, ext_loc_id, cust_id</code>. Rows with an <code>ext_loc_id</code> update existing sites; others are added.</p>
      <textarea id="csv" style="min-height:160px" placeholder="customer_name,address,city,state,zip,lat,lng,ext_loc_id"></textarea>
      <button id="btnImp" class="btn">Import</button><p id="impmsg" class="muted"></p></div>`);
    $('btnImp').onclick = async () => {
      const rows = parseCsv($('csv').value); const msg = $('impmsg');
      if (!rows.length) { msg.textContent = 'Nothing to import.'; return; }
      const clean = rows.map((r) => ({ customer_name: r.customer_name, address: r.address || null, city: r.city || null, state: r.state || 'PA', zip: r.zip || null,
        lat: r.lat ? Number(r.lat) : null, lng: r.lng ? Number(r.lng) : null, ext_loc_id: r.ext_loc_id || null, cust_id: r.cust_id || null, source: 'import' })).filter((r) => r.customer_name);
      const withId = clean.filter((r) => r.ext_loc_id), noId = clean.filter((r) => !r.ext_loc_id);
      let n = 0;
      for (let i = 0; i < withId.length; i += 500) { const { error } = await sb.from('sites').upsert(withId.slice(i, i + 500), { onConflict: 'ext_loc_id' }); if (error) { msg.textContent = error.message; return; } n += Math.min(500, withId.length - i); }
      for (let i = 0; i < noId.length; i += 500) { const { error } = await sb.from('sites').insert(noId.slice(i, i + 500)); if (error) { msg.textContent = error.message; return; } n += Math.min(500, noId.length - i); }
      msg.textContent = 'Imported ' + n + ' sites.';
    };
  }
  function parseCsv(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim());
    if (lines.length < 2) return [];
    const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((s) => s.trim()); };
    const hdr = split(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z_]/g, ''));
    return lines.slice(1).map((l) => { const v = split(l); const o = {}; hdr.forEach((h, i) => o[h] = v[i] || ''); return o; });
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ---------- boot ----------
  (async () => {
    const { data } = await sb.auth.getSession();
    session = data.session; await loadProfile();
    sb.auth.onAuthStateChange(async (_evt, s) => { const had = !!session; session = s; await loadProfile(); if (!!s !== had) router(); else setTabs(route().name === 't' ? 'program' : route().name); });
    $('btnOut').onclick = async () => { await sb.auth.signOut(); location.hash = '#/login'; };
    router();
  })();
})();

(() => {
  'use strict';

  const SUPABASE_URL = 'https://torczkyodukcvxwzutgf.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl';
  const AUTH_STORAGE_KEY = 'hepa-muhely-auth';
  const MAX_LIST_ROWS = 100;
  const FILE_LINK_TTL_SECONDS = 300;
  const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

  const STATUS_LABELS = {
    new: 'Új',
    needs_quote: 'Árajánlatra vár',
    waiting: 'Válaszra vár',
    ordered: 'Megrendelt',
    closed: 'Lezárt'
  };

  const PROJECT_LABELS = {
    kitchen: 'Konyhabútor',
    wardrobe: 'Gardrób',
    entryway: 'Előszobabútor',
    bathroom: 'Fürdőszobabútor',
    living_room: 'Nappali bútor',
    office: 'Irodabútor',
    custom: 'Egyedi bútor',
    other: 'Egyéb',
    cutting: 'Lapszabászat'
  };

  const FLOW_LABELS = {
    manual: 'Online összeállított szabászjegyzék',
    upload: 'Feltöltött szabászjegyzék',
    help: 'Segítséget kér'
  };

  const MATERIAL_SOURCE_LABELS = {
    hepa: 'A HEPA szerzi be',
    own: 'Saját / hozott anyag',
    unknown: 'Egyeztetendő'
  };

  const FULFILLMENT_LABELS = {
    pickup: 'Személyes átvétel Aszódon',
    delivery: 'Szállítási lehetőséget kér',
    unknown: 'Egyeztetendő'
  };

  const HELP_TOPIC_LABELS = {
    material: 'Anyag vagy dekor',
    size: 'Méretek és szabászjegyzék',
    edge: 'ABS élzárás',
    delivery: 'Átvétel vagy szállítás'
  };

  const SOURCE_LABELS = {
    website: 'Weboldal',
    email: 'E-mail',
    phone: 'Telefon',
    paper: 'Papír',
    in_person: 'Személyes',
    other: 'Egyéb'
  };

  const PREFERRED_CONTACT_LABELS = {
    phone: 'Telefon',
    email: 'E-mail'
  };

  const OFFER_STATUS_LABELS = {
    draft: 'Piszkozat',
    sent: 'Elküldve',
    accepted: 'Elfogadva',
    rejected: 'Elutasítva',
    superseded: 'Újabb verzióval kiváltva'
  };

  const FILE_PURPOSE_LABELS = {
    cutting_list: 'Szabászjegyzék',
    help_attachment: 'Segítségkérő melléklete',
    reference: 'Referencia'
  };

  const VIEW_IDS = ['loading-view', 'login-view', 'mfa-view', 'denied-view', 'app-view'];

  const state = {
    quotes: [],
    filteredQuotes: [],
    currentUser: null,
    activeQuoteId: null,
    activeRequestKind: null,
    currentFiles: [],
    mfaFactorId: null,
    detailRequestSequence: 0,
    idleTimer: null,
    messageTimer: null,
    lastFocused: null
  };

  const $ = (selector) => document.querySelector(selector);
  const db = window.supabase?.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      persistSession: true,
      storage: window.sessionStorage,
      storageKey: AUTH_STORAGE_KEY,
      autoRefreshToken: true,
      detectSessionInUrl: false
    },
    global: {
      headers: { 'X-Client-Info': 'hepa-muhely/1.0.0' }
    }
  });

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setView(activeId) {
    VIEW_IDS.forEach((id) => {
      const view = document.getElementById(id);
      if (view) view.hidden = id !== activeId;
    });
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
      delete button.dataset.originalText;
    }
  }

  function setFormError(target, message) {
    target.textContent = message || '';
    target.hidden = !message;
    if (!target.id) return;
    document.querySelectorAll(`[aria-describedby~="${target.id}"]`).forEach((control) => {
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    });
  }

  function showMessage(message, type = 'success') {
    const target = $('#global-message');
    window.clearTimeout(state.messageTimer);
    target.textContent = message;
    target.classList.toggle('error', type === 'error');
    target.hidden = false;
    state.messageTimer = window.setTimeout(() => {
      target.hidden = true;
    }, type === 'error' ? 9000 : 4500);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('hu-HU', {
      timeZone: 'Europe/Budapest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(`${value}T12:00:00Z`);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('hu-HU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(date);
  }

  function formatNumber(value, maximumFractionDigits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('hu-HU', {
      minimumFractionDigits: 0,
      maximumFractionDigits
    }).format(number);
  }

  function formatMoney(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '—';
    return new Intl.NumberFormat('hu-HU', {
      style: 'currency',
      currency: 'HUF',
      maximumFractionDigits: 0
    }).format(number);
  }

  function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }

  function normalized(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('hu-HU');
  }

  function workflowOf(quote) {
    const workflow = quote?.workflow ?? quote?.quote_workflows;
    if (Array.isArray(workflow)) return workflow[0] || null;
    return workflow || null;
  }

  function referenceFor(quote) {
    const id = String(quote.id).padStart(6, '0');
    return quote.request_kind === 'cutting' ? `HEPA-LSZ-${id}` : `HEPA-${id}`;
  }

  function makeBadge(label, className) {
    return element('span', `badge ${className || ''}`.trim(), label);
  }

  function statusBadge(status, id) {
    const badge = makeBadge(STATUS_LABELS[status] || status || 'Ismeretlen', `status-${status || 'closed'}`);
    if (id) badge.id = id;
    return badge;
  }

  function typeBadge(kind) {
    return makeBadge(kind === 'cutting' ? 'Lapszabászat' : 'Bútorgyártás', kind === 'cutting' ? 'badge-cutting' : 'badge-furniture');
  }

  function createLink(label, href) {
    const link = element('a', '', label || '—');
    link.href = href;
    return link;
  }

  function emailLink(email) {
    if (!email) return document.createTextNode('—');
    return createLink(email, `mailto:${email}`);
  }

  function phoneLink(phone) {
    if (!phone) return document.createTextNode('—');
    const safeNumber = String(phone).replace(/[^+\d]/g, '');
    return createLink(phone, safeNumber ? `tel:${safeNumber}` : '#');
  }

  function detailList(pairs) {
    const list = element('dl', 'detail-list');
    pairs.forEach(([term, value]) => {
      const wrap = element('div');
      wrap.append(element('dt', '', term));
      const definition = element('dd');
      if (value instanceof Node) definition.append(value);
      else definition.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
      wrap.append(definition);
      list.append(wrap);
    });
    return list;
  }

  function sectionHeading(title, subtitle) {
    const wrap = element('div', 'section-heading');
    const text = element('div');
    text.append(element('h2', '', title));
    if (subtitle) text.append(element('p', 'muted small', subtitle));
    wrap.append(text);
    return wrap;
  }

  function detailCard(title, subtitle) {
    const card = element('section', 'detail-card');
    card.append(sectionHeading(title, subtitle));
    return card;
  }

  function validTotp(value) {
    return /^[0-9]{6}$/.test(String(value || '').trim());
  }

  function clearSensitiveView() {
    state.detailRequestSequence += 1;
    state.activeQuoteId = null;
    state.activeRequestKind = null;
    state.quotes = [];
    state.filteredQuotes = [];
    state.currentFiles = [];
    state.mfaFactorId = null;
    $('#quote-list-body').replaceChildren();
    $('#quote-card-list').replaceChildren();
    $('#detail-content').replaceChildren();
    $('#signed-in-user').textContent = '';
    $('#mfa-qr').removeAttribute('src');
    $('#mfa-secret').textContent = '';
  }

  function scheduleIdleSignOut() {
    window.clearTimeout(state.idleTimer);
    if (!state.currentUser) return;
    state.idleTimer = window.setTimeout(() => {
      signOut().catch((error) => console.error('Idle sign-out failed', error));
    }, IDLE_TIMEOUT_MS);
  }

  async function showLogin() {
    window.clearTimeout(state.idleTimer);
    state.currentUser = null;
    clearSensitiveView();
    $('#login-form').reset();
    $('#mfa-challenge-form').reset();
    $('#mfa-enroll-form').reset();
    setFormError($('#login-error'), '');
    setFormError($('#mfa-challenge-error'), '');
    setFormError($('#mfa-enroll-error'), '');
    setView('login-view');
    window.setTimeout(() => $('#login-email')?.focus(), 0);
  }

  async function signOut() {
    window.clearTimeout(state.idleTimer);
    try {
      if (db) {
        const { error } = await db.auth.signOut({ scope: 'local' });
        if (error) throw error;
      }
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
      await showLogin();
    } catch (error) {
      console.error('Sign-out failed; clearing the local session', error);
      window.sessionStorage.removeItem(AUTH_STORAGE_KEY);
      state.currentUser = null;
      clearSensitiveView();
      window.location.reload();
    }
  }

  async function routeAuthenticated(session) {
    if (!db || !session) {
      await showLogin();
      return;
    }

    setView('loading-view');

    const { data: userData, error: userError } = await db.auth.getUser();
    if (userError || !userData?.user) {
      await signOut();
      return;
    }

    const { data: membership, error: membershipError } = await db
      .from('admin_users')
      .select('user_id')
      .eq('user_id', userData.user.id)
      .maybeSingle();

    if (membershipError) {
      showMessage('A jogosultság ellenőrzése nem sikerült. Próbáld újra később.', 'error');
      await signOut();
      return;
    }

    if (!membership) {
      state.currentUser = null;
      setView('denied-view');
      return;
    }

    const { data: aal, error: aalError } = await db.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalError) {
      showMessage('Nem sikerült ellenőrizni a kétlépcsős belépést. Próbáld újra.', 'error');
      await showLogin();
      return;
    }

    if (aal?.currentLevel !== 'aal2') {
      const { data: factors, error: factorError } = await db.auth.mfa.listFactors();
      if (factorError) {
        showMessage('Nem sikerült betölteni a hitelesítési beállítást.', 'error');
        await showLogin();
        return;
      }

      const verifiedTotp = (factors?.totp || []).find((factor) => factor.status === 'verified');
      state.mfaFactorId = verifiedTotp?.id || null;
      $('#mfa-challenge-panel').hidden = !verifiedTotp;
      $('#mfa-enroll-panel').hidden = Boolean(verifiedTotp);
      $('#mfa-enroll-details').hidden = true;
      $('#mfa-enroll-start').hidden = false;
      setFormError($('#mfa-challenge-error'), '');
      setFormError($('#mfa-enroll-error'), '');
      setView('mfa-view');

      window.setTimeout(() => {
        if (verifiedTotp) $('#mfa-code')?.focus();
        else $('#mfa-enroll-start')?.focus();
      }, 0);
      return;
    }

    state.mfaFactorId = null;
    $('#mfa-qr').removeAttribute('src');
    $('#mfa-secret').textContent = '';
    $('#mfa-enroll-form').reset();

    state.currentUser = userData.user;
    scheduleIdleSignOut();
    $('#signed-in-user').textContent = userData.user.email || 'HEPA-admin';
    setView('app-view');
    showListView();
    await loadQuotes();
  }

  async function loadQuotes(options = {}) {
    const { silent = false } = options;
    const loading = $('#list-loading');
    if (!silent) loading.hidden = false;
    $('#refresh-button').disabled = true;

    try {
      const { data: quotes, error: quoteError } = await db
        .from('quote_requests')
        .select('id,created_at,updated_at,status,customer_name,company_name,email,phone,project_type,postcode,city,preferred_contact,source,request_kind')
        .order('created_at', { ascending: false })
        .limit(MAX_LIST_ROWS);

      if (quoteError) throw quoteError;

      const loadedQuotes = quotes || [];
      const cuttingIds = loadedQuotes
        .filter((quote) => quote.request_kind === 'cutting')
        .map((quote) => quote.id);
      let readyCuttingIds = new Set();

      if (cuttingIds.length) {
        const { data: readyCuttingRows, error: cuttingStateError } = await db
          .from('cutting_quote_requests')
          .select('quote_request_id')
          .in('quote_request_id', cuttingIds)
          .eq('submission_state', 'ready');
        if (cuttingStateError) throw cuttingStateError;
        readyCuttingIds = new Set((readyCuttingRows || []).map((row) => String(row.quote_request_id)));
      }

      const visibleQuotes = loadedQuotes.filter((quote) => (
        quote.request_kind !== 'cutting' || readyCuttingIds.has(String(quote.id))
      ));
      const ids = visibleQuotes.map((quote) => quote.id);
      let workflows = [];
      if (ids.length) {
        const { data, error } = await db
          .from('quote_workflows')
          .select('quote_request_id,is_test,work_stage,next_action,next_action_date')
          .in('quote_request_id', ids);
        if (error) throw error;
        workflows = data || [];
      }

      const workflowMap = new Map(workflows.map((workflow) => [String(workflow.quote_request_id), workflow]));
      state.quotes = visibleQuotes.map((quote) => ({
        ...quote,
        workflow: workflowMap.get(String(quote.id)) || null
      }));

      renderStats();
      applyFilters();
    } catch (error) {
      console.error('Quote list load failed', error);
      showMessage('Az ajánlatkéréseket most nem sikerült betölteni.', 'error');
    } finally {
      loading.hidden = true;
      $('#refresh-button').disabled = false;
    }
  }

  function renderStats() {
    $('#stat-new').textContent = state.quotes.filter((quote) => quote.status === 'new').length;
    $('#stat-needs-quote').textContent = state.quotes.filter((quote) => quote.status === 'needs_quote').length;
    $('#stat-cutting').textContent = state.quotes.filter((quote) => quote.request_kind === 'cutting').length;
    $('#stat-ordered').textContent = state.quotes.filter((quote) => quote.status === 'ordered').length;
  }

  function applyFilters() {
    const search = normalized($('#quote-search').value);
    const kind = $('#kind-filter').value;
    const status = $('#status-filter').value;

    state.filteredQuotes = state.quotes.filter((quote) => {
      if (kind !== 'all' && quote.request_kind !== kind) return false;
      if (status !== 'all' && quote.status !== status) return false;
      if (!search) return true;

      const haystack = normalized([
        quote.customer_name,
        quote.company_name,
        quote.email,
        quote.phone,
        referenceFor(quote),
        quote.postcode,
        quote.city
      ].filter(Boolean).join(' '));
      return haystack.includes(search);
    });

    renderQuoteRows();
  }

  function badgeRowForQuote(quote) {
    const row = element('div', 'badge-row');
    row.append(typeBadge(quote.request_kind));
    if (workflowOf(quote)?.is_test) row.append(makeBadge('TESZT', 'badge-test'));
    return row;
  }

  function createOpenButton(quote) {
    const button = element('button', 'button button-secondary open-quote', 'Megnyitás');
    button.type = 'button';
    button.dataset.quoteId = String(quote.id);
    button.dataset.requestKind = quote.request_kind;
    button.setAttribute('aria-label', `${quote.customer_name} ajánlatkérésének megnyitása`);
    return button;
  }

  function renderQuoteRows() {
    const body = $('#quote-list-body');
    const cards = $('#quote-card-list');
    body.replaceChildren();
    cards.replaceChildren();

    state.filteredQuotes.forEach((quote) => {
      const row = element('tr');

      const dateCell = element('td');
      dateCell.append(document.createTextNode(formatDateTime(quote.created_at)));
      dateCell.append(element('span', 'reference-code', referenceFor(quote)));

      const customerCell = element('td');
      customerCell.append(element('span', 'customer-name', quote.customer_name));
      if (quote.company_name) customerCell.append(element('span', 'customer-company', quote.company_name));

      const typeCell = element('td');
      typeCell.append(badgeRowForQuote(quote));

      const contactCell = element('td');
      contactCell.append(document.createTextNode(quote.phone || quote.email || '—'));
      if (quote.phone && quote.email) contactCell.append(element('span', 'cell-subline', quote.email));

      const statusCell = element('td');
      statusCell.append(statusBadge(quote.status));

      const actionCell = element('td');
      actionCell.append(createOpenButton(quote));

      row.append(dateCell, customerCell, typeCell, contactCell, statusCell, actionCell);
      body.append(row);

      const card = element('article', 'quote-card');
      const top = element('div', 'quote-card-top');
      const main = element('div');
      main.append(element('span', 'customer-name', quote.customer_name));
      if (quote.company_name) main.append(element('span', 'customer-company', quote.company_name));
      main.append(element('span', 'reference-code', referenceFor(quote)));
      top.append(main, statusBadge(quote.status));

      const bottom = element('div', 'quote-card-bottom');
      const meta = element('div');
      meta.append(badgeRowForQuote(quote));
      meta.append(element('span', 'cell-subline', formatDateTime(quote.created_at)));
      bottom.append(meta, createOpenButton(quote));
      card.append(top, bottom);
      cards.append(card);
    });

    $('#result-count').textContent = `${formatNumber(state.filteredQuotes.length, 0)} találat`;

    const empty = state.filteredQuotes.length === 0;
    $('#empty-list').hidden = !empty;
    $('#quote-table-wrap').hidden = empty;
    $('#quote-card-list').hidden = empty;
  }

  function showListView() {
    state.detailRequestSequence += 1;
    $('#list-view').hidden = false;
    $('#detail-view').hidden = true;
    $('#workspace-title').textContent = 'Ajánlatkérések';
    state.activeQuoteId = null;
    state.activeRequestKind = null;
    state.currentFiles = [];
    if (state.lastFocused instanceof HTMLElement) {
      window.setTimeout(() => state.lastFocused?.focus(), 0);
    }
  }

  async function openQuote(id, requestKind, trigger) {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1) return;

    const requestSequence = ++state.detailRequestSequence;
    state.lastFocused = trigger || document.activeElement;
    state.activeQuoteId = numericId;
    state.activeRequestKind = requestKind;
    $('#list-view').hidden = true;
    $('#detail-view').hidden = false;
    $('#detail-loading').hidden = false;
    $('#detail-content').hidden = true;
    $('#workspace-title').textContent = 'Ajánlatkérés részletei';
    window.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      const requestPromise = db
        .from('quote_requests')
        .select('id,created_at,updated_at,status,customer_name,company_name,email,phone,project_type,postcode,city,budget_range,preferred_contact,message,source,approximate_dimensions,wants_callback,wants_quote,wants_consultation,notification_sent_at,notification_error,request_confirmed_at,request_kind')
        .eq('id', numericId)
        .single();

      const workflowPromise = db
        .from('quote_workflows')
        .select('quote_request_id,address,is_test,next_action,next_action_date,next_action_time,next_action_kind,callback_completed_at,work_stage,survey_date,installation_date,agreed_total,deposit_paid,other_paid,updated_at')
        .eq('quote_request_id', numericId)
        .maybeSingle();

      const filesPromise = db
        .from('quote_request_files')
        .select('id,original_name,content_type,size_bytes,file_purpose,storage_path,created_at')
        .eq('quote_request_id', numericId)
        .order('created_at', { ascending: true });

      const offersPromise = db
        .from('quote_offers')
        .select('id,offer_number,version,kind,status,currency,net_total,vat_total,gross_total,deposit_percent,deposit_amount,valid_until,lead_time,sent_at,created_at')
        .eq('quote_request_id', numericId)
        .order('version', { ascending: false });

      const promises = [requestPromise, workflowPromise, filesPromise, offersPromise];

      if (requestKind === 'cutting') {
        promises.push(
          db
            .from('cutting_quote_requests')
            .select('quote_request_id,flow,material_source,size_basis,fulfillment,postal_code,target_date,project_note,material_hint,thickness_mm,help_topics,help_description,submission_state,total_rows,total_pieces,total_area_m2,total_edge_m,created_at,updated_at')
            .eq('quote_request_id', numericId)
            .single(),
          db
            .from('cutting_quote_materials')
            .select('id,quote_request_id,position,client_material_id,name,thickness_mm')
            .eq('quote_request_id', numericId)
            .order('position', { ascending: true }),
          db
            .from('cutting_quote_items')
            .select('id,quote_request_id,material_id,position,label,length_mm,width_mm,quantity,edge_code,edge_material_type,note,area_m2,edge_length_m')
            .eq('quote_request_id', numericId)
            .order('position', { ascending: true })
        );
      }

      const results = await Promise.all(promises);
      if (requestSequence !== state.detailRequestSequence || state.activeQuoteId !== numericId) return;
      const firstError = results.find((result) => result.error)?.error;
      if (firstError) throw firstError;

      const detail = {
        request: results[0].data,
        workflow: results[1].data,
        files: results[2].data || [],
        offers: results[3].data || [],
        cutting: requestKind === 'cutting' ? results[4].data : null,
        materials: requestKind === 'cutting' ? (results[5].data || []) : [],
        items: requestKind === 'cutting' ? (results[6].data || []) : []
      };

      state.currentFiles = detail.files;
      renderDetail(detail);
      $('#detail-loading').hidden = true;
      $('#detail-content').hidden = false;
      window.setTimeout(() => $('#back-to-list')?.focus(), 0);
    } catch (error) {
      if (requestSequence !== state.detailRequestSequence || state.activeQuoteId !== numericId) return;
      console.error('Quote detail load failed', error);
      $('#detail-loading').hidden = true;
      const content = $('#detail-content');
      content.replaceChildren();
      const failed = element('section', 'center-card compact-card');
      failed.append(element('div', 'state-icon', '!'));
      failed.append(element('h2', '', 'Nem sikerült megnyitni az ajánlatkérést'));
      failed.append(element('p', 'muted', 'Frissítsd a listát, majd próbáld újra.'));
      content.append(failed);
      content.hidden = false;
    }
  }

  function renderDetail(detail) {
    const { request, workflow, files, offers, cutting, materials, items } = detail;
    const target = $('#detail-content');
    target.replaceChildren();

    const shell = element('div', 'detail-shell');
    const hero = element('header', 'detail-hero');
    const heroText = element('div');
    heroText.append(element('div', 'detail-reference', referenceFor(request)));
    heroText.append(element('h2', '', request.customer_name));
    if (request.company_name) heroText.append(element('p', 'detail-date', request.company_name));
    heroText.append(element('p', 'detail-date', `Beérkezett: ${formatDateTime(request.created_at)}`));
    const heroBadges = element('div', 'badge-row');
    heroBadges.append(typeBadge(request.request_kind), statusBadge(request.status, 'detail-status-badge'));
    if (workflow?.is_test) heroBadges.append(makeBadge('TESZT', 'badge-test'));
    hero.append(heroText, heroBadges);
    shell.append(hero);

    const grid = element('div', 'detail-grid');
    const mainColumn = element('div', 'detail-column');
    const sideColumn = element('aside', 'detail-column');

    mainColumn.append(renderCustomerCard(request, workflow));
    mainColumn.append(renderRequestCard(request));
    if (request.request_kind === 'cutting' && cutting) {
      mainColumn.append(renderCuttingCard(cutting, materials, items));
    }
    if (files.length) mainColumn.append(renderFilesCard(files));
    if (offers.length) mainColumn.append(renderOffersCard(offers));

    sideColumn.append(renderStatusCard(request));
    sideColumn.append(renderWorkflowCard(workflow));

    grid.append(mainColumn, sideColumn);
    shell.append(grid);
    target.append(shell);
  }

  function renderCustomerCard(request, workflow) {
    const card = detailCard('Ügyfél és elérhetőség');
    const location = [request.postcode, request.city].filter(Boolean).join(' ') || '—';
    card.append(detailList([
      ['Név', request.customer_name],
      ['Cég', request.company_name],
      ['Telefon', phoneLink(request.phone)],
      ['E-mail', emailLink(request.email)],
      ['Kapcsolattartás', PREFERRED_CONTACT_LABELS[request.preferred_contact] || request.preferred_contact],
      ['Település', location],
      ['Cím', workflow?.address],
      ['Érkezés módja', SOURCE_LABELS[request.source] || request.source]
    ]));
    return card;
  }

  function renderRequestCard(request) {
    const card = detailCard('Az érdeklődés tartalma');
    card.append(detailList([
      ['Munka típusa', request.request_kind === 'cutting' ? 'Lapszabászat és ABS élzárás' : (PROJECT_LABELS[request.project_type] || request.project_type)],
      ['Hozzávetőleges méretek', request.approximate_dimensions],
      ['Költségkeret', request.budget_range],
      ['Kért kapcsolat', [request.wants_quote ? 'árajánlat' : null, request.wants_callback ? 'visszahívás' : null, request.wants_consultation ? 'egyeztetés' : null].filter(Boolean).join(', ') || '—']
    ]));
    if (request.message) {
      card.append(element('h3', '', 'Ügyfél üzenete'));
      card.append(element('div', 'prose-box', request.message));
    }
    return card;
  }

  function renderCuttingCard(cutting, materials, items) {
    const card = detailCard('Lapszabászati adatok', 'A méretek kész méretek; az első adat a hossz, vagyis a szálirány.');

    if (cutting.flow === 'manual') {
      const metrics = element('div', 'metric-grid');
      [
        ['Tételsor', formatNumber(cutting.total_rows, 0)],
        ['Darab', formatNumber(cutting.total_pieces, 0)],
        ['Lapfelület', `${formatNumber(cutting.total_area_m2, 3)} m²`],
        ['Élzárás', `${formatNumber(cutting.total_edge_m, 3)} m`]
      ].forEach(([label, value]) => {
        const metric = element('div', 'metric');
        metric.append(element('span', '', label), element('strong', '', value));
        metrics.append(metric);
      });
      card.append(metrics);
    } else {
      const summaryNote = cutting.flow === 'upload'
        ? 'A mennyiségi összesítés a feltöltött szabászjegyzék átnézése után készül el.'
        : 'A tételeket és a mennyiségi összesítést az egyeztetés után rögzítjük.';
      card.append(element('p', 'info-note', summaryNote));
    }

    const helpTopics = Array.isArray(cutting.help_topics)
      ? cutting.help_topics.map((topic) => HELP_TOPIC_LABELS[topic] || topic).join(', ')
      : '';

    card.append(detailList([
      ['Beküldés módja', FLOW_LABELS[cutting.flow] || cutting.flow],
      ['Anyag', MATERIAL_SOURCE_LABELS[cutting.material_source] || cutting.material_source],
      ['Méret értelmezése', cutting.size_basis === 'finished' ? 'Kész méret' : cutting.size_basis],
      ['Átvétel', FULFILLMENT_LABELS[cutting.fulfillment] || cutting.fulfillment],
      ['Kért időpont', formatDate(cutting.target_date)],
      ['Szállítás irányítószáma', cutting.postal_code],
      ['Anyagjelzés', cutting.material_hint],
      ['Vastagság', cutting.thickness_mm ? `${formatNumber(cutting.thickness_mm, 1)} mm` : null],
      ['Segítség témája', helpTopics]
    ]));

    if (cutting.project_note) {
      card.append(element('h3', '', 'Megjegyzés az átvételhez és időzítéshez'));
      card.append(element('div', 'prose-box', cutting.project_note));
    }

    if (cutting.help_description) {
      card.append(element('h3', '', 'Miben kér segítséget?'));
      card.append(element('div', 'prose-box', cutting.help_description));
    }

    const sortedMaterials = [...materials].sort((a, b) => Number(a.position) - Number(b.position));
    const sortedItems = [...items].sort((a, b) => Number(a.position) - Number(b.position));

    sortedMaterials.forEach((material) => {
      const group = element('section', 'material-group');
      const heading = element('div', 'material-heading');
      heading.append(
        element('strong', '', `${material.position}. ${material.name}`),
        element('span', '', `${formatNumber(material.thickness_mm, 1)} mm`)
      );
      group.append(heading);

      const tableWrap = element('div', 'table-wrap');
      const table = element('table', 'cutting-table');
      const head = element('thead');
      const headRow = element('tr');
      ['#', 'Megnevezés', 'Hossz / szálirány', 'Szélesség', 'Db', 'Élkód', 'Élanyag', 'Megjegyzés', 'm²', 'Él m'].forEach((label) => {
        const columnHeading = element('th', '', label);
        columnHeading.scope = 'col';
        headRow.append(columnHeading);
      });
      head.append(headRow);
      table.append(head);

      const body = element('tbody');
      const materialItems = sortedItems.filter((item) => String(item.material_id) === String(material.id));
      materialItems.forEach((item) => {
        const row = element('tr');
        row.append(
          element('td', 'numeric', item.position),
          element('td', '', item.label || '—'),
          element('td', 'numeric', `${formatNumber(item.length_mm, 1)} mm`),
          element('td', 'numeric', `${formatNumber(item.width_mm, 1)} mm`),
          element('td', 'numeric', formatNumber(item.quantity, 0))
        );
        const edgeCell = element('td');
        edgeCell.append(element('span', 'edge-code', item.edge_code));
        row.append(
          edgeCell,
          element('td', '', item.edge_material_type || '—'),
          element('td', '', item.note || '—'),
          element('td', 'numeric', formatNumber(item.area_m2, 3)),
          element('td', 'numeric', formatNumber(item.edge_length_m, 3))
        );
        body.append(row);
      });

      if (!materialItems.length) {
        const row = element('tr');
        const cell = element('td', 'muted', 'Ehhez az anyaghoz nincs tételsor.');
        cell.colSpan = 10;
        row.append(cell);
        body.append(row);
      }

      table.append(body);
      tableWrap.append(table);
      group.append(tableWrap);
      card.append(group);
    });

    if (!sortedMaterials.length && cutting.flow === 'manual') {
      card.append(element('p', 'info-note', 'A kézi szabászjegyzékhez nem található anyag vagy tétel.'));
    }

    return card;
  }

  function renderFilesCard(files) {
    const card = detailCard('Csatolmányok', 'A megnyitott hivatkozás 5 percig használható.');
    const list = element('ul', 'file-list');
    files.forEach((file, index) => {
      const item = element('li', 'file-row');
      const main = element('div', 'file-main');
      main.append(
        element('strong', '', file.original_name),
        element('span', '', `${FILE_PURPOSE_LABELS[file.file_purpose] || file.file_purpose} · ${formatBytes(file.size_bytes)}`)
      );
      const button = element('button', 'button button-secondary file-open', 'Megnyitás');
      button.type = 'button';
      button.dataset.fileIndex = String(index);
      item.append(main, button);
      list.append(item);
    });
    card.append(list);
    return card;
  }

  function renderOffersCard(offers) {
    const card = detailCard('Elkészített ajánlatok');
    const list = element('ul', 'offer-list');
    offers.forEach((offer) => {
      const row = element('li', 'offer-row');
      const main = element('div', 'offer-main');
      main.append(
        element('strong', '', `${offer.offer_number} · ${offer.version}. verzió`),
        element('span', '', `${OFFER_STATUS_LABELS[offer.status] || offer.status} · ${formatDateTime(offer.created_at)}`)
      );
      row.append(main, element('strong', '', formatMoney(offer.gross_total)));
      list.append(row);
    });
    card.append(list);
    return card;
  }

  function renderStatusCard(request) {
    const card = detailCard('Ajánlatkérés állapota');
    const badgeRow = element('div', 'badge-row');
    badgeRow.append(statusBadge(request.status));
    card.append(badgeRow);
    card.append(element('p', 'info-note', 'Ebben az első, biztonságos Műhely-változatban az adatok csak olvashatók. Az állapotmódosítás külön, naplózott műveletként kerül bele.'));
    return card;
  }

  function renderWorkflowCard(workflow) {
    const card = detailCard('Munkafolyamat');
    if (!workflow) {
      card.append(element('p', 'muted', 'Ehhez az ajánlatkéréshez még nincs belső munkafolyamat rögzítve.'));
      return card;
    }

    const nextAction = [workflow.next_action, workflow.next_action_date ? formatDate(workflow.next_action_date) : null, workflow.next_action_time ? String(workflow.next_action_time).slice(0, 5) : null]
      .filter(Boolean)
      .join(' · ');
    const remaining = workflow.agreed_total === null
      ? null
      : Math.max(0, Number(workflow.agreed_total) - Number(workflow.deposit_paid || 0) - Number(workflow.other_paid || 0));

    card.append(detailList([
      ['Tesztadat', workflow.is_test ? 'Igen' : 'Nem'],
      ['Következő teendő', nextAction],
      ['Felmérés', formatDate(workflow.survey_date)],
      ['Beépítés', formatDate(workflow.installation_date)],
      ['Megállapodott összeg', workflow.agreed_total === null ? null : formatMoney(workflow.agreed_total)],
      ['Fennmaradó összeg', remaining === null ? null : formatMoney(remaining)]
    ]));
    return card;
  }

  async function openFile(index, button) {
    const file = state.currentFiles[index];
    if (!file?.storage_path) {
      showMessage('A fájl nem található.', 'error');
      return;
    }

    const fileWindow = window.open('about:blank', '_blank');
    if (fileWindow) {
      fileWindow.opener = null;
      fileWindow.document.title = 'Fájl megnyitása…';
      fileWindow.document.body.textContent = 'A biztonságos hivatkozás elkészítése…';
    }

    setButtonBusy(button, true, 'Nyitás…');
    try {
      const { data, error } = await db.storage
        .from('quote-request-files')
        .createSignedUrl(file.storage_path, FILE_LINK_TTL_SECONDS);
      if (error || !data?.signedUrl) throw error || new Error('Missing signed URL');
      if (fileWindow) fileWindow.location.replace(data.signedUrl);
      else showMessage('A böngésző letiltotta az új ablakot. Engedélyezd az előugró ablakot, majd próbáld újra.', 'error');
    } catch (error) {
      console.error('File signing failed', error);
      fileWindow?.close();
      showMessage('A fájlt most nem sikerült megnyitni.', 'error');
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function boot() {
    if (!db) {
      setView('login-view');
      setFormError($('#login-error'), 'A biztonságos kapcsolat nem indult el. Frissítsd az oldalt.');
      return;
    }

    const { data, error } = await db.auth.getSession();
    if (error || !data?.session) {
      await showLogin();
      return;
    }
    await routeAuthenticated(data.session);
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#login-button');
    const email = String(form.elements.email.value || '').trim();
    const password = String(form.elements.password.value || '');
    setFormError($('#login-error'), '');

    if (!email || !password) {
      setFormError($('#login-error'), 'Add meg az e-mail-címet és a jelszót.');
      return;
    }

    setButtonBusy(button, true, 'Belépés…');
    try {
      const { data, error } = await db.auth.signInWithPassword({ email, password });
      form.elements.password.value = '';
      if (error || !data?.session) throw error || new Error('No session');
      await routeAuthenticated(data.session);
    } catch (error) {
      console.error('Login failed', error);
      setFormError($('#login-error'), 'Sikertelen belépés. Ellenőrizd az adatokat, majd próbáld újra.');
    } finally {
      setButtonBusy(button, false);
    }
  });

  $('#mfa-challenge-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#mfa-verify-button');
    const code = String(form.elements.code.value || '').trim();
    setFormError($('#mfa-challenge-error'), '');

    if (!validTotp(code)) {
      setFormError($('#mfa-challenge-error'), 'Pontosan 6 számjegyet adj meg.');
      return;
    }
    if (!state.mfaFactorId) {
      setFormError($('#mfa-challenge-error'), 'A hitelesítő nem található. Lépj ki, majd próbáld újra.');
      return;
    }

    setButtonBusy(button, true, 'Ellenőrzés…');
    try {
      const { data, error } = await db.auth.mfa.challengeAndVerify({
        factorId: state.mfaFactorId,
        code
      });
      if (error) throw error;
      form.reset();
      const session = data?.session || (await db.auth.getSession()).data?.session;
      await routeAuthenticated(session);
    } catch (error) {
      console.error('MFA challenge failed', error);
      setFormError($('#mfa-challenge-error'), 'A kód nem megfelelő vagy lejárt. Írd be az alkalmazás új kódját.');
      form.elements.code.select();
    } finally {
      setButtonBusy(button, false);
    }
  });

  $('#mfa-enroll-start').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setButtonBusy(button, true, 'QR-kód készítése…');
    setFormError($('#mfa-enroll-error'), '');
    try {
      const { data, error } = await db.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'HEPA Műhely'
      });
      if (error || !data?.id || !data?.totp?.qr_code) throw error || new Error('Invalid enrollment response');
      state.mfaFactorId = data.id;
      $('#mfa-qr').src = data.totp.qr_code;
      $('#mfa-secret').textContent = data.totp.secret || '—';
      $('#mfa-enroll-details').hidden = false;
      button.hidden = true;
      window.setTimeout(() => $('#mfa-enroll-code')?.focus(), 0);
    } catch (error) {
      console.error('MFA enrollment failed', error);
      setFormError($('#mfa-enroll-error'), 'A beállítás most nem indítható el. Lépj ki, majd próbáld újra.');
    } finally {
      setButtonBusy(button, false);
    }
  });

  $('#mfa-enroll-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#mfa-enroll-verify');
    const code = String(form.elements.code.value || '').trim();
    setFormError($('#mfa-enroll-error'), '');

    if (!validTotp(code)) {
      setFormError($('#mfa-enroll-error'), 'Pontosan 6 számjegyet adj meg.');
      return;
    }
    if (!state.mfaFactorId) {
      setFormError($('#mfa-enroll-error'), 'Előbb jelenítsd meg és olvasd be a QR-kódot.');
      return;
    }

    setButtonBusy(button, true, 'Beállítás…');
    try {
      const { data, error } = await db.auth.mfa.challengeAndVerify({
        factorId: state.mfaFactorId,
        code
      });
      if (error) throw error;
      form.reset();
      const session = data?.session || (await db.auth.getSession()).data?.session;
      await routeAuthenticated(session);
      showMessage('A kétlépcsős belépés sikeresen beállítva.');
    } catch (error) {
      console.error('MFA enrollment verification failed', error);
      setFormError($('#mfa-enroll-error'), 'A kód nem megfelelő vagy lejárt. Írd be az alkalmazás új kódját.');
      form.elements.code.select();
    } finally {
      setButtonBusy(button, false);
    }
  });

  $('#quote-search').addEventListener('input', applyFilters);
  $('#kind-filter').addEventListener('change', applyFilters);
  $('#status-filter').addEventListener('change', applyFilters);
  $('#refresh-button').addEventListener('click', () => loadQuotes());
  $('#back-to-list').addEventListener('click', showListView);
  $('#signout-button').addEventListener('click', signOut);
  $('#mfa-signout').addEventListener('click', signOut);
  $('#denied-signout').addEventListener('click', signOut);

  ['pointerdown', 'keydown'].forEach((eventName) => {
    document.addEventListener(eventName, scheduleIdleSignOut, { passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) scheduleIdleSignOut();
  });

  $('#app-view').addEventListener('click', (event) => {
    const openButton = event.target.closest('[data-quote-id]');
    if (openButton) {
      openQuote(openButton.dataset.quoteId, openButton.dataset.requestKind, openButton);
      return;
    }

    const fileButton = event.target.closest('[data-file-index]');
    if (fileButton) openFile(Number(fileButton.dataset.fileIndex), fileButton);
  });

  if (db) {
    db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') window.setTimeout(showLogin, 0);
    });
  }

  boot().catch((error) => {
    console.error('HEPA Műhely boot failed', error);
    setView('login-view');
    setFormError($('#login-error'), 'A Műhely most nem tölthető be. Frissítsd az oldalt.');
  });
})();

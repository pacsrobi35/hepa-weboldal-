/* Optional consented lead measurement. No measurement network before consent. */
(() => {
  'use strict';
  const ADS_ID = 'AW-10787294242';
  const QUOTE_SEND_TO = 'AW-10787294242/s7xoCNDcyPQcEKKY5Jco';
  const CALLBACK_SEND_TO = 'AW-10787294242/igZYCNT_nIkdEKKY5Jco';
  const settingsOnly = document.currentScript?.hasAttribute('data-consent-settings-only') === true;
  const CONSENT_KEY = 'hepa-marketing-consent-v3';
  const PREVIOUS_CONSENT_KEYS = ['hepa-marketing-consent-v2', 'hepa-marketing-consent-v1'];
  const SENT_KEY = 'hepa-quote-conversions-v1';
  const FUNNEL_KEY = 'hepa-lead-funnel-v1';
  const FUNNEL_ENDPOINT = 'https://torczkyodukcvxwzutgf.supabase.co/functions/v1/record-lead-funnel-event';
  const PAGES = new Set(['/', '/index.html', '/konyhabutor.html', '/lapszabaszat.html', '/lapszabaszat-ajanlatkeres.html']);
  const productionHost = ['hepabutor.hu', 'www.hepabutor.hu'].includes(window.location.hostname);
  const ATTRIBUTION_KEY = 'hepa-marketing-attribution-v1';
  const CONSENT_LIFETIME = 180 * 24 * 60 * 60 * 1000;
  const ATTRIBUTION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
  const ATTRIBUTION_FIELDS = ['gclid', 'gbraid', 'wbraid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const denied = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' };
  const granted = { ...denied, ad_storage: 'granted', ad_user_data: 'granted' };
  const pending = new Map();
  let sent = new Set();
  let preference = readPreference();
  let started = false;
  let loaded = false;
  let tag;
  let panel;
  let lastOpener;
  let funnelSession;
  let funnelSent = new Set();
  const funnelPending = new Map();
  let measurementGeneration = 0;
  let formObserver;

  function readPreference() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CONSENT_KEY));
      if (saved?.version === 3 && ['granted', 'denied'].includes(saved.choice)
          && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) return saved;
      // Earlier wording covered successful submissions only. Ask again before
      // measuring intermediate steps, while preserving an existing refusal.
      for (const key of PREVIOUS_CONSENT_KEYS) {
        const previous = JSON.parse(window.localStorage.getItem(key));
        if (previous?.choice === 'denied' && [1, 2].includes(previous.version)
            && Number.isFinite(previous.expiresAt) && previous.expiresAt > Date.now()) {
          return { version: 3, choice: 'denied', expiresAt: previous.expiresAt };
        }
      }
    } catch { /* Storage may be blocked; default remains no measurement. */ }
    return null;
  }

  function hasConsent() {
    return preference?.choice === 'granted' && preference.expiresAt > Date.now();
  }

  function command() {
    window.dataLayer.push(arguments);
  }

  function readSent() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(SENT_KEY));
      if (Array.isArray(saved)) sent = new Set(saved.filter(id => UUID.test(id)).slice(-100));
    } catch { /* The in-memory set still deduplicates this page. */ }
  }

  function rememberSent(id) {
    sent.add(id);
    sent = new Set([...sent].slice(-100));
    try { window.sessionStorage.setItem(SENT_KEY, JSON.stringify([...sent])); } catch { /* Optional storage. */ }
  }

  function canMeasure() {
    return hasConsent() && productionHost && !settingsOnly;
  }

  function funnelIdentity() {
    if (funnelSession) return funnelSession;
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(FUNNEL_KEY));
      if (UUID.test(saved?.sessionToken)) {
        funnelSession = saved.sessionToken;
        if (Array.isArray(saved.sent)) funnelSent = new Set(saved.sent.filter(key =>
          /^(callback|cutting):(cta_click|form_view|form_start|submit_attempt|submit_success)$/.test(key)));
      }
    } catch { /* Optional storage; the form must still work. */ }
    if (!funnelSession) {
      try { funnelSession = window.crypto?.randomUUID(); } catch { /* No insecure identifier fallback. */ }
      if (!UUID.test(funnelSession)) return null;
    }
    rememberFunnel();
    return funnelSession;
  }

  function rememberFunnel() {
    if (!canMeasure() || !funnelSession) return;
    try {
      window.sessionStorage.setItem(FUNNEL_KEY, JSON.stringify({ sessionToken: funnelSession, sent: [...funnelSent] }));
    } catch { /* In-memory deduplication remains available. */ }
  }

  function recordFunnel(event, funnel, submissionToken) {
    if (!canMeasure() || !PAGES.has(window.location.pathname) || typeof window.fetch !== 'function'
        || !['callback', 'cutting'].includes(funnel)
        || !['cta_click', 'form_view', 'form_start', 'submit_attempt', 'submit_success'].includes(event)
        || (event === 'submit_success' && !UUID.test(submissionToken))) return false;
    const sessionToken = funnelIdentity();
    const key = funnel + ':' + event;
    if (!sessionToken || funnelSent.has(key) || funnelPending.has(key)) return false;
    // This allowlist intentionally excludes form fields, query strings, ad IDs and referrers.
    const body = {
      sessionToken, event, funnel, page: window.location.pathname,
      device: window.matchMedia?.('(max-width: 767px)').matches ? 'mobile' : 'desktop'
    };
    if (event === 'submit_success') body.submissionToken = submissionToken;
    const generation = measurementGeneration;
    const controller = typeof window.AbortController === 'function' ? new window.AbortController() : null;
    funnelPending.set(key, controller);
    try {
      Promise.resolve(window.fetch(FUNNEL_ENDPOINT, {
        method: 'POST', headers: {
          'Content-Type': 'application/json',
          apikey: 'sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl'
        },
        body: JSON.stringify(body), keepalive: true, credentials: 'omit',
        ...(controller ? { signal: controller.signal } : {})
      })).then(response => {
        if (response.ok && canMeasure() && generation === measurementGeneration) {
          funnelSent.add(key);
          rememberFunnel();
        }
      }).catch(() => { /* Measurement failure cannot interrupt navigation or submission. */ })
        .finally(() => {
          if (generation === measurementGeneration) funnelPending.delete(key);
        });
    } catch { funnelPending.delete(key); }
    return true;
  }

  function formFunnel(form) {
    return form?.id === 'quoteForm' ? 'callback' : form?.id === 'cutting-form' ? 'cutting' : null;
  }

  function visibleForm(form) {
    if (form.hidden || typeof form.getBoundingClientRect !== 'function') return false;
    const rect = form.getBoundingClientRect();
    const height = window.innerHeight || document.documentElement.clientHeight;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const visibleHeight = Math.max(0, Math.min(rect.bottom, height) - Math.max(rect.top, 0));
    const visibleWidth = Math.max(0, Math.min(rect.right, width) - Math.max(rect.left, 0));
    // A long cutting form can exceed one screen; require a quarter of the screen
    // or a quarter of the form, whichever is smaller, rather than counting page load.
    return rect.height > 0 && rect.width > 0
      && visibleHeight >= Math.min(rect.height, height) * 0.25
      && visibleWidth >= Math.min(rect.width, width) * 0.25;
  }

  function checkFormViews() {
    if (!canMeasure()) return;
    for (const id of ['quoteForm', 'cutting-form']) {
      const form = document.getElementById?.(id);
      if (form && visibleForm(form)) recordFunnel('form_view', formFunnel(form));
    }
  }

  function initializeFunnel() {
    if (!productionHost || settingsOnly || !PAGES.has(window.location.pathname)) return;
    if (typeof window.IntersectionObserver === 'function') {
      formObserver = new window.IntersectionObserver(() => checkFormViews(), { threshold: [0, 0.25] });
      for (const id of ['quoteForm', 'cutting-form']) {
        const form = document.getElementById?.(id);
        if (form) formObserver.observe(form);
      }
    }
    window.addEventListener('scroll', checkFormViews, { passive: true });
    window.addEventListener('resize', checkFormViews, { passive: true });
    document.addEventListener?.('click', event => {
      if (event.isTrusted !== true || !canMeasure()) return;
      const anchor = event.target.closest?.('a[href]');
      if (anchor && !anchor.hasAttribute('download')) {
        try {
          const url = new URL(anchor.href, window.location.origin);
          if (url.origin === window.location.origin) {
            if (['/', '/index.html'].includes(url.pathname) && url.hash === '#ajanlat') recordFunnel('cta_click', 'callback');
            else if (url.pathname === '/lapszabaszat-ajanlatkeres.html') recordFunnel('cta_click', 'cutting');
          }
        } catch { /* Ignore malformed links. */ }
      }
      const button = event.target.closest?.('#add-material, #add-edge-profile, [data-add-item], [data-item-action="duplicate"]');
      const form = button?.closest?.('#cutting-form');
      if (form && !button.disabled) { checkFormViews(); recordFunnel('form_start', 'cutting'); }
    });
    const interaction = event => {
      if (event.isTrusted !== true || !canMeasure()) return;
      const control = event.target;
      const form = control.closest?.('#quoteForm, #cutting-form');
      if (!form || control.disabled || control.name === 'company_website'
          || !control.matches?.('input, select, textarea')
          || ['hidden', 'button', 'submit', 'reset'].includes(control.type)) return;
      checkFormViews();
      recordFunnel('form_start', formFunnel(form));
    };
    document.addEventListener?.('input', interaction);
    document.addEventListener?.('change', interaction);
    document.addEventListener?.('drop', event => {
      if (event.isTrusted === true && event.dataTransfer?.files?.length
          && event.target.closest?.('#cutting-form .drop-zone')) {
        checkFormViews();
        recordFunnel('form_start', 'cutting');
      }
    });
  }


  function cleanAttributionValue(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
  }

  function readPageAttribution() {
    const params = new URLSearchParams(window.location.search);
    const result = {};
    const limits = {
      gclid: 512, gbraid: 512, wbraid: 512,
      utm_source: 100, utm_medium: 100, utm_campaign: 200,
      utm_term: 500, utm_content: 500
    };
    for (const key of ATTRIBUTION_FIELDS) {
      const value = cleanAttributionValue(params.get(key), limits[key]);
      if (value) result[key] = value;
    }
    if (!Object.keys(result).length) return null;
    result.landing_page = cleanAttributionValue(window.location.pathname, 500);
    if (document.referrer) {
      try {
        const referrer = new URL(document.referrer);
        if (referrer.origin !== window.location.origin) {
          result.initial_referrer = cleanAttributionValue(referrer.origin + referrer.pathname, 500);
        }
      } catch { /* Ignore malformed referrers. */ }
    }
    return result;
  }

  const pageAttribution = readPageAttribution();

  function readStoredAttribution() {
    if (!hasConsent()) return null;
    try {
      const saved = JSON.parse(window.localStorage.getItem(ATTRIBUTION_KEY));
      if (saved?.version !== 1 || !Number.isFinite(saved.expiresAt) || saved.expiresAt <= Date.now()) {
        window.localStorage.removeItem(ATTRIBUTION_KEY);
        return null;
      }
      const { version, expiresAt, ...data } = saved;
      return data;
    } catch {
      return null;
    }
  }

  function saveCurrentAttribution() {
    if (!hasConsent() || !pageAttribution) return;
    try {
      window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify({
        version: 1,
        expiresAt: Date.now() + ATTRIBUTION_LIFETIME,
        ...pageAttribution
      }));
    } catch { /* Attribution is optional; the form must keep working. */ }
  }

  function clearStoredAttribution() {
    try { window.localStorage.removeItem(ATTRIBUTION_KEY); } catch { /* Optional storage. */ }
  }

  function flush() {
    if (!hasConsent() || !loaded) return;
    for (const [id, sendTo] of pending) {
      pending.delete(id);
      if (sent.has(id)) continue;
      // Only a confirmed request UUID is sent. No form fields or HEPA reference numbers.
      command('event', 'conversion', { send_to: sendTo, transaction_id: id });
      rememberSent(id);
    }
  }

  function startMeasurement() {
    if (!canMeasure()) return;
    if (started) {
      command('consent', 'update', granted);
      flush();
      return;
    }
    readSent();
    started = true;
    window.dataLayer = window.dataLayer || [];
    command('consent', 'default', denied);
    command('consent', 'update', granted);
    command('set', 'ads_data_redaction', true);
    command('set', 'url_passthrough', false);
    command('set', 'allow_ad_personalization_signals', false);
    command('js', new Date());
    command('config', ADS_ID, {
      send_page_view: false,
      allow_ad_personalization_signals: false,
      allow_enhanced_conversions: false
    });
    tag = document.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + ADS_ID;
    tag.onload = () => { loaded = true; flush(); };
    tag.onerror = () => { pending.clear(); };
    document.head.appendChild(tag);
  }

  function clearMeasurementCookies() {
    const host = window.location.hostname;
    const domains = ['', host, '.' + host];
    if (host === 'hepabutor.hu' || host.endsWith('.hepabutor.hu')) domains.push('hepabutor.hu', '.hepabutor.hu');
    for (const item of document.cookie.split(';')) {
      const name = item.split('=')[0].trim();
      if (!/^_gcl_|^_gac_/.test(name)) continue;
      for (const domain of new Set(domains)) {
        document.cookie = name + '=; Max-Age=0; Path=/; SameSite=Lax' + (domain ? '; Domain=' + domain : '');
      }
    }
  }

  function stopMeasurement() {
    measurementGeneration += 1;
    for (const controller of funnelPending.values()) controller?.abort();
    funnelPending.clear();
    funnelSession = null;
    funnelSent.clear();
    pending.clear();
    if (started) command('consent', 'update', denied);
    clearMeasurementCookies();
    // Retain only the in-memory sent set to avoid re-emitting a quote if consent is restored.
    // The optional session storage is removed immediately on withdrawal.
    try { window.sessionStorage.removeItem(SENT_KEY); } catch { /* Optional storage. */ }
    try { window.sessionStorage.removeItem(FUNNEL_KEY); } catch { /* Optional storage. */ }
    clearStoredAttribution();
  }

  function choose(choice) {
    preference = { version: 3, choice, expiresAt: Date.now() + CONSENT_LIFETIME };
    try { window.localStorage.setItem(CONSENT_KEY, JSON.stringify(preference)); } catch { /* Keep this page's choice. */ }
    if (choice === 'granted') {
      saveCurrentAttribution();
      startMeasurement();
      checkFormViews();
    } else stopMeasurement();
    closePanel();
  }

  function closePanel() {
    panel.hidden = true;
    document.documentElement.classList.remove('hepa-consent-open');
    lastOpener?.focus();
  }

  function openPanel(opener) {
    lastOpener = opener || null;
    panel.querySelector('[data-consent-status]').textContent = preference
      ? (hasConsent() ? 'A hirdetésmérés jelenleg engedélyezve van. Itt bármikor visszavonhatja.' : 'A hirdetésmérés jelenleg ki van kapcsolva.')
      : '';
    panel.querySelector('[data-consent-close]').hidden = !preference;
    panel.hidden = false;
    document.documentElement.classList.add('hepa-consent-open');
    if (opener) panel.querySelector('[data-consent-reject]').focus();
  }

  function createPanel() {
    panel = document.createElement('section');
    panel.className = 'hepa-consent';
    panel.hidden = true;
    panel.setAttribute('aria-labelledby', 'hepa-consent-title');
    panel.innerHTML = `
      <div class="hepa-consent-copy">
        <h2 id="hepa-consent-title">Segíthet mérni hirdetéseink eredményét</h2>
        <p>Engedélyezi a hirdetésmérést? A Google Ads a sikeres bútoros visszahíváskérést és lapszabászati ajánlatkérést méri. A HEPA saját mérésében azt is látjuk, hányan kattintanak az ajánlatkérésre, jutnak el az űrlapig, kezdik kitölteni és küldik el. Az űrlap adatait nem küldjük a méréshez, és nem használunk személyre szabott hirdetést. Az oldal és az ajánlatkérés engedély nélkül is működik.</p>
        <p><a href="/adatkezeles.html#meres">Részletek az adatkezelésről</a><span data-consent-status></span></p>
      </div>
      <div class="hepa-consent-actions">
        <button type="button" data-consent-reject>Nem engedélyezem</button>
        <button type="button" data-consent-accept>Engedélyezem</button>
        <button type="button" class="hepa-consent-close" data-consent-close hidden>Beállítások bezárása</button>
      </div>`;
    panel.querySelector('[data-consent-reject]').addEventListener('click', () => choose('denied'));
    panel.querySelector('[data-consent-accept]').addEventListener('click', () => choose('granted'));
    panel.querySelector('[data-consent-close]').addEventListener('click', closePanel);
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && preference) closePanel();
    });
    document.body.appendChild(panel);
    document.querySelectorAll('[data-marketing-settings]').forEach(button => {
      button.addEventListener('click', () => openPanel(button));
    });
    if (!preference) openPanel();
  }

  // Called only from the corresponding form's backend-confirmed success branch.
  window.HEPAMarketing = Object.freeze({
    recordQuoteSubmission({ requestMode, responseOk, ok, state, reference, submissionToken } = {}) {
      if (!canMeasure() || !['quote', 'callback'].includes(requestMode)
          || responseOk !== true || ok !== true || state !== 'ready'
          || typeof submissionToken !== 'string' || !UUID.test(submissionToken)) return false;
      if (requestMode === 'callback' && (typeof reference !== 'string' || !/^HEPA-\d{6,}$/.test(reference))) return false;
      if (requestMode === 'callback') recordFunnel('submit_success', 'callback', submissionToken);
      if (sent.has(submissionToken) || pending.has(submissionToken)) return false;
      pending.set(submissionToken, requestMode === 'callback' ? CALLBACK_SEND_TO : QUOTE_SEND_TO);
      flush();
      return true;
    },
    recordCuttingQuoteSubmission({ responseOk, ok, reference, submissionToken } = {}) {
      // The cutting endpoint confirms finalization with ok + reference, without a state field.
      // Its honeypot response has no reference and must never count as an inquiry.
      if (!canMeasure() || responseOk !== true || ok !== true
          || typeof reference !== 'string' || !/^HEPA-LSZ-\d{6,}$/.test(reference)
          || typeof submissionToken !== 'string' || !UUID.test(submissionToken)) return false;
      recordFunnel('submit_success', 'cutting', submissionToken);
      if (sent.has(submissionToken) || pending.has(submissionToken)) return false;
      pending.set(submissionToken, QUOTE_SEND_TO);
      flush();
      return true;
    },
    // Called only after all form-specific validation has passed.
    recordSubmitAttempt({ funnel } = {}) {
      return recordFunnel('submit_attempt', funnel);
    },
    appendAttribution(formData) {
      if (!(formData instanceof FormData) || !hasConsent()) return false;
      const attribution = readStoredAttribution();
      if (!attribution) return false;
      formData.set('marketing_attribution', JSON.stringify(attribution));
      return true;
    },
    getAttribution() {
      const attribution = readStoredAttribution();
      return attribution ? Object.freeze({ ...attribution }) : null;
    }
  });

  window.addEventListener('storage', event => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    preference = readPreference();
    if (hasConsent()) { startMeasurement(); checkFormViews(); }
    else stopMeasurement();
  });
  createPanel();
  initializeFunnel();
  if (hasConsent()) {
    saveCurrentAttribution();
    startMeasurement();
    checkFormViews();
  }
})();

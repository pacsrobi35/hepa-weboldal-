/* Optional Google Ads lead measurement. Basic consent mode: no Google tag before consent. */
(() => {
  'use strict';
  const ADS_ID = 'AW-10787294242';
  const SEND_TO = 'AW-10787294242/s7xoCNDcyPQcEKKY5Jco';
  const settingsOnly = document.currentScript?.hasAttribute('data-consent-settings-only') === true;
  const CONSENT_KEY = 'hepa-marketing-consent-v1';
  const SENT_KEY = 'hepa-quote-conversions-v1';
  const CONSENT_LIFETIME = 180 * 24 * 60 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const denied = { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied', analytics_storage: 'denied' };
  const granted = { ...denied, ad_storage: 'granted', ad_user_data: 'granted' };
  const pending = new Set();
  let sent = new Set();
  let preference = readPreference();
  let started = false;
  let loaded = false;
  let tag;
  let panel;
  let lastOpener;

  function readPreference() {
    try {
      const saved = JSON.parse(window.localStorage.getItem(CONSENT_KEY));
      if (saved?.version === 1 && ['granted', 'denied'].includes(saved.choice)
          && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now()) return saved;
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

  function flush() {
    if (!hasConsent() || !loaded) return;
    for (const id of pending) {
      pending.delete(id);
      if (sent.has(id)) continue;
      // Only a confirmed request UUID is sent. No form fields or HEPA reference numbers.
      command('event', 'conversion', { send_to: SEND_TO, transaction_id: id });
      rememberSent(id);
    }
  }

  function startMeasurement() {
    if (!hasConsent() || settingsOnly) return;
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
    pending.clear();
    if (started) command('consent', 'update', denied);
    clearMeasurementCookies();
    // Retain only the in-memory sent set to avoid re-emitting a quote if consent is restored.
    // The optional session storage is removed immediately on withdrawal.
    try { window.sessionStorage.removeItem(SENT_KEY); } catch { /* Optional storage. */ }
  }

  function choose(choice) {
    preference = { version: 1, choice, expiresAt: Date.now() + CONSENT_LIFETIME };
    try { window.localStorage.setItem(CONSENT_KEY, JSON.stringify(preference)); } catch { /* Keep this page's choice. */ }
    if (choice === 'granted') startMeasurement();
    else stopMeasurement();
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
        <p>Engedélyezi, hogy a Google Ads sütikkel és technikai adatokkal mérje, mely hirdetésekből érkezik sikeres ajánlatkérés? Az űrlap adatait nem adjuk át a Google-nek, és nem használunk személyre szabott hirdetést. Az oldal és az ajánlatkérés engedély nélkül is működik.</p>
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

  // Called only from the furniture form's backend-confirmed success branch.
  window.HEPAMarketing = Object.freeze({
    recordQuoteSubmission({ requestMode, responseOk, ok, state, submissionToken } = {}) {
      if (!hasConsent() || settingsOnly || requestMode !== 'quote' || responseOk !== true || ok !== true
          || state !== 'ready' || typeof submissionToken !== 'string' || !UUID.test(submissionToken)) return false;
      if (sent.has(submissionToken) || pending.has(submissionToken)) return false;
      pending.add(submissionToken);
      flush();
      return true;
    }
  });

  window.addEventListener('storage', event => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    preference = readPreference();
    if (hasConsent()) startMeasurement();
    else stopMeasurement();
  });
  createPanel();
  if (hasConsent()) startMeasurement();
})();

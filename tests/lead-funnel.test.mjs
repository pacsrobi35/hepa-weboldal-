import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../marketing-consent.js', import.meta.url), 'utf8');
const SESSION = '20000000-0000-4000-8000-000000000001';
const SUBMISSION = '30000000-0000-4000-8000-000000000001';
const CONSENT = 'hepa-marketing-consent-v3';
const FUNNEL = 'hepa-lead-funnel-v1';
const ENDPOINT = 'https://torczkyodukcvxwzutgf.supabase.co/functions/v1/record-lead-funnel-event';

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const operations = [];
  return {
    values, operations,
    getItem(key) { operations.push(['get', key]); return values.get(key) ?? null; },
    setItem(key, value) { operations.push(['set', key]); values.set(key, value); },
    removeItem(key) { operations.push(['remove', key]); values.delete(key); },
  };
}

function element() {
  return {
    nodes: {}, listeners: {}, hidden: false, disabled: false,
    addEventListener(type, handler) { this.listeners[type] = handler; },
    querySelector(selector) { return this.nodes[selector] ||= element(); },
    setAttribute() {}, hasAttribute() { return false; }, focus() {},
    classList: { add() {}, remove() {} },
    closest() { return null; },
  };
}

function harness({
  path = '/', host = 'hepabutor.hu', local = {}, session = {}, settingsOnly = false,
  request = async () => ({ ok: true }), visible = false,
} = {}) {
  const requests = [], scripts = [], documentListeners = {}, windowListeners = {}, observers = [];
  const form = element();
  form.id = path === '/lapszabaszat-ajanlatkeres.html' ? 'cutting-form' : 'quoteForm';
  let rect = visible
    ? { top: 100, bottom: 700, left: 0, right: 600, width: 600, height: 600 }
    : { top: 2000, bottom: 2600, left: 0, right: 600, width: 600, height: 600 };
  form.getBoundingClientRect = () => rect;
  let panel;
  const settings = element();
  const document = {
    currentScript: { hasAttribute: () => settingsOnly },
    documentElement: { ...element(), clientHeight: 800, clientWidth: 600 },
    createElement: element,
    body: { appendChild(node) { panel = node; } },
    head: { appendChild(node) { scripts.push(node); } },
    getElementById(id) { return id === form.id ? form : null; },
    querySelectorAll() { return [settings]; },
    addEventListener(type, handler) { (documentListeners[type] ||= []).push(handler); },
    get cookie() { return ''; }, set cookie(_) {},
    referrer: '',
  };
  const window = {
    location: { hostname: host, origin: 'https://' + host, pathname: path, search: '?utm_term=PRIVATE_SEARCH&gclid=PRIVATE_AD_ID' },
    localStorage: storage(local), sessionStorage: storage(session),
    innerHeight: 800, innerWidth: 600,
    crypto: { randomUUID: () => SESSION }, AbortController,
    matchMedia: () => ({ matches: true }),
    addEventListener(type, handler) { (windowListeners[type] ||= []).push(handler); },
    IntersectionObserver: class {
      constructor(callback, options) { this.callback = callback; this.options = options; observers.push(this); }
      observe(node) { this.node = node; }
    },
    fetch(url, options) { requests.push({ url, options, body: JSON.parse(options.body) }); return request(url, options); },
  };
  vm.runInNewContext(source, { window, document, URL, URLSearchParams, console });
  return {
    window, document, form, requests, scripts, observers, panel,
    choose(choice) { panel.querySelector(`[data-consent-${choice === 'granted' ? 'accept' : 'reject'}]`).listeners.click(); },
    loaded() { scripts[0].onload(); },
    event(type, target, extra = {}) {
      for (const handler of documentListeners[type] || []) handler({ isTrusted: true, target, ...extra });
    },
    scroll() { for (const handler of windowListeners.scroll || []) handler(); },
    setRect(next) { rect = next; },
    cta(funnel = 'callback') {
      const anchor = element();
      anchor.href = 'https://' + host + (funnel === 'callback' ? '/?tipus=konyha#ajanlat' : '/lapszabaszat-ajanlatkeres.html?ut=upload');
      anchor.closest = selector => selector === 'a[href]' ? anchor : null;
      this.event('click', anchor);
    },
    input({ trusted = true, type = 'text', name = 'customer_name' } = {}) {
      const input = element();
      Object.assign(input, { type, name, value: 'PERSONAL_VALUE', files: [{ name: 'PRIVATE_FILENAME.pdf' }] });
      input.matches = () => true;
      input.closest = selector => selector === '#quoteForm, #cutting-form' ? form : null;
      this.event('input', input, { isTrusted: trusted });
    },
    success(funnel = 'callback', overrides = {}) {
      const payload = {
        requestMode: 'callback', responseOk: true, ok: true, state: 'ready',
        reference: funnel === 'cutting' ? 'HEPA-LSZ-000123' : 'HEPA-000123',
        submissionToken: SUBMISSION, ...overrides,
      };
      return funnel === 'cutting'
        ? window.HEPAMarketing.recordCuttingQuoteSubmission(payload)
        : window.HEPAMarketing.recordQuoteSubmission(payload);
    },
  };
}

async function settled() { await new Promise(resolve => setImmediate(resolve)); }

test('refusal creates no funnel storage or requests, and later consent never replays earlier actions', async () => {
  const app = harness();
  app.cta(); app.input(); app.success();
  app.window.HEPAMarketing.recordSubmitAttempt({ funnel: 'callback' });
  assert.equal(app.requests.length, 0);
  assert.equal(app.window.sessionStorage.operations.length, 0);
  app.choose('denied');
  app.cta(); app.input(); app.success();
  assert.equal(app.requests.length, 0);
  assert.equal(app.window.sessionStorage.values.size, 0);
  app.choose('granted');
  await settled();
  assert.equal(app.requests.length, 0, 'offscreen form and earlier actions must not count');
  app.cta();
  assert.deepEqual(app.requests.map(({ body }) => body.event), ['cta_click']);
});

test('old grants require renewed permission for steps, but valid old refusals remain respected', () => {
  for (const version of [1, 2]) {
    const key = 'hepa-marketing-consent-v' + version;
    for (const choice of ['granted', 'denied']) {
      const app = harness({ visible: true, local: { [key]: JSON.stringify({ version, choice, expiresAt: Date.now() + 60000 }) } });
      assert.equal(app.requests.length, 0);
      assert.equal(app.scripts.length, 0);
      assert.equal(app.window.sessionStorage.operations.length, 0);
      assert.equal(app.panel.hidden, choice === 'denied');
    }
  }
});

test('form views require visible form geometry and are deduplicated across callbacks', async () => {
  const app = harness();
  app.choose('granted');
  app.observers[0].callback([]);
  assert.equal(app.requests.length, 0);
  app.setRect({ top: 700, bottom: 1300, left: 0, right: 600, width: 600, height: 600 });
  app.scroll();
  assert.equal(app.requests.length, 0, 'a sliver of the form is insufficient');
  app.setRect({ top: 600, bottom: 1200, left: 0, right: 600, width: 600, height: 600 });
  app.scroll(); app.scroll(); app.observers[0].callback([]);
  assert.deepEqual(app.requests.map(({ body }) => body.event), ['form_view']);
  await settled();
  app.scroll();
  assert.equal(app.requests.length, 1);
  const hidden = harness({ visible: true });
  hidden.form.hidden = true;
  hidden.choose('granted');
  assert.equal(hidden.requests.length, 0);
});

test('actual input, file and added-row activity counts start; focus, menu and synthetic prefills do not', async () => {
  const app = harness({ path: '/lapszabaszat-ajanlatkeres.html', visible: true });
  app.choose('granted');
  app.event('focusin', app.form);
  app.event('click', element());
  app.input({ trusted: false });
  app.input({ type: 'hidden' });
  app.input({ name: 'company_website' });
  assert.deepEqual(app.requests.map(({ body }) => body.event), ['form_view']);
  app.input({ type: 'file' }); app.input();
  await settled();
  assert.deepEqual(app.requests.map(({ body }) => body.event), ['form_view', 'form_start']);
  const rowApp = harness({ path: '/lapszabaszat-ajanlatkeres.html' });
  rowApp.choose('granted');
  const button = element();
  button.closest = selector => selector === '#cutting-form' ? rowApp.form : selector.includes('[data-add-item]') ? button : null;
  rowApp.event('click', button);
  assert.deepEqual(rowApp.requests.map(({ body }) => body.event), ['form_start']);
});

test('step payload is limited to its declared schema without fields, ad identifiers or URL parameters', () => {
  const app = harness({ visible: true });
  app.choose('granted'); app.cta(); app.input();
  app.window.HEPAMarketing.recordSubmitAttempt({ funnel: 'callback', email: 'PRIVATE_EMAIL', page: 'UNTRUSTED_PAGE' });
  app.success();
  assert.deepEqual(app.requests.map(({ body }) => body.event), ['form_view', 'cta_click', 'form_start', 'submit_attempt', 'submit_success']);
  for (const { url, options, body } of app.requests) {
    assert.equal(url, ENDPOINT);
    assert.equal(options.keepalive, true);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.apikey, 'sb_publishable_DPpJ2bkxAvoo6Xqp_gDi2g_oGRNIIbl');
    assert.deepEqual(Object.keys(body).sort(), (body.event === 'submit_success'
      ? ['sessionToken', 'event', 'funnel', 'page', 'device', 'submissionToken']
      : ['sessionToken', 'event', 'funnel', 'page', 'device']).sort());
    assert.equal(body.page, '/'); assert.equal(body.device, 'mobile');
    assert.equal(JSON.stringify(body).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(body).includes('PERSONAL'), false);
  }
});

test('intermediate steps never emit Ads conversions and only confirmed success uses its conversion action', () => {
  const app = harness({ visible: true });
  app.choose('granted'); app.loaded(); app.cta(); app.input();
  app.window.HEPAMarketing.recordSubmitAttempt({ funnel: 'callback' });
  const conversions = () => (app.window.dataLayer || []).filter(args => args[0] === 'event');
  assert.equal(conversions().length, 0);
  for (const invalid of [{ state: 'ingesting' }, { responseOk: false }, { reference: '' }, { submissionToken: 'PRIVATE_EMAIL' }]) app.success('callback', invalid);
  assert.equal(app.requests.some(({ body }) => body.event === 'submit_success'), false);
  app.success(); app.success();
  assert.equal(conversions().length, 1);
  assert.equal(conversions()[0][2].send_to, 'AW-10787294242/igZYCNT_nIkdEKKY5Jco');
  assert.equal(app.requests.filter(({ body }) => body.event === 'submit_success').length, 1);
  const cutting = harness({ path: '/lapszabaszat-ajanlatkeres.html' });
  cutting.choose('granted'); cutting.loaded(); cutting.success('cutting');
  assert.equal(cutting.requests[0].body.funnel, 'cutting');
  assert.equal(cutting.window.dataLayer.find(args => args[0] === 'event')[2].send_to, 'AW-10787294242/s7xoCNDcyPQcEKKY5Jco');
});

test('session identity and completed steps persist across page navigation without duplicating CTA', async () => {
  const first = harness(); first.choose('granted'); first.cta(); await settled();
  const next = harness({ path: '/index.html', local: Object.fromEntries(first.window.localStorage.values), session: Object.fromEntries(first.window.sessionStorage.values) });
  next.cta();
  assert.equal(next.requests.length, 0);
  next.input();
  assert.equal(next.requests[0].body.sessionToken, first.requests[0].body.sessionToken);
});

test('withdrawal aborts pending steps, clears optional session state and does not restore it after late replies', async () => {
  let finish;
  const app = harness({ request: () => new Promise(resolve => { finish = resolve; }) });
  app.choose('granted'); app.cta();
  assert.ok(app.window.sessionStorage.getItem(FUNNEL));
  const pendingSignal = app.requests[0].options.signal;
  app.choose('denied');
  assert.equal(pendingSignal.aborted, true);
  assert.equal(app.window.sessionStorage.getItem(FUNNEL), null);
  app.input(); app.cta(); app.success();
  finish({ ok: true }); await settled();
  assert.equal(app.requests.length, 1);
  assert.equal(app.window.sessionStorage.getItem(FUNNEL), null);
});

test('measurement network failure is swallowed; later actual actions may retry without holding the form', async () => {
  const app = harness({ request: () => Promise.reject(new Error('offline')) });
  app.choose('granted');
  assert.doesNotThrow(() => { app.cta(); app.success(); });
  await settled();
  assert.equal(app.requests.length, 2);
  app.cta(); await settled();
  assert.equal(app.requests.length, 3);
  const synchronous = harness({ request: () => { throw new Error('blocked'); } });
  synchronous.choose('granted');
  assert.doesNotThrow(() => synchronous.success());
});

test('settings-only pages, unsupported paths and preview hosts create no measurement requests', () => {
  for (const options of [{ settingsOnly: true }, { host: 'preview.vercel.app' }, { path: '/adatkezeles.html' }]) {
    const app = harness(options);
    app.choose('granted'); app.cta(); app.input(); app.success();
    app.window.HEPAMarketing.recordSubmitAttempt({ funnel: 'callback' });
    assert.equal(app.requests.length, 0);
    assert.equal(app.window.sessionStorage.getItem(FUNNEL), null);
    if (options.settingsOnly || options.host) assert.equal(app.scripts.length, 0);
  }
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const marketingSource = readFileSync(new URL('../marketing-consent.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const uuid = '10000000-0000-4000-8000-000000000001';

function element() {
  return {
    listeners: {}, nodes: {}, hidden: false, style: {}, value: '', files: [],
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector(selector) { return this.nodes[selector] ||= element(); },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    getAttribute(name) { return this[name]; },
    matches() { return false; }, focus() {}, scrollIntoView() {},
    setCustomValidity(value) { this.validityMessage = value; },
  };
}

function marketing(initial = {}) {
  const nodes = {}, scripts = [], values = new Map(Object.entries(initial));
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
  const document = {
    currentScript: { hasAttribute: () => false }, documentElement: element(),
    body: { appendChild(node) { nodes.panel = node; } },
    head: { appendChild(script) { scripts.push(script); } },
    createElement: element, querySelectorAll: () => [],
    get cookie() { return ''; }, set cookie(_) {},
  };
  const window = {
    localStorage: storage, sessionStorage: storage,
    location: { hostname: 'hepabutor.hu' }, addEventListener() {},
  };
  vm.runInNewContext(marketingSource, { window, document, URLSearchParams, URL });
  return {
    nodes, scripts, window,
    choose(choice) { nodes.panel.querySelector(`[data-consent-${choice === 'granted' ? 'accept' : 'reject'}]`).listeners.click(); },
    conversions() { return (window.dataLayer || []).filter(args => args[0] === 'event'); },
  };
}

test('old ad consent is not silently extended to callbacks, while old refusal remains', () => {
  const oldGranted = JSON.stringify({ version: 1, choice: 'granted', expiresAt: Date.now() + 60000 });
  const oldDenied = JSON.stringify({ version: 1, choice: 'denied', expiresAt: Date.now() + 60000 });
  const granted = marketing({ 'hepa-marketing-consent-v1': oldGranted });
  assert.equal(granted.scripts.length, 0);
  assert.equal(granted.nodes.panel.hidden, false);
  const denied = marketing({ 'hepa-marketing-consent-v1': oldDenied });
  assert.equal(denied.scripts.length, 0);
  assert.equal(denied.nodes.panel.hidden, true);
});

test('one confirmed callback is measured after consent, without submitted contact data', () => {
  const app = marketing();
  const valid = { requestMode: 'callback', responseOk: true, ok: true, state: 'ready', reference: 'HEPA-000123', submissionToken: uuid };
  assert.equal(app.window.HEPAMarketing.recordQuoteSubmission(valid), false);
  app.choose('granted');
  for (const invalid of [
    { responseOk: false }, { ok: false }, { state: 'ingesting' }, { reference: 'HEPA-LSZ-000123' },
    { reference: '' }, { submissionToken: 'not-uuid' }, { requestMode: 'click' },
  ]) assert.equal(app.window.HEPAMarketing.recordQuoteSubmission({ ...valid, ...invalid }), false);
  assert.equal(app.window.HEPAMarketing.recordQuoteSubmission(valid), true);
  app.scripts[0].onload();
  assert.equal(app.conversions().length, 1);
  assert.equal(app.window.HEPAMarketing.recordQuoteSubmission(valid), false);
  assert.deepEqual(Object.keys(app.conversions()[0][2]).sort(), ['send_to', 'transaction_id']);
  assert.equal(app.conversions()[0][2].send_to, 'AW-10787294242/igZYCNT_nIkdEKKY5Jco');
  assert.equal(app.conversions()[0][2].transaction_id, uuid);
});

async function submit(payload, responseOk = true) {
  const controls = {}, measured = [], attachment = { type: 'image/jpeg', size: 1000, name: 'konyha.jpg' };
  const form = element();
  form.action = 'https://example.test/submit'; form.elements = [];
  form.querySelectorAll = () => [];
  form.querySelector('[name="attachments"]').files = [attachment];
  form.reportValidity = () => true;
  form.reset = () => { form.didReset = true; };
  const document = { getElementById(id) { return id === 'quoteForm' ? form : controls[id] ||= element(); } };
  controls.callback_location = element(); controls.callback_location.value = 'Gödöllő';
  controls.phone = element(); controls.phone.value = '+36 70 627 36 99';
  const window = {
    location: { search: '?tipus=konyha' }, matchMedia: () => ({ matches: true }),
    HEPAPhotoUploads: { isHeic: () => false, prepare: async file => file },
    HEPAMarketing: { appendAttribution() {}, recordQuoteSubmission(data) { measured.push(data); } }, dispatchEvent() {},
  };
  let request;
  class FakeFormData extends Map {
    constructor() {
      super([
        ['submission_token', uuid], ['customer_name', 'Teszt'], ['phone', '+36 70 627 36 99'],
        ['email', 'teszt@example.test'], ['project_type', controls.project_type.value],
        ['message', 'Világos frontok'], ['attachments', attachment], ['consent', 'on'],
      ]);
    }
    append(name, value) { this.set(name, value); }
  }
  const from = html.indexOf('        const prefersReducedMotion');
  const until = html.indexOf('        const types =', from);
  assert.ok(from > 0 && until > from);
  vm.runInNewContext(html.slice(from, until), {
    window, document, FormData: FakeFormData, URLSearchParams,
    crypto: { randomUUID: () => uuid }, AbortController, setTimeout, clearTimeout,
    CustomEvent: class {},
    fetch: async (_url, options) => { request = options.body; return { ok: responseOk, json: async () => payload }; },
  });
  await form.listeners.submit({ preventDefault() {} });
  return { request, measured, form, controls, attachment };
}

test('callback payload retains the optional kitchen details and attachment; confirmed save triggers measurement', async () => {
  const result = await submit({ ok: true, state: 'ready', reference: 'HEPA-000123' });
  assert.equal(result.request.get('wants_callback'), 'true');
  assert.equal(result.request.get('wants_quote'), 'false');
  assert.equal(result.request.get('city'), 'Gödöllő');
  assert.equal(result.request.has('callback_location'), false);
  assert.equal(result.request.get('project_type'), 'Konyhabútor');
  assert.equal(result.request.get('email'), 'teszt@example.test');
  assert.equal(result.request.get('message'), 'Település: Gödöllő\n\nVilágos frontok');
  assert.equal(result.request.get('attachments'), result.attachment);
  assert.equal(result.measured.length, 1);
  assert.equal(result.measured[0].reference, 'HEPA-000123');
  assert.equal(result.form.didReset, true);
});

test('backend uncertainty retains the callback and UUID for retry', async () => {
  const result = await submit({ ok: true, state: 'ingesting', reference: 'HEPA-000123' });
  assert.equal(result.measured.length, 0);
  assert.equal(result.form.didReset, undefined);
  assert.equal(result.controls.submission_token.value, uuid);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

// No browser network, real Google tag, real backend or production lead is used.
const source = await readFile(new URL('../marketing-consent.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const cuttingSource = await readFile(new URL('../lapszabaszat.js', import.meta.url), 'utf8');
const cuttingPages = await Promise.all(['lapszabaszat.html', 'lapszabaszat-ajanlatkeres.html']
  .map(path => readFile(new URL('../' + path, import.meta.url), 'utf8')));
const token = '10000000-0000-4000-8000-000000000001';
const secondToken = '10000000-0000-4000-8000-000000000002';
const choiceKey = 'hepa-marketing-consent-v2';
const sentKey = 'hepa-quote-conversions-v1';
const valid = { requestMode: 'quote', responseOk: true, ok: true, state: 'ready', submissionToken: token };

function element() {
  return {
    listeners: {}, nodes: {}, hidden: false, style: {}, value: '', checked: true, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(name, value) { this[name] = value; },
    getAttribute(name) { return this[name]; },
    removeAttribute(name) { delete this[name]; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector(selector) { return this.nodes[selector] ||= element(); },
    matches() { return false; }, focus() { this.focused = true; },
    scrollIntoView() {}, setCustomValidity() {},
  };
}

function storage(initial = {}, blocked = false) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { if (blocked) throw new Error('blocked'); return values.get(key) ?? null; },
    setItem(key, value) { if (blocked) throw new Error('blocked'); values.set(key, value); },
    removeItem(key) { if (blocked) throw new Error('blocked'); values.delete(key); },
  };
}

function harness({ local = {}, session = {}, blocked = false, settingsOnly = false } = {}) {
  const scripts = [];
  const panels = [];
  const cookieWrites = [];
  const settings = element();
  const docNodes = {};
  const document = {
    currentScript: { hasAttribute() { return settingsOnly; } },
    documentElement: element(),
    createElement() { return element(); },
    head: { appendChild(tag) { scripts.push(tag); } },
    body: { appendChild(panel) { panels.push(panel); } },
    querySelectorAll() { return [settings]; },
    getElementById(id) { return docNodes[id] ||= element(); },
    get cookie() { return '_gcl_aw=example; essential=keep'; },
    set cookie(value) { cookieWrites.push(value); },
  };
  const listeners = {};
  const window = {
    localStorage: storage(local, blocked), sessionStorage: storage(session, blocked),
    location: { hostname: 'hepabutor.hu', search: '' },
    addEventListener(name, callback) { listeners[name] = callback; },
    matchMedia() { return { matches: true }; }, dispatchEvent() {},
  };
  vm.runInNewContext(source, { window, document, console });
  return {
    window, document, docNodes, scripts, panels, cookieWrites, settings, listeners,
    choose(choice) { panels[0].querySelector(`[data-consent-${choice === 'granted' ? 'accept' : 'reject'}]`).listeners.click(); },
    loaded() { scripts[0].onload(); },
    commands() { return (window.dataLayer || []).map(args => Array.from(args)); },
    conversions() { return this.commands().filter(args => args[0] === 'event' && args[1] === 'conversion'); },
    record(data = valid) { return window.HEPAMarketing.recordQuoteSubmission(data); },
  };
}

test('fresh visitor and rejection cause no Google script, commands or retrospective conversions', () => {
  const app = harness();
  assert.equal(app.panels[0].hidden, false);
  assert.equal(app.record(), false);
  assert.equal(app.scripts.length, 0);
  assert.equal(app.window.dataLayer, undefined);
  app.choose('denied');
  assert.equal(app.record(), false);
  assert.equal(app.scripts.length, 0);
  app.choose('granted');
  app.loaded();
  assert.equal(app.conversions().length, 0);
});

test('affirmative consent loads exactly one tag with personalization and analytics disabled', () => {
  const app = harness();
  app.choose('granted');
  app.choose('granted');
  assert.equal(app.scripts.length, 1);
  assert.equal(app.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=AW-10787294242');
  const commands = app.commands();
  assert.equal(commands[0][0], 'consent');
  assert.equal(commands[0][1], 'default');
  assert.equal(commands[0][2].ad_storage, 'denied');
  assert.equal(commands[1][2].ad_storage, 'granted');
  assert.equal(commands[1][2].ad_personalization, 'denied');
  assert.equal(commands[1][2].analytics_storage, 'denied');
  const config = commands.find(args => args[0] === 'config')[2];
  assert.equal(config.send_page_view, false);
  assert.equal(config.allow_enhanced_conversions, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(app.conversions().length, 0);
});

test('only confirmed quotes are emitted once per UUID; no PII or fabricated money is sent', () => {
  const app = harness();
  app.choose('granted');
  for (const change of [
    { requestMode: 'callback' }, { requestMode: 'click' }, { responseOk: false },
    { ok: false }, { state: 'ingesting' }, { submissionToken: '' },
    { submissionToken: 'test@example.test' }, { submissionToken: 'HEPA-000123' },
  ]) assert.equal(app.record({ ...valid, ...change }), false);
  assert.equal(app.record(), true);
  assert.equal(app.record(), false);
  assert.equal(app.conversions().length, 0, 'conversion waits for the consented tag');
  app.loaded();
  assert.equal(app.record(), false);
  assert.equal(app.conversions().length, 1);
  const payload = app.conversions()[0][2];
  assert.deepEqual(Object.keys(payload).sort(), ['send_to', 'transaction_id']);
  assert.equal(payload.send_to, 'AW-10787294242/s7xoCNDcyPQcEKKY5Jco');
  assert.equal(payload.transaction_id, token);
  assert.equal(app.record({ ...valid, submissionToken: secondToken }), true);
  assert.equal(app.conversions().length, 2);
});

test('queued furniture callbacks use their own conversion action while quotes keep the existing action', () => {
  const app = harness();
  app.choose('granted');
  const callback = { ...valid, requestMode: 'callback', reference: 'HEPA-000123', submissionToken: secondToken };
  assert.equal(app.record(callback), true);
  assert.equal(app.record(valid), true);
  assert.equal(app.record(callback), false, 'pending callback is counted once');
  assert.equal(app.conversions().length, 0);
  app.loaded();
  assert.deepEqual(Array.from(app.conversions(), command => command[2].send_to), [
    'AW-10787294242/igZYCNT_nIkdEKKY5Jco',
    'AW-10787294242/s7xoCNDcyPQcEKKY5Jco',
  ]);
  assert.equal(app.record(callback), false, 'sent callback is counted once');
  assert.deepEqual(Array.from(app.conversions(), command => command[2].transaction_id), [secondToken, token]);
});

test('return visit respects consent expiry and session deduplication', () => {
  const savedChoice = JSON.stringify({ version: 2, choice: 'granted', expiresAt: Date.now() + 60_000 });
  const app = harness({ local: { [choiceKey]: savedChoice }, session: { [sentKey]: JSON.stringify([token]) } });
  assert.equal(app.panels[0].hidden, true);
  app.loaded();
  assert.equal(app.record(), false);
  assert.equal(app.conversions().length, 0);
  for (const saved of [
    { version: 2, choice: 'denied', expiresAt: Date.now() + 60_000 },
    { version: 2, choice: 'granted', expiresAt: Date.now() - 1 },
    { version: 0, choice: 'granted', expiresAt: Date.now() + 60_000 },
  ]) assert.equal(harness({ local: { [choiceKey]: JSON.stringify(saved) } }).scripts.length, 0);
});

test('withdrawal drops pending events and cookies without removing essential cookies', () => {
  const app = harness();
  app.choose('granted');
  app.record();
  app.settings.listeners.click();
  assert.equal(app.panels[0].hidden, false);
  app.choose('denied');
  app.loaded();
  assert.equal(app.record({ ...valid, submissionToken: secondToken }), false);
  assert.equal(app.conversions().length, 0);
  assert.ok(app.cookieWrites.some(value => value.startsWith('_gcl_aw=; Max-Age=0')));
  assert.ok(app.cookieWrites.every(value => !value.startsWith('essential=')));
  assert.equal(app.commands().at(-1)[2].ad_storage, 'denied');
  assert.equal(app.window.sessionStorage.getItem(sentKey), null);
  assert.equal(app.settings.focused, true);
});

test('consent withdrawal in another tab stops conversions here', () => {
  const app = harness();
  app.choose('granted');
  app.loaded();
  app.window.localStorage.setItem(choiceKey, JSON.stringify({ version: 2, choice: 'denied', expiresAt: Date.now() + 60_000 }));
  app.listeners.storage({ key: choiceKey });
  assert.equal(app.record(), false);
  assert.equal(app.conversions().length, 0);
});

test('blocked browser storage is safe by default and does not break explicit consent', () => {
  const app = harness({ blocked: true });
  assert.equal(app.scripts.length, 0);
  app.choose('granted');
  app.loaded();
  assert.equal(app.record(), true);
  assert.equal(app.record(), false);
  app.choose('denied');
  assert.equal(app.record({ ...valid, submissionToken: secondToken }), false);
});

test('privacy settings page can change consent without loading advertising measurement', () => {
  const app = harness({ settingsOnly: true });
  app.choose('granted');
  assert.equal(app.scripts.length, 0);
  assert.equal(app.record(), false);
  assert.equal(JSON.parse(app.window.localStorage.getItem(choiceKey)).choice, 'granted');
  app.choose('denied');
  assert.equal(JSON.parse(app.window.localStorage.getItem(choiceKey)).choice, 'denied');
});

test('restoring consent does not resend a quote already emitted on this page', () => {
  const app = harness();
  app.choose('granted');
  app.loaded();
  app.record();
  app.choose('denied');
  app.choose('granted');
  assert.equal(app.record(), false);
  assert.equal(app.conversions().length, 1);
});

async function submitForm({ payload, responseOk = true, networkFailure = false, mode = 'callback', measurementThrows = false } = {}) {
  const app = harness();
  const form = app.document.getElementById('quoteForm');
  const measured = [];
  form.elements = [];
  form.querySelectorAll = () => [];
  form.reportValidity = () => true;
  form.reset = () => { form.wasReset = true; };
  form.querySelector('[name="request_mode"]:checked').value = mode;
  form.querySelector('[name="attachments"]').files = [];
  app.document.getElementById('phone').value = '+36701234567';
  app.document.getElementById('project_location').value = 'Aszód';
  app.document.getElementById('callback_location').value = 'Aszód';
  app.window.HEPAMarketing = { recordQuoteSubmission(data) { measured.push(data); if (measurementThrows) throw new Error('tag unavailable'); } };
  class TestFormData extends Map {
    constructor() { super([['message', 'Konyhabútor'], ['submission_token', token]]); }
  }
  const formScript = html.slice(html.indexOf('        const prefersReducedMotion'), html.indexOf('        const types ='));
  vm.runInNewContext(formScript, {
    window: app.window, document: app.document, FormData: TestFormData,
    crypto: { randomUUID: () => token }, URLSearchParams, AbortController, setTimeout, clearTimeout,
    CustomEvent: class {},
    fetch: async () => { if (networkFailure) throw new Error('network'); return { ok: responseOk, json: async () => payload }; },
  });
  await form.listeners.submit({ preventDefault() {} });
  return { measured, form, message: app.document.getElementById('success-message').textContent };
}

test('real form handler only calls measurement after fully confirmed backend save', async () => {
  for (const options of [
    { networkFailure: true }, { responseOk: false, payload: { ok: true, state: 'ready', reference: 'HEPA-000123' } },
    { payload: { ok: false } }, { payload: { ok: true, state: 'ingesting', reference: 'HEPA-000123' } },
    { payload: { ok: true, state: 'ready' } },
  ]) {
    const result = await submitForm(options);
    assert.equal(result.measured.length, 0);
    assert.equal(result.form.wasReset, undefined);
  }
  const result = await submitForm({ payload: { ok: true, state: 'ready', reference: 'HEPA-000123' } });
  assert.equal(result.measured.length, 1);
  assert.equal(result.measured[0].submissionToken, token);
  assert.equal(result.measured[0].requestMode, 'callback');
  assert.equal(result.form.wasReset, true);
});

test('measurement failure cannot turn a successful saved quote into an error', async () => {
  const result = await submitForm({ payload: { ok: true, state: 'ready', reference: 'HEPA-000123' }, measurementThrows: true });
  assert.equal(result.form.wasReset, true);
  assert.match(result.message, /Visszahívási kérését megkaptuk/);
});

test('both cutting pages offer consent and withdrawal; the form initializes measurement first', () => {
  for (const page of cuttingPages) {
    assert.match(page, /<link rel="stylesheet" href="\/marketing-consent\.css">/);
    assert.match(page, /<script defer src="\/marketing-consent\.js"><\/script>/);
    assert.match(page, /<button type="button" data-marketing-settings>/);
  }
  assert.ok(cuttingPages[1].indexOf('/marketing-consent.js') < cuttingPages[1].indexOf('src="lapszabaszat.js"'));
});

const validCutting = { responseOk: true, ok: true, reference: 'HEPA-LSZ-000123', submissionToken: token };

test('cutting measurement requires a confirmed reference and UUID and shares quote deduplication', () => {
  const app = harness();
  app.choose('granted');
  const record = data => app.window.HEPAMarketing.recordCuttingQuoteSubmission(data);
  for (const change of [
    { responseOk: false }, { ok: false }, { reference: '' }, { reference: undefined },
    { reference: 'customer@example.test' }, { reference: 'HEPA-000123' },
    { submissionToken: 'customer@example.test' }, { submissionToken: '' },
  ]) assert.equal(record({ ...validCutting, ...change }), false);
  assert.equal(record(validCutting), true);
  assert.equal(record(validCutting), false, 'pending event deduplicates');
  assert.equal(app.conversions().length, 0);
  app.loaded();
  assert.equal(record(validCutting), false, 'sent event deduplicates');
  assert.equal(app.record(), false, 'same UUID cannot be counted through the other form API');
  assert.equal(app.conversions().length, 1);
  const payload = app.conversions()[0][2];
  assert.deepEqual(Object.keys(payload).sort(), ['send_to', 'transaction_id']);
  assert.equal(payload.send_to, 'AW-10787294242/s7xoCNDcyPQcEKKY5Jco');
  assert.equal(payload.transaction_id, token);
  const returning = harness({
    local: { [choiceKey]: app.window.localStorage.getItem(choiceKey) },
    session: { [sentKey]: app.window.sessionStorage.getItem(sentKey) },
  });
  returning.loaded();
  assert.equal(returning.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting), false);
  assert.equal(returning.conversions().length, 0);
});

test('cutting submissions without consent are not queued or replayed after later consent', () => {
  const app = harness();
  assert.equal(app.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting), false);
  app.choose('denied');
  assert.equal(app.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting), false);
  assert.equal(app.scripts.length, 0);
  app.choose('granted');
  app.loaded();
  assert.equal(app.conversions().length, 0);
  const settingsOnly = harness({ settingsOnly: true });
  settingsOnly.choose('granted');
  assert.equal(settingsOnly.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting), false);
  assert.equal(settingsOnly.scripts.length, 0);
});

test('withdrawal before the tag loads discards a pending cutting conversion', () => {
  const app = harness();
  app.choose('granted');
  app.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting);
  app.choose('denied');
  app.loaded();
  assert.equal(app.conversions().length, 0);
  assert.equal(app.window.HEPAMarketing.recordCuttingQuoteSubmission(validCutting), false);
});

async function submitCuttingForm({
  payload = { ok: true, reference: 'HEPA-LSZ-000123' }, responseOk = true, status = 201,
  networkFailure = false, invalidJson = false, consent = 'granted', flow = 'manual',
  measurementThrows = false, measurementMissing = false,
} = {}) {
  const app = harness();
  if (consent) app.choose(consent);
  if (consent === 'granted') app.loaded();
  if (measurementThrows) app.window.HEPAMarketing = { recordCuttingQuoteSubmission() { throw new Error('tag unavailable'); } };
  if (measurementMissing) app.window.HEPAMarketing = undefined;
  const form = element();
  const successes = [];
  const feedback = [];
  const submittedTokens = [];
  const context = {
    form, activeFlow: flow, isSubmitting: false, FLOW_STEPS: { [flow]: ['contact', 'review'] }, stepIndex: 1,
    validateStep: () => [], clearTimeout() {}, saveTimer: null, saveDraft() {},
    buildSubmissionPayload: value => value, collectSubmissionFields: () => ({ customer_email: 'private@example.test' }),
    readMaterials: () => [], readItems: () => [], files: { upload: [], help: [] },
    submissionToken: token, createSubmissionToken: () => secondToken, fieldValue: () => '',
    buildMultipartBody(payload, submittedToken) { submittedTokens.push(submittedToken); return payload; },
    document: { querySelector: () => ({ innerHTML: '<p>private@example.test</p>' }) },
    setSubmitFeedback(message, kind) { feedback.push({ message, kind }); },
    setSubmitting(value) { context.isSubmitting = value; },
    submitFeedback: element(), SUBMIT_ENDPOINT: 'https://backend.example.test/quote',
    fetch: async () => {
      if (networkFailure) throw new Error('network');
      return { ok: responseOk, status, headers: { get: () => null }, json: async () => {
        if (invalidJson) throw new Error('invalid json');
        return payload;
      } };
    },
    cleanText: value => String(value ?? '').trim(),
    submissionErrorMessage: () => 'Backend save not confirmed',
    showSuccessfulSubmission(reference) { successes.push(reference); context.submissionToken = secondToken; },
    window: app.window,
  };
  const readJson = cuttingSource.slice(cuttingSource.indexOf('  async function readJsonResponse('), cuttingSource.indexOf('  function setSubmitting('));
  const handler = cuttingSource.slice(cuttingSource.indexOf("  form.addEventListener('submit'"), cuttingSource.indexOf("  document.querySelector('#print-summary')"));
  assert.ok(readJson.length > 0 && handler.length > 0);
  vm.runInNewContext(readJson + handler, context);
  await form.listeners.submit({ preventDefault() {} });
  return { app, context, form, successes, feedback, submittedTokens };
}

test('real cutting handler measures confirmed manual, upload and help inquiries using the submitted UUID', async () => {
  for (const flow of ['manual', 'upload', 'help']) {
    const result = await submitCuttingForm({ flow });
    assert.deepEqual(result.successes, ['HEPA-LSZ-000123']);
    assert.equal(result.app.conversions().length, 1);
    assert.equal(result.app.conversions()[0][2].transaction_id, token);
    assert.equal(result.context.submissionToken, secondToken, 'success UI has already reset the next submission token');
    assert.deepEqual(result.submittedTokens, [token]);
    assert.equal(JSON.stringify(result.app.conversions()).includes('private@example.test'), false);
    result.context.submissionToken = token;
    await result.form.listeners.submit({ preventDefault() {} });
    assert.equal(result.app.conversions().length, 1, 'repeated confirmed response cannot duplicate the event');
  }
});

test('real cutting handler does not measure unconfirmed saves, honeypot replies, invalid JSON or network errors', async () => {
  for (const options of [
    { networkFailure: true }, { invalidJson: true },
    { responseOk: false, status: 503 }, { responseOk: false, status: 409, payload: { code: 'submission-token-conflict' } },
    { payload: { ok: false, reference: 'HEPA-LSZ-000123' } },
    { payload: { ok: true } }, { payload: null },
  ]) {
    const result = await submitCuttingForm(options);
    assert.equal(result.app.conversions().length, 0);
    assert.equal(result.successes.length, 0);
    assert.ok(result.feedback.some(item => item.kind === 'error'));
  }
});

test('confirmed cutting inquiry succeeds without consent or an available measuring module', async () => {
  for (const options of [
    { consent: null }, { consent: 'denied' }, { measurementThrows: true }, { measurementMissing: true },
  ]) {
    const result = await submitCuttingForm(options);
    assert.deepEqual(result.successes, ['HEPA-LSZ-000123']);
    assert.equal(result.app.conversions().length, 0);
    assert.equal(result.feedback.some(item => item.kind === 'error'), false);
    if (!options.consent && !options.measurementThrows && !options.measurementMissing) assert.equal(result.app.scripts.length, 0);
  }
});

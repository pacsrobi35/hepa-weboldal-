import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../photo-uploads.js', import.meta.url), 'utf8');
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
// Minimal HEIF container header: the fake decoder tests our integration boundary,
// not the third-party codec's ability to decode a complete photograph.
const heicBytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

function app({ decoder = async () => new Blob([jpegBytes], { type: 'image/jpeg' }), failLoad = false } = {}) {
  const scripts = [], calls = [];
  const window = {};
  const document = {
    createElement(tag) {
      assert.equal(tag, 'script', 'Fallback path must not need a canvas');
      return { addEventListener(name, callback) { this[`on${name}`] = callback; }, setAttribute() {}, remove() {} };
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        queueMicrotask(() => {
          if (failLoad) return script.onerror?.(new Error('Network error'));
          window.HeicTo = async (options) => {
            calls.push(options);
            return decoder(options);
          };
          script.onload?.();
        });
      }
    }
  };
  vm.runInNewContext(source, { window, document, Blob, File, Uint8Array, Promise, Error, WeakMap, setTimeout, clearTimeout });
  return { api: window.HEPAPhotoUploads, scripts, calls };
}

test('HEIC and HEIF detection accepts case-insensitive extensions and MIME parameters', async () => {
  const { api } = app();
  for (const file of [
    new File([heicBytes], 'fotó.HEIC', { type: '' }),
    new File([heicBytes], 'fotó.HeIf', { type: 'application/octet-stream' }),
    new File([heicBytes], 'fotó', { type: 'image/HEIC; charset=binary' }),
    new File([heicBytes], 'fotó.bin', { type: 'IMAGE/HEIF' }),
  ]) assert.equal(await api.isHeic(file), true, file.name + ' / ' + file.type);
  assert.equal(await api.isHeic(new File([jpegBytes], 'fotó.jpg', { type: 'image/jpeg' })), false);
  assert.equal(await api.isHeic(new File(['%PDF-1.7'], 'rajz.pdf', { type: 'application/pdf' })), false);
});

test('existing JPEG, PNG, PDF and spreadsheet files retain identity without loading the decoder', async () => {
  const { api, scripts, calls } = app();
  for (const file of [
    new File([jpegBytes], 'helyszín.jpg', { type: 'image/jpeg' }),
    new File(['unchanged png'], 'helyszín.png', { type: 'image/png' }),
    new File(['%PDF-1.7'], 'terv.pdf', { type: 'application/pdf' }),
    new File(['spreadsheet'], 'szabáslista.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
  ]) assert.equal(await api.prepare(file, { maxBytes: 1000 }), file);
  assert.equal(scripts.length, 0);
  assert.equal(calls.length, 0);
});

test('JPEG content with a HEIC filename is normalized without invoking the codec', async () => {
  const { api, scripts, calls } = app();
  const original = new File([jpegBytes], 'iphone.fotó.HEIC', { type: 'image/heic', lastModified: 1234 });
  const result = await api.prepare(original, { maxBytes: 1000 });
  assert.equal(result.name, 'iphone.fotó.jpg');
  assert.equal(result.type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), jpegBytes);
  assert.equal(result.lastModified, original.lastModified);
  assert.equal(scripts.length, 0);
  assert.equal(calls.length, 0);
});

test('HEIC conversion gives server-compatible MIME, filename and JPEG bytes using one lazy decoder load', async () => {
  const { api, scripts, calls } = app();
  const first = new File([heicBytes], 'konyha.HEIC', { type: 'image/heic', lastModified: 5678 });
  const second = new File([heicBytes], 'vázlat.heif', { type: 'image/heif' });
  const results = [await api.prepare(first, { maxBytes: 1000 }), await api.prepare(second, { maxBytes: 1000 })];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0].src, /\/vendor\/heic-to-1\.6\.5\.js$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].blob, first);
  assert.equal(calls[0].type, 'image/jpeg');
  assert.equal(calls[0].quality, 0.9);
  for (const [index, result] of results.entries()) {
    assert.match(result.name, /\.jpg$/);
    assert.equal(result.type, 'image/jpeg');
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), jpegBytes);
    if (index === 0) assert.equal(result.lastModified, first.lastModified);
  }
});

test('both original and converted files remain subject to the caller size limit', async () => {
  const small = app();
  const tooLarge = new File([new Uint8Array(50)], 'nagy.heic', { type: 'image/heic' });
  await assert.rejects(small.api.prepare(tooLarge, { maxBytes: 20 }));
  assert.equal(small.calls.length, 0);
  const largeResult = app({ decoder: async () => new Blob([jpegBytes, new Uint8Array(100)], { type: 'image/jpeg' }) });
  await assert.rejects(largeResult.api.prepare(new File([heicBytes], 'nagy.heif', { type: 'image/heif' }), { maxBytes: 30 }));
  assert.equal(largeResult.calls.length, 1);
});

test('decoder failure includes the customer filename and never returns the unsupported original', async () => {
  const { api } = app({ decoder: async () => { throw new Error('Codec detail'); } });
  await assert.rejects(api.prepare(new File([heicBytes], 'sérült.heic', { type: 'image/heic' }), { maxBytes: 1000 }), /sérült\.heic/);
});

test('failed lazy load yields an actionable filename error', async () => {
  const { api } = app({ failLoad: true });
  await assert.rejects(api.prepare(new File([heicBytes], 'telefon.heif', { type: 'image/heif' }), { maxBytes: 1000 }), /telefon\.heif/);
});

test('unexpected non-JPEG codec output cannot be relabelled and sent as a JPEG', async () => {
  const { api } = app({ decoder: async () => new Blob(['not a jpeg'], { type: 'image/png' }) });
  await assert.rejects(api.prepare(new File([heicBytes], 'telefon.heic', { type: 'image/heic' }), { maxBytes: 1000 }), /telefon\.heic/);
});

function element() {
  return {
    listeners: {}, style: {}, value: '', files: [], disabled: false,
    classList: { toggle() {}, remove() {} },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    setAttribute(name, value) { this[name] = value; },
    removeAttribute(name) { delete this[name]; },
    getAttribute(name) { return this[name]; },
    matches() { return this.disabled; }, setCustomValidity() {}, scrollIntoView() {}, focus() {}
  };
}

function callbackApp(attachments, prepare) {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const first = html.indexOf('        const prefersReducedMotion');
  const last = html.indexOf('        const types =', first);
  assert.ok(first > 0 && last > first);
  const controls = {}, requests = [], prepared = [];
  const fileInput = element();
  fileInput.files = attachments;
  const form = element();
  form.action = 'https://example.test/submit';
  form.elements = [fileInput];
  form.querySelector = () => fileInput;
  form.querySelectorAll = () => [];
  form.reportValidity = () => true;
  form.reset = () => { form.didReset = true; };
  const document = { getElementById(id) { return id === 'quoteForm' ? form : controls[id] ||= element(); } };
  controls.callback_location = element(); controls.callback_location.value = 'Aszód';
  controls.phone = element(); controls.phone.value = '+36 70 123 4567';
  class FakeFormData {
    constructor() { this.entries = [['message', 'Terv'], ['submission_token', '10000000-0000-4000-8000-000000000001'], ...attachments.map(file => ['attachments', file])]; }
    get(name) { return this.entries.find(entry => entry[0] === name)?.[1] ?? null; }
    getAll(name) { return this.entries.filter(entry => entry[0] === name).map(entry => entry[1]); }
    delete(name) { this.entries = this.entries.filter(entry => entry[0] !== name); }
    set(name, value) { this.delete(name); this.append(name, value); }
    append(name, value) { this.entries.push([name, value]); }
  }
  const window = {
    location: { search: '' }, matchMedia: () => ({ matches: true }), dispatchEvent() {},
    HEPAPhotoUploads: {
      isHeic: file => /\.(heic|heif)$/i.test(file.name),
      async prepare(file, options) { prepared.push({ file, options }); return prepare(file, options); }
    }
  };
  vm.runInNewContext(html.slice(first, last), {
    window, document, FormData: FakeFormData, URLSearchParams, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID: () => '10000000-0000-4000-8000-000000000001' }, CustomEvent: class {},
    fetch: async (_url, options) => {
      requests.push(options.body);
      return { ok: true, json: async () => ({ ok: true, state: 'ready', reference: 'HEPA-000123' }) };
    }
  });
  return { form, fileInput, controls, requests, prepared, submit: () => form.listeners.submit({ preventDefault() {} }) };
}

test('callback submits processed photos once and preserves other attachments while conversion is pending', async () => {
  const heic = new File([heicBytes], 'helyszín.heic', { type: 'image/heic' });
  const pdf = new File(['%PDF-1.7'], 'terv.pdf', { type: 'application/pdf' });
  const jpeg = new File([jpegBytes], 'helyszín.jpg', { type: 'image/jpeg' });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = callbackApp([heic, pdf], file => file === heic ? pending : file);
  const firstSubmit = app.submit();
  assert.equal(app.form.getAttribute('aria-busy'), 'true');
  assert.equal(app.fileInput.disabled, true);
  assert.equal(app.requests.length, 0);
  await app.submit();
  assert.equal(app.prepared.length, 1, 'Second submit must not restart the conversion');
  finish(jpeg);
  await firstSubmit;
  assert.equal(app.requests.length, 1);
  assert.deepEqual(app.requests[0].getAll('attachments'), [jpeg, pdf]);
  assert.equal(app.prepared[0].options.maxBytes, 10 * 1024 * 1024);
  assert.equal(app.form.didReset, true);
  assert.equal(app.fileInput.disabled, false);
});

test('callback conversion failure retains all original attachments and sends no partial request', async () => {
  const heic = new File([heicBytes], 'sérült.heic', { type: 'image/heic' });
  const pdf = new File(['%PDF-1.7'], 'terv.pdf', { type: 'application/pdf' });
  const app = callbackApp([pdf, heic], async file => {
    if (file === heic) throw new Error('sérült.heic: nem olvasható');
    return file;
  });
  await app.submit();
  assert.equal(app.requests.length, 0);
  assert.equal(app.form.didReset, undefined);
  assert.deepEqual(app.fileInput.files, [pdf, heic]);
  assert.match(app.controls['success-message'].textContent, /sérült\.heic/);
  assert.equal(app.fileInput.disabled, false);
});

function cuttingApp(prepare) {
  const source = readFileSync(new URL('../lapszabaszat.js', import.meta.url), 'utf8');
  function section(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing application code: ${start}`);
    return source.slice(first, last);
  }
  const nodes = {}, requests = [], prepared = [];
  const form = element(), nextButton = element(), submitButton = element(), backButton = element();
  nextButton.click = () => nextButton.listeners.click();
  const inputs = ['upload', 'help'].map(flow => ({ ...element(), dataset: { fileInput: flow } }));
  const document = {
    querySelector(selector) {
      const node = nodes[selector] ||= element();
      node.querySelector = () => element();
      node.offsetTop = 100;
      node.focus = () => {};
      return node;
    },
    querySelectorAll(selector) { return selector === '[data-file-input]' ? inputs : []; }
  };
  const window = {
    scrollTo() {},
    HEPAPhotoUploads: {
      isHeic: file => /\.(heic|heif)$/i.test(file.name),
      async prepare(file, options) { prepared.push({ file, options }); return prepare(file, options); }
    }
  };
  vm.runInNewContext(`
    ${section('  const MAX_FILES =', '  const STEP_NAMES =')}
    const STEP_NAMES = { details: 'Tartalom', logistics: 'Átvétel', contact: 'Kapcsolat', review: 'Ellenőrzés' };
    const SUBMIT_ENDPOINT = 'https://example.test/submit';
    let activeFlow = 'upload', stepIndex = 0, saveTimer = null;
    ${section('  let files =', '  const menuButton =')}
    ${section('  function fileExtension(', "  document.querySelectorAll('[data-file-input]')")}
    ${section('  function updateStep()', '  function startFlow(')}
    ${section("  nextButton.addEventListener('click'", "  document.querySelectorAll('input[name=\"fulfillment\"]')")}
    ${section('  function setSubmitting(', '  function showSuccessfulSubmission(')}
    ${section("  form.addEventListener('submit'", "  document.querySelector('#print-summary')")}
    window.test = {
      addFiles, photosProcessing, updateStep,
      setStep(index) { stepIndex = index; updateStep(); },
      getStep() { return stepIndex; },
      files() { return files.upload; },
      submit() { return form.listeners.submit({ preventDefault() {} }); },
      next() { return nextButton.listeners.click(); }
    };
  `, {
    window, document, form, nextButton, submitButton, backButton,
    stepLabel: element(), progressBar: element(), submitFeedback: element(),
    createSubmissionToken: () => '10000000-0000-4000-8000-000000000001',
    escapeHtml: String, formatBytes: String, queueSave() {}, clearErrors() {}, buildReview() {},
    requestAnimationFrame: callback => callback(), validateStep: () => [], saveDraft() {},
    buildSubmissionPayload: value => value, collectSubmissionFields: () => ({}), fieldValue: () => '',
    buildMultipartBody: (_payload, _token, _honeypot, attachments) => attachments,
    setSubmitFeedback() {}, readJsonResponse: response => response.json(), cleanText: String,
    showSuccessfulSubmission() {}, setTimeout, clearTimeout,
    fetch: async (_url, options) => {
      requests.push(Array.from(options.body));
      return { ok: true, json: async () => ({ ok: true, reference: 'HEPA-LSZ-000123' }) };
    }
  });
  return { api: window.test, form, nextButton, submitButton, inputs, nodes, prepared, requests };
}

test('cutting queues additions, snapshots the selection and blocks navigation and submit until JPEG preparation ends', async () => {
  const heic = new File([heicBytes], 'szabáslista.heic', { type: 'image/heic' });
  const jpeg = new File([jpegBytes], 'szabáslista.jpg', { type: 'image/jpeg' });
  const pdf = new File(['%PDF-1.7'], 'kiegészítés.pdf', { type: 'application/pdf' });
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const app = cuttingApp(file => file === heic ? pending : file);
  const incoming = [heic];
  const first = app.api.addFiles('upload', incoming);
  incoming.length = 0;
  const second = app.api.addFiles('upload', [pdf]);
  await Promise.resolve();
  assert.equal(app.api.photosProcessing(), true);
  assert.equal(app.inputs[0].disabled, true);
  assert.equal(app.nextButton.disabled, true);
  app.api.next();
  assert.equal(app.api.getStep(), 0);
  app.api.setStep(3);
  assert.equal(app.submitButton.disabled, true, 'A step refresh must keep the submit lock');
  await app.api.submit();
  assert.equal(app.requests.length, 0);
  assert.equal(app.prepared.length, 1, 'Second selection must wait for the first conversion');
  finish(jpeg);
  await Promise.all([first, second]);
  assert.deepEqual(Array.from(app.api.files()), [jpeg, pdf]);
  assert.equal(app.prepared[0].options.maxBytes, 6 * 1024 * 1024);
  assert.equal(app.api.photosProcessing(), false);
  assert.equal(app.inputs[0].disabled, false);
  assert.equal(app.submitButton.disabled, false);
  await app.api.submit();
  assert.deepEqual(app.requests, [[jpeg, pdf]]);
});

test('cutting conversion failure preserves accepted files and later additions can recover', async () => {
  const pdf = new File(['%PDF-1.7'], 'terv.pdf', { type: 'application/pdf' });
  const broken = new File([heicBytes], 'sérült.heif', { type: 'image/heif' });
  const jpg = new File([jpegBytes], 'másik.jpg', { type: 'image/jpeg' });
  const app = cuttingApp(async file => {
    if (file === broken) throw new Error('sérült.heif: nem olvasható');
    return file;
  });
  await app.api.addFiles('upload', [pdf]);
  await app.api.addFiles('upload', [broken]);
  assert.deepEqual(Array.from(app.api.files()), [pdf]);
  assert.match(app.nodes['#upload-files-error'].textContent, /sérült\.heif/);
  assert.equal(app.api.photosProcessing(), false);
  await app.api.addFiles('upload', [jpg]);
  assert.deepEqual(Array.from(app.api.files()), [pdf, jpg]);
  assert.equal(app.nodes['#upload-files-error'].textContent, '');
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../lapszabaszat.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, `Missing application code: ${start}`);
  return source.slice(first, last);
}

test('saved cutting drafts and old restored drafts omit contact and consent', () => {
  const controls = [
    { name: 'manual_size_basis', type: 'hidden', value: 'finished' },
    { name: 'upload_size_basis', type: 'hidden', value: 'finished' },
    { name: 'upload_material', type: 'text', value: 'Egger H3303' },
    { name: 'fulfillment', type: 'radio', value: 'delivery', checked: true },
    { name: 'postal_code', type: 'text', value: '2100' },
    { name: 'customer_name', type: 'text', value: 'Próba Ügyfél' },
    { name: 'company_name', type: 'text', value: 'Próba Kft.' },
    { name: 'customer_email', type: 'email', value: 'proba@example.test' },
    { name: 'customer_phone', type: 'tel', value: '+36 30 123 4567' },
    { name: 'preferred_contact', type: 'radio', value: 'email', checked: true },
    { name: 'privacy_consent', type: 'checkbox', value: 'on', checked: true },
    { name: 'company_website', type: 'text', value: 'honeypot' }
  ];
  const control = (name) => controls.find((entry) => entry.name === name);
  const values = new Map();
  const storage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); }
  };
  const materials = [{ id: 'material-1', name: 'Egger H3303', thicknessMm: '18' }];
  const items = [{ id: 'item-1', materialId: 'material-1', lengthMm: 1000, widthMm: 500, quantity: 2 }];
  const restored = { materials: [], edges: [], items: [], flow: null, stepIndex: null };
  const postcode = { required: false, attributes: new Set(), setAttribute(name) { this.attributes.add(name); }, removeAttribute(name) { this.attributes.delete(name); } };
  const context = vm.createContext({
    form: {
      elements: controls,
      reset() {
        controls.forEach((entry) => { entry.checked = false; entry.value = ''; });
      }
    },
    localStorage: storage,
    saveStatus: { textContent: '' },
    materialList: { innerHTML: '' },
    edgeProfileList: { innerHTML: '' },
    itemList: { innerHTML: '' },
    draftBanner: { classList: { remove() {} } },
    document: {
      querySelector(selector) {
        if (selector === '#privacy-consent') return control('privacy_consent');
        if (selector === '#postcode-field') return { hidden: false };
        if (selector === '#postal-code') return postcode;
        throw new Error(`Unexpected selector: ${selector}`);
      }
    },
    readMaterials: () => materials,
    readEdgeProfiles: () => [],
    readItems: () => items,
    newMaterial: (item) => restored.materials.push(item),
    newEdgeProfile: (item) => restored.edges.push(item),
    newItem: (item) => restored.items.push(item),
    renumberEdgeProfiles() {},
    renderFiles() {},
    createSubmissionToken: () => 'generated-token',
    isUuid: () => false,
    migrateDraft: (draft) => draft,
    startFlow(flow, draft) { restored.flow = flow; restored.stepIndex = draft.stepIndex; }
  });
  const program = `
    const DRAFT_KEY = 'hepa_cutting_quote_draft_v5';
    const V4_DRAFT_KEY = 'hepa_cutting_quote_draft_v4';
    const V3_DRAFT_KEY = 'hepa_cutting_quote_draft_v3';
    const V2_DRAFT_KEY = 'hepa_cutting_quote_draft_v2';
    const V1_DRAFT_KEY = 'hepa_cutting_quote_draft_v1';
    const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
    const FLOW_STEPS = { manual: ['items', 'logistics', 'contact', 'review'] };
    let activeFlow = 'manual';
    let stepIndex = 3;
    let submissionToken = 'generated-token';
    let files = { upload: [], help: [] };
    let restoredFilesMeta = { upload: [], help: [] };
    ${section('  const DRAFT_FIELD_NAMES =', '  const SUBMIT_ENDPOINT')}
    ${section('  function fieldValue(', '  function createSubmissionToken(')}
    ${section('  function collectDraft()', '  function queueSave()')}
    ${section('  function isValidDraft(', '  restoredDraft = readDraft();')}
  `;
  vm.runInContext(program, context);
  vm.runInContext('saveDraft()', context);
  const saved = JSON.parse(storage.getItem('hepa_cutting_quote_draft_v5'));
  assert.deepEqual(Object.keys(saved.fields).sort(), ['fulfillment', 'manual_size_basis', 'upload_material', 'upload_size_basis']);
  assert.equal(saved.fields.upload_material, 'Egger H3303');
  assert.deepEqual(saved.items, items);
  assert.deepEqual(saved.materialProfiles, materials);

  const oldDraft = {
    ...saved,
    fields: {
      ...saved.fields,
      postal_code: '2100', customer_name: 'Próba Ügyfél', company_name: 'Próba Kft.',
      customer_email: 'proba@example.test', customer_phone: '+36 30 123 4567',
      preferred_contact: 'email', privacy_consent: true, company_website: 'honeypot'
    }
  };
  storage.setItem('hepa_cutting_quote_draft_v5', JSON.stringify(oldDraft));
  const loaded = vm.runInContext('readDraft()', context);
  assert.deepEqual(Object.keys(loaded.fields).sort(), Object.keys(saved.fields).sort());
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem('hepa_cutting_quote_draft_v5')).fields).sort(), Object.keys(saved.fields).sort());

  // An old draft passed straight to restoration must also leave personal fields empty.
  context.oldDraft = oldDraft;
  vm.runInContext('applyDraft(oldDraft)', context);
  for (const name of ['customer_name', 'company_name', 'customer_email', 'customer_phone', 'postal_code']) {
    assert.equal(control(name).value, '', name);
  }
  assert.equal(control('privacy_consent').checked, false);
  assert.equal(restored.flow, 'manual');
  assert.equal(restored.stepIndex, 1); // Delivery needs a new postcode before contact.
  assert.deepEqual(restored.materials, materials);
  assert.deepEqual(restored.items, items);
});

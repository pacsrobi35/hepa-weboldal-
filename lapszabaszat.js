(() => {
  'use strict';

  const DRAFT_KEY = 'hepa_cutting_quote_draft_v5';
  const V4_DRAFT_KEY = 'hepa_cutting_quote_draft_v4';
  const V3_DRAFT_KEY = 'hepa_cutting_quote_draft_v3';
  const V2_DRAFT_KEY = 'hepa_cutting_quote_draft_v2';
  const V1_DRAFT_KEY = 'hepa_cutting_quote_draft_v1';
  const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const SUBMIT_ENDPOINT = 'https://torczkyodukcvxwzutgf.supabase.co/functions/v1/submit-cutting-quote-request';
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 6 * 1024 * 1024;
  const MAX_TOTAL_FILE_SIZE = 15 * 1024 * 1024;
  const MAX_MATERIALS = 50;
  const MAX_ITEMS = 500;
  const FLOW_STEPS = {
    upload: ['details', 'logistics', 'contact', 'review'],
    manual: ['items', 'logistics', 'contact', 'review'],
    help: ['details', 'contact', 'review']
  };
  const STEP_NAMES = {
    details: 'Az ajánlat tartalma',
    items: 'Tételek',
    logistics: 'Átvétel és időzítés',
    contact: 'Kapcsolattartás',
    review: 'Ellenőrzés'
  };
  const FLOW_NAMES = {
    upload: 'Szabászjegyzék feltöltése',
    manual: 'Tételek kézi megadása',
    help: 'Segítségkérés'
  };
  const MATERIAL_SOURCE_NAMES = {
    hepa: 'A HEPA szerzi be',
    own: 'Saját / hozott anyag',
    unknown: 'Még nem tudom'
  };
  const FULFILLMENT_NAMES = {
    pickup: 'Személyes átvétel Aszódon',
    delivery: 'Szállítást kérek',
    unknown: 'Még nem tudom'
  };
  const HELP_TOPIC_NAMES = {
    material: 'Anyag vagy dekor',
    size: 'Méretek és szabászjegyzék',
    edge: 'ABS élzárás',
    delivery: 'Átvétel vagy szállítás'
  };
  const EDGE_BAND_NAMES = { matching: 'dekorazonos ABS', different: 'eltérő színű ABS', customer: 'hozott élanyag', unknown: 'egyeztetendő' };
  const EDGE_CODES = ['0-0', '0-1', '0-2', '1-0', '1-1', '1-2', '2-0', '2-1', '2-2'];
  const EDGE_CODES_WITH_MATERIAL = EDGE_CODES.filter((code) => code !== '0-0');
  const EDGE_CODE_NAMES = {
    '0-0': 'nincs élzárás',
    '0-1': '1 rövid él',
    '0-2': '2 rövid él',
    '1-0': '1 hosszanti él',
    '1-1': '1 hosszanti + 1 rövid él',
    '1-2': '1 hosszanti + 2 rövid él',
    '2-0': '2 hosszanti él',
    '2-1': '2 hosszanti + 1 rövid él',
    '2-2': 'mind a 4 él'
  };
  const ITEM_FIELD_NAMES = ['materialId', 'name', 'lengthMm', 'widthMm', 'quantity', 'note', 'edgeCode', 'edgeThicknessMm', 'edgeMaterialIdentifier', 'edgeCode2', 'edgeThicknessMm2', 'edgeMaterialIdentifier2'];

  const form = document.querySelector('#cutting-form');
  if (!form) return;

  const flowChoice = document.querySelector('#flow-choice');
  const wizard = document.querySelector('#wizard');
  const successPanel = document.querySelector('#success-panel');
  const stepLabel = document.querySelector('#step-label');
  const progressBar = document.querySelector('#progress-bar');
  const saveStatus = document.querySelector('#save-status');
  const nextButton = document.querySelector('#next-button');
  const backButton = document.querySelector('#back-button');
  const submitButton = document.querySelector('#submit-button');
  const errorSummary = document.querySelector('#error-summary');
  const errorList = document.querySelector('#error-list');
  const materialList = document.querySelector('#material-list');
  const itemList = document.querySelector('#item-list');
  const itemSummary = document.querySelector('#items-summary');
  const itemEmptyState = document.querySelector('#item-empty-state');
  const itemComposer = document.querySelector('#item-composer');
  const itemComposerTitle = document.querySelector('#item-composer-title');
  const itemComposerError = document.querySelector('#item-composer-error');
  const itemComposerStatus = document.querySelector('#item-composer-status');
  const saveItemButton = document.querySelector('#save-item');
  const cancelItemEditButton = document.querySelector('#cancel-item-edit');
  const retainItemSettings = document.querySelector('#retain-item-settings');
  const draftBanner = document.querySelector('#draft-banner');
  const draftTime = document.querySelector('#draft-time');
  const submitFeedback = document.querySelector('#submit-feedback');

  let activeFlow = null;
  let stepIndex = 0;
  let materialCounter = 0;
  let itemCounter = 0;
  let editingItemId = null;
  let composerDirty = false;
  let composerBaseline = '';
  let composerStatusTimer = null;
  let saveTimer = null;
  let restoredDraft = null;
  let files = { upload: [], help: [] };
  let restoredFilesMeta = { upload: [], help: [] };
  let submissionToken = createSubmissionToken();
  let isSubmitting = false;

  const menuButton = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.main-nav');
  menuButton?.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Menü bezárása' : 'Menü megnyitása');
    menuButton.textContent = open ? '×' : '☰';
  });
  function closeMenu() {
    if (!menu?.classList.contains('open')) return;
    menu.classList.remove('open');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-label', 'Menü megnyitása');
    menuButton.textContent = '☰';
  }
  menu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && menu?.classList.contains('open')) {
      closeMenu();
      menuButton.focus();
    }
  });

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function fieldValue(name) {
    const controls = [...form.elements].filter((control) => control.name === name);
    if (!controls.length) return '';
    if (controls[0].type === 'radio') return controls.find((control) => control.checked)?.value || '';
    if (controls[0].type === 'checkbox') return controls.filter((control) => control.checked).map((control) => control.value);
    return controls[0].value.trim();
  }

  function setFieldValue(name, value) {
    const controls = [...form.elements].filter((control) => control.name === name);
    controls.forEach((control) => {
      if (control.type === 'radio') control.checked = control.value === value;
      else if (control.type === 'checkbox') control.checked = Array.isArray(value) ? value.includes(control.value) : Boolean(value);
      else control.value = value ?? '';
    });
  }

  function createSubmissionToken(cryptoProvider = globalThis.crypto) {
    if (typeof cryptoProvider?.randomUUID === 'function') return cryptoProvider.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof cryptoProvider?.getRandomValues === 'function') cryptoProvider.getRandomValues(bytes);
    else bytes.forEach((_, index) => { bytes[index] = Math.floor(Math.random() * 256); });
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function isUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanText(value));
  }

  function fileExtension(fileName) {
    const parts = String(fileName || '').toLowerCase().split('.');
    return parts.length > 1 ? parts.at(-1) : '';
  }

  function allowedFile(file, flow) {
    const uploadExtensions = ['xlsx', 'csv', 'pdf', 'jpg', 'jpeg', 'png'];
    const helpExtensions = ['pdf', 'jpg', 'jpeg', 'png'];
    return (flow === 'upload' ? uploadExtensions : helpExtensions).includes(fileExtension(file?.name));
  }

  function validateFileBatch(existingFiles, incomingFiles, flow) {
    const accepted = [];
    const messages = [];
    let totalSize = existingFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    let countLimitReported = false;

    incomingFiles.forEach((file) => {
      if (!allowedFile(file, flow)) {
        messages.push(`${file.name}: nem támogatott formátum.`);
        return;
      }
      if (!file.size) {
        messages.push(`${file.name}: a fájl üres.`);
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        messages.push(`${file.name}: nagyobb 6 MB-nál.`);
        return;
      }
      if (existingFiles.length + accepted.length >= MAX_FILES) {
        if (!countLimitReported) messages.push(`Legfeljebb ${MAX_FILES} fájl választható.`);
        countLimitReported = true;
        return;
      }
      if (totalSize + file.size > MAX_TOTAL_FILE_SIZE) {
        messages.push(`${file.name}: ezzel a mellékletek összmérete meghaladná a 15 MB-ot.`);
        return;
      }
      accepted.push(file);
      totalSize += file.size;
    });

    return { accepted, messages };
  }

  function validateAttachmentSet(selectedFiles, flow, required = false) {
    const errors = [];
    if (required && !selectedFiles.length) errors.push('Válasszon ki legalább egy szabászjegyzéket.');
    if (selectedFiles.length > MAX_FILES) errors.push(`Legfeljebb ${MAX_FILES} fájl küldhető.`);
    selectedFiles.forEach((file) => {
      if (!allowedFile(file, flow)) errors.push(`${file.name}: nem támogatott formátum.`);
      else if (!file.size) errors.push(`${file.name}: a fájl üres.`);
      else if (file.size > MAX_FILE_SIZE) errors.push(`${file.name}: nagyobb 6 MB-nál.`);
    });
    const totalSize = selectedFiles.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if (totalSize > MAX_TOTAL_FILE_SIZE) errors.push('A mellékletek összmérete nem lehet több 15 MB-nál.');
    return errors;
  }

  function renderFiles(flow, restoredMeta = restoredFilesMeta[flow]) {
    const list = document.querySelector(`#${flow}-file-list`);
    if (!list) return;
    const currentFiles = files[flow];
    if (!currentFiles.length) {
      list.innerHTML = restoredMeta?.length
        ? '<div class="notice"><strong>A fájlokat újra ki kell választani.</strong> A böngésző biztonsági okból nem tudja visszatölteni a korábbi fájlokat.</div>'
        : '';
      return;
    }
    list.innerHTML = currentFiles.map((file, index) => `
      <div class="file-row">
        <div class="file-name">${escapeHtml(file.name)}<span class="file-meta">${formatBytes(file.size)} · kiválasztva</span></div>
        <button class="file-remove" type="button" data-remove-file="${flow}" data-file-index="${index}" aria-label="${escapeHtml(file.name)} eltávolítása">×</button>
      </div>`).join('');
  }

  function addFiles(flow, incoming) {
    const error = document.querySelector(`#${flow}-files-error`);
    if (error) error.textContent = '';
    const { accepted, messages } = validateFileBatch(files[flow], [...incoming], flow);
    if (accepted.length) restoredFilesMeta[flow] = [];
    files[flow].push(...accepted);
    if (error) error.textContent = messages.join(' ');
    renderFiles(flow);
    queueSave();
  }

  document.querySelectorAll('[data-file-input]').forEach((input) => {
    const flow = input.dataset.fileInput;
    input.addEventListener('change', () => {
      addFiles(flow, input.files || []);
      input.value = '';
    });
    const zone = input.closest('.drop-zone');
    ['dragenter', 'dragover'].forEach((eventName) => zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach((eventName) => zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
    }));
    zone.addEventListener('drop', (event) => addFiles(flow, event.dataTransfer?.files || []));
  });

  document.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-remove-file]');
    if (!remove) return;
    const flow = remove.dataset.removeFile;
    files[flow].splice(Number(remove.dataset.fileIndex), 1);
    const error = document.querySelector(`#${flow}-files-error`);
    if (error) error.textContent = '';
    renderFiles(flow);
    queueSave();
  });

  function edgeCodeFromData(data = {}) {
    if (EDGE_CODES.includes(data.edgeCode)) return data.edgeCode;
    if (!data.edges) return '';
    const longEdges = Number(Boolean(data.edges.A)) + Number(Boolean(data.edges.B));
    const shortEdges = Number(Boolean(data.edges.C)) + Number(Boolean(data.edges.D));
    if (longEdges === 0 && shortEdges === 0) return '';
    return `${longEdges}-${shortEdges}`;
  }

  function edgeCodeParts(code) {
    if (!EDGE_CODES.includes(code)) return [0, 0];
    return code.split('-').map(Number);
  }

  function legacyEdgeBandValue(value) {
    return EDGE_BAND_NAMES[value] || value || '';
  }

  function canonicalThickness(value) {
    const raw = String(value ?? '').trim().replace(',', '.');
    const numeric = Number(raw);
    return raw && Number.isFinite(numeric) ? String(numeric) : raw;
  }

  function materialPairKey(name, thicknessMm) {
    const normalizedName = String(name ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('hu-HU');
    return `${normalizedName}\u001f${canonicalThickness(thicknessMm)}`;
  }

  function swapEdgeCode(code) {
    if (!EDGE_CODES.includes(code)) return code;
    const [longEdges, shortEdges] = code.split('-');
    return `${shortEdges}-${longEdges}`;
  }

  function formatDecimal(value) {
    const number = Number(String(value ?? '').replace(',', '.'));
    if (!Number.isFinite(number)) return String(value ?? '').trim();
    return new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 2 }).format(number);
  }

  function edgeAssignmentSummary(code, thicknessMm, identifier) {
    if (!code) return 'Még nincs kitöltve';
    if (code === '0-0') return '0-0 · élzárás nélkül';
    const thickness = thicknessMm ? `${formatDecimal(thicknessMm)} mm` : 'vastagság nélkül';
    return `${code} · ${thickness} · ${String(identifier || 'azonosító nélkül').trim()}`;
  }

  function materialDisplayName(material, index) {
    const name = String(material?.name || '').trim();
    const thickness = String(material?.thicknessMm || '').trim();
    if (!name && !thickness) return `${index + 1}. anyag – még nincs kitöltve`;
    if (!name) return `${index + 1}. anyag – ${thickness} mm`;
    return thickness ? `${name} – ${thickness} mm` : `${name} – vastagság nélkül`;
  }

  function readMaterial(card) {
    const data = { id: card.dataset.materialId };
    card.querySelectorAll('[data-material-field]').forEach((control) => { data[control.dataset.materialField] = control.value.trim(); });
    return data;
  }

  function readMaterials() {
    return [...materialList.querySelectorAll('.material-card')].map(readMaterial);
  }

  function getMaterialProfile(materialId) {
    return readMaterials().find((material) => material.id === materialId) || null;
  }

  function updateMaterialOptions() {
    const materials = readMaterials();
    const select = itemComposer?.querySelector('[data-composer-field="materialId"]');
    if (select) {
      const selectedId = select.value;
      const placeholder = new Option('Válasszon anyagot…', '');
      select.replaceChildren(placeholder);
      materials.forEach((material, index) => select.add(new Option(materialDisplayName(material, index), material.id)));
      if (materials.some((material) => material.id === selectedId)) select.value = selectedId;
      else if (materials.length === 1) select.value = materials[0].id;
    }
    itemList.querySelectorAll('.item-card').forEach(renderItemSummary);
  }

  function updateMaterialUsageState() {
    const cards = [...materialList.querySelectorAll('.material-card')];
    const usedIds = new Set(readItems().filter(isMeaningfulItem).map((item) => item.materialId).filter(Boolean));
    cards.forEach((card, index) => {
      const button = card.querySelector('[data-material-action="delete"]');
      const onlyMaterial = cards.length === 1;
      const inUse = usedIds.has(card.dataset.materialId);
      button.disabled = onlyMaterial || inUse;
      button.title = onlyMaterial
        ? 'Legalább egy anyag szükséges.'
        : inUse
          ? 'Ezt az anyagot használja egy tételsor. Előbb válasszon ott másikat.'
          : `${index + 1}. anyag törlése`;
    });
  }

  function renumberMaterials() {
    [...materialList.querySelectorAll('.material-card')].forEach((card, index) => {
      card.querySelector('.material-number').textContent = String(index + 1);
      card.querySelector('.material-number-a11y').textContent = String(index + 1);
      card.querySelector('[data-material-action="delete"]').setAttribute('aria-label', `${index + 1}. anyag törlése`);
    });
    updateMaterialOptions();
    updateMaterialUsageState();
  }

  function newMaterial(data = {}) {
    materialCounter += 1;
    const domId = `material-profile-${Date.now()}-${materialCounter}`;
    const usedIds = new Set(readMaterials().map((material) => material.id));
    const preferredId = String(data.id || '').trim();
    const materialId = preferredId && !usedIds.has(preferredId) ? preferredId : `material-${Date.now()}-${materialCounter}`;
    const card = document.createElement('article');
    card.className = 'material-card';
    card.id = domId;
    card.tabIndex = -1;
    card.dataset.materialId = materialId;
    card.innerHTML = `
      <h4 class="sr-only"><span class="material-number-a11y"></span>. anyag</h4>
      <div class="material-grid">
        <div class="material-index"><span>Anyag</span><strong class="material-number"></strong></div>
        <div class="field material-profile-name"><label class="required" for="${domId}-name">Anyag / dekor vagy lapfajta</label><input id="${domId}-name" data-material-field="name" type="text" required aria-required="true" maxlength="120" value="${escapeHtml(data.name)}" placeholder="Pl. Egger H3303 ST10"></div>
        <div class="field material-profile-thickness"><label class="required" for="${domId}-thickness">Vastagság (mm)</label><input id="${domId}-thickness" data-material-field="thicknessMm" type="number" required aria-required="true" min="1" max="100" step="0.1" inputmode="decimal" value="${escapeHtml(data.thicknessMm)}" placeholder="18"><span class="input-unit" aria-hidden="true">mm</span></div>
        <div class="material-actions"><button class="icon-button delete" type="button" data-material-action="delete">Törlés</button></div>
      </div>
      <p class="material-error" id="${domId}-error" role="alert"></p>`;
    materialList.append(card);
    renumberMaterials();
    return card;
  }

  document.querySelector('#add-material').addEventListener('click', () => {
    const card = newMaterial();
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('[data-material-field="name"]').focus();
    queueSave();
  });

  materialList.addEventListener('click', (event) => {
    const card = event.target.closest('.material-card');
    if (!card || !event.target.closest('[data-material-action="delete"]')) return;
    const isUsed = readItems().filter(isMeaningfulItem).some((item) => item.materialId === card.dataset.materialId);
    if (materialList.children.length <= 1 || isUsed) return;
    card.remove();
    renumberMaterials();
    queueSave();
  });

  materialList.addEventListener('input', () => {
    updateMaterialOptions();
    queueSave();
  });

  function newItem(data = {}) {
    itemCounter += 1;
    const preferredId = String(data.id || '').trim();
    const id = preferredId && !document.getElementById(preferredId) ? preferredId : `item-${Date.now()}-${itemCounter}`;
    const edgeCode = edgeCodeFromData(data);
    const card = document.createElement('tr');
    card.className = 'item-card';
    card.id = id;
    card.tabIndex = -1;
    card.dataset.itemId = id;
    card.innerHTML = `
      <td class="cutlist-number" data-label="Tétel"><strong class="item-number"></strong><span class="sr-only"><span class="item-number-a11y"></span>. szabászjegyzék-tétel</span><span class="stored-item-fields" hidden>${ITEM_FIELD_NAMES.map((field) => `<input id="${id}-${field}" type="hidden" data-item-field="${field}">`).join('')}</span></td>
      <td data-label="Anyag"><strong data-summary-material>—</strong></td>
      <td data-label="Elnevezés"><span data-summary-name>—</span></td>
      <td data-label="Méret"><strong data-summary-size>—</strong><small>hossz × szélesség</small></td>
      <td data-label="Mennyiség"><strong data-summary-quantity>—</strong></td>
      <td data-label="Élzárás"><div class="cutlist-edge-lines"><span data-summary-edge="1">—</span><span data-summary-edge="2" hidden></span></div></td>
      <td data-label="Megjegyzés"><span data-summary-note>—</span></td>
      <td class="cutlist-actions" data-label="Műveletek"><div><button class="icon-button" type="button" data-item-action="edit">Szerk.</button><button class="icon-button" type="button" data-item-action="duplicate">Másol</button><button class="icon-button delete" type="button" data-item-action="delete">Töröl</button></div><p class="item-error" id="${id}-error" role="alert"></p></td>`;
    itemList.append(card);
    writeItem(card, { ...data, edgeCode });
    renumberItems();
    return card;
  }

  function writeItem(card, data = {}) {
    ITEM_FIELD_NAMES.forEach((field) => {
      const control = card.querySelector(`[data-item-field="${field}"]`);
      control.value = String(data[field] ?? (field === 'quantity' ? 1 : ''));
    });
    card.classList.remove('invalid');
    card.querySelector('.item-error').textContent = '';
    card.querySelectorAll('[data-item-field]').forEach((control) => {
      control.removeAttribute('aria-invalid');
      control.removeAttribute('aria-describedby');
    });
    renderItemSummary(card);
  }

  function renderItemSummary(card) {
    const item = readItem(card);
    const materials = readMaterials();
    const material = materials.find((entry) => entry.id === item.materialId);
    card.querySelector('[data-summary-material]').textContent = material ? materialDisplayName(material, materials.indexOf(material)) : 'Nincs kiválasztva';
    card.querySelector('[data-summary-name]').textContent = item.name || '—';
    card.querySelector('[data-summary-size]').textContent = item.lengthMm && item.widthMm ? `${formatDecimal(item.lengthMm)} × ${formatDecimal(item.widthMm)} mm` : '—';
    card.querySelector('[data-summary-quantity]').textContent = item.quantity ? `${item.quantity} db` : '—';
    card.querySelector('[data-summary-note]').textContent = item.note || '—';
    const firstEdge = card.querySelector('[data-summary-edge="1"]');
    const secondEdge = card.querySelector('[data-summary-edge="2"]');
    firstEdge.textContent = `1. ${edgeAssignmentSummary(item.edgeCode, item.edgeThicknessMm, item.edgeMaterialIdentifier)}`;
    secondEdge.hidden = !item.edgeCode2;
    secondEdge.textContent = item.edgeCode2 ? `2. ${edgeAssignmentSummary(item.edgeCode2, item.edgeThicknessMm2, item.edgeMaterialIdentifier2)}` : '';
  }

  function readItem(card) {
    const data = { id: card.dataset.itemId };
    card.querySelectorAll('[data-item-field]').forEach((control) => { data[control.dataset.itemField] = control.value.trim(); });
    return data;
  }

  function readItems() {
    return [...itemList.querySelectorAll('.item-card')].map(readItem);
  }

  function renumberItems() {
    const cards = [...itemList.querySelectorAll('.item-card')];
    cards.forEach((card, index) => {
      card.querySelector('.item-number').textContent = String(index + 1);
      card.querySelector('.item-number-a11y').textContent = String(index + 1);
      card.querySelector('[data-item-action="edit"]').setAttribute('aria-label', `${index + 1}. tétel szerkesztése`);
      card.querySelector('[data-item-action="duplicate"]').setAttribute('aria-label', `${index + 1}. tétel másolása`);
      card.querySelector('[data-item-action="delete"]').setAttribute('aria-label', `${index + 1}. tétel törlése`);
      renderItemSummary(card);
    });
    itemEmptyState.hidden = cards.length > 0;
    updateItemSummary();
    updateMaterialUsageState();
  }

  function isMeaningfulItem(item) {
    return [item.name, item.lengthMm, item.widthMm, item.note].some(Boolean);
  }

  function itemTotals() {
    return readItems().reduce((totals, item) => {
      if (!isMeaningfulItem(item)) return totals;
      const quantity = Number(item.quantity) || 0;
      const length = Number(item.lengthMm) || 0;
      const width = Number(item.widthMm) || 0;
      const edgeCodes = [item.edgeCode, item.edgeCode2].filter(Boolean);
      totals.rows += 1;
      totals.pieces += quantity;
      totals.area += quantity * length * width / 1_000_000;
      edgeCodes.forEach((code) => {
        const [longEdges, shortEdges] = edgeCodeParts(code);
        totals.edge += quantity * (longEdges * length + shortEdges * width) / 1000;
      });
      return totals;
    }, { rows: 0, pieces: 0, area: 0, edge: 0 });
  }

  function updateItemSummary() {
    const totals = itemTotals();
    itemSummary.textContent = `${totals.rows} tétel · ${totals.pieces} darab · ${totals.area.toFixed(2)} m² · kb. ${totals.edge.toFixed(1)} fm él`;
  }

  function composerField(name) {
    return itemComposer.querySelector(`[data-composer-field="${name}"]`);
  }

  function readComposerItem() {
    const data = {};
    itemComposer.querySelectorAll('[data-composer-field]').forEach((control) => { data[control.dataset.composerField] = control.value.trim(); });
    return data;
  }

  function composerSnapshot() {
    return JSON.stringify({
      item: readComposerItem(),
      secondaryEdgeActive: !itemComposer.querySelector('[data-composer-edge="2"]').hidden
    });
  }

  function updateComposerDirtyState() {
    composerDirty = composerBaseline === null || composerSnapshot() !== composerBaseline;
  }

  function clearComposerErrors() {
    itemComposerError.textContent = '';
    itemComposer.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.removeAttribute('aria-invalid'));
  }

  function setComposerStatus(message = '') {
    clearTimeout(composerStatusTimer);
    itemComposerStatus.textContent = message;
    if (message) composerStatusTimer = setTimeout(() => { itemComposerStatus.textContent = ''; }, 4500);
  }

  function setComposerItem(data = {}, { dirty = false } = {}) {
    clearComposerErrors();
    ITEM_FIELD_NAMES.forEach((field) => {
      const control = composerField(field);
      if (control) control.value = String(data[field] ?? (field === 'quantity' ? 1 : ''));
    });
    const requestedMaterialId = String(data.materialId || '');
    const materialControl = composerField('materialId');
    if (requestedMaterialId && [...materialControl.options].some((option) => option.value === requestedMaterialId)) materialControl.value = requestedMaterialId;
    const secondaryRow = itemComposer.querySelector('[data-composer-edge="2"]');
    secondaryRow.hidden = !data.edgeCode2;
    syncComposerEdges();
    composerDirty = dirty;
    composerBaseline = dirty ? null : composerSnapshot();
  }

  function resetItemComposer(defaults = {}) {
    editingItemId = null;
    itemComposer.classList.remove('editing');
    itemComposerTitle.textContent = 'Elem hozzáadása';
    saveItemButton.textContent = '+ Elem hozzáadása';
    cancelItemEditButton.hidden = true;
    setComposerItem({ quantity: 1, edgeCode2: '', edgeThicknessMm2: '', edgeMaterialIdentifier2: '', ...defaults });
  }

  function syncComposerEdges() {
    const secondaryRow = itemComposer.querySelector('[data-composer-edge="2"]');
    const firstCode = composerField('edgeCode').value;
    if (!secondaryRow.hidden && !EDGE_CODES_WITH_MATERIAL.includes(firstCode)) {
      ['edgeCode2', 'edgeThicknessMm2', 'edgeMaterialIdentifier2'].forEach((field) => { composerField(field).value = ''; });
      secondaryRow.hidden = true;
    }
    const [longOne, shortOne] = edgeCodeParts(firstCode);
    if (!secondaryRow.hidden && longOne === 2 && shortOne === 2) {
      ['edgeCode2', 'edgeThicknessMm2', 'edgeMaterialIdentifier2'].forEach((field) => { composerField(field).value = ''; });
      secondaryRow.hidden = true;
    }
    const secondaryCodeControl = composerField('edgeCode2');
    [...secondaryCodeControl.options].forEach((option) => {
      if (!option.value) return;
      const [longTwo, shortTwo] = edgeCodeParts(option.value);
      const allowed = longOne + longTwo <= 2 && shortOne + shortTwo <= 2;
      option.disabled = !allowed;
      option.hidden = !allowed;
    });
    if (secondaryCodeControl.selectedOptions[0]?.disabled) secondaryCodeControl.value = '';
    const secondaryActive = !secondaryRow.hidden;
    [1, 2].forEach((position) => {
      const suffix = position === 1 ? '' : '2';
      const row = itemComposer.querySelector(`[data-composer-edge="${position}"]`);
      const codeControl = composerField(`edgeCode${suffix}`);
      const thicknessControl = composerField(`edgeThicknessMm${suffix}`);
      const identifierControl = composerField(`edgeMaterialIdentifier${suffix}`);
      const active = position === 1 || secondaryActive;
      const code = active ? codeControl.value : '';
      const hasEdge = active && EDGE_CODES_WITH_MATERIAL.includes(code);
      const explicitlyNoEdge = position === 1 && code === '0-0';
      const [longEdges, shortEdges] = edgeCodeParts(code);
      row.querySelector('.edge-row-preview').className = `part l-${longEdges} s-${shortEdges} edge-row-preview`;
      codeControl.disabled = !active;
      codeControl.required = active;
      if (active) codeControl.setAttribute('aria-required', 'true');
      else codeControl.removeAttribute('aria-required');
      [thicknessControl, identifierControl].forEach((control) => {
        control.disabled = !active || explicitlyNoEdge || !hasEdge;
        control.required = hasEdge;
        if (hasEdge) control.setAttribute('aria-required', 'true');
        else control.removeAttribute('aria-required');
        control.closest('.field').querySelector('label').classList.toggle('required', hasEdge);
      });
      row.querySelector(`[data-composer-edge-summary="${position}"]`).textContent = edgeAssignmentSummary(code, thicknessControl.value, identifierControl.value);
    });
    const secondCode = secondaryActive ? composerField('edgeCode2').value : '';
    const addButton = document.querySelector('#add-composer-edge');
    const canAddSecondEdge = EDGE_CODES_WITH_MATERIAL.includes(firstCode) && (longOne < 2 || shortOne < 2);
    addButton.hidden = secondaryActive || !canAddSecondEdge;
    addButton.disabled = !canAddSecondEdge;
    const [longTwo, shortTwo] = edgeCodeParts(secondCode);
    const sharedEdgeDirection = secondaryActive && Boolean((longOne && longTwo) || (shortOne && shortTwo));
    const noteControl = composerField('note');
    const noteLabel = noteControl.closest('.field').querySelector('label');
    const noteRequirement = noteLabel.querySelector('[data-note-requirement]');
    noteControl.required = sharedEdgeDirection;
    if (sharedEdgeDirection) noteControl.setAttribute('aria-required', 'true');
    else noteControl.removeAttribute('aria-required');
    noteLabel.classList.toggle('required', sharedEdgeDirection);
    noteRequirement.textContent = sharedEdgeDirection ? '(kötelező az oldalak miatt)' : '(opcionális)';
    noteControl.placeholder = sharedEdgeDirection ? 'Pl. bal oldal: 1. ABS, jobb oldal: 2. ABS' : 'Pl. egyedi kérés';
    document.querySelector('#composer-edge-side-hint').hidden = !sharedEdgeDirection;
  }

  function itemValidationIssues(item, secondaryActive = Boolean(item.edgeCode2)) {
    const issues = [];
    const mark = (field, label) => issues.push({ field, label });
    if (!getMaterialProfile(item.materialId)) mark('materialId', 'anyag');
    const length = Number(item.lengthMm);
    if (!length || length < 10 || length > 5000) mark('lengthMm', 'hossz');
    const width = Number(item.widthMm);
    if (!width || width < 10 || width > 5000) mark('widthMm', 'szélesség');
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) mark('quantity', 'darabszám');
    if (!EDGE_CODES.includes(item.edgeCode)) mark('edgeCode', 'élkód');
    const hasEdge = EDGE_CODES_WITH_MATERIAL.includes(item.edgeCode);
    const firstThickness = Number(String(item.edgeThicknessMm || '').replace(',', '.'));
    if (hasEdge && (!Number.isFinite(firstThickness) || firstThickness < 0.1 || firstThickness > 10)) mark('edgeThicknessMm', 'első ABS vastagsága');
    if (hasEdge && !item.edgeMaterialIdentifier) mark('edgeMaterialIdentifier', 'első ABS színe / azonosítója');
    if (secondaryActive) {
      if (!EDGE_CODES_WITH_MATERIAL.includes(item.edgeCode2)) mark('edgeCode2', 'második élkód');
      const secondThickness = Number(String(item.edgeThicknessMm2 || '').replace(',', '.'));
      if (!Number.isFinite(secondThickness) || secondThickness < 0.1 || secondThickness > 10) mark('edgeThicknessMm2', 'második ABS vastagsága');
      if (!item.edgeMaterialIdentifier2) mark('edgeMaterialIdentifier2', 'második ABS színe / azonosítója');
      const [longOne, shortOne] = edgeCodeParts(item.edgeCode);
      const [longTwo, shortTwo] = edgeCodeParts(item.edgeCode2);
      if (longOne + longTwo > 2 || shortOne + shortTwo > 2) mark('edgeCode2', 'az élkódok együtt legfeljebb 2 hosszú és 2 rövid élt jelölhetnek');
      if (((longOne && longTwo) || (shortOne && shortTwo)) && !item.note.trim()) mark('note', 'írja le a Megjegyzésben, melyik oldal melyik ABS-t kapja');
    }
    return issues;
  }

  function validateComposerItem(data) {
    clearComposerErrors();
    const secondaryActive = !itemComposer.querySelector('[data-composer-edge="2"]').hidden;
    const issues = itemValidationIssues(data, secondaryActive);
    issues.forEach(({ field }) => composerField(field)?.setAttribute('aria-invalid', 'true'));
    if (!issues.length) return true;
    itemComposerError.textContent = `Ellenőrizze: ${issues.map(({ label }) => label).join(', ')}.`;
    composerField(issues[0].field)?.focus();
    return false;
  }

  function commitComposerItem({ refocus = true } = {}) {
    const data = readComposerItem();
    if (!editingItemId && itemList.children.length >= MAX_ITEMS) {
      itemComposerError.textContent = `Legfeljebb ${MAX_ITEMS} tételsor adható meg.`;
      return false;
    }
    if (!validateComposerItem(data)) return false;
    const editingCard = editingItemId ? document.getElementById(editingItemId) : null;
    const wasEditing = Boolean(editingCard);
    if (editingCard) writeItem(editingCard, data);
    else newItem(data);
    renumberItems();
    const keepSettings = retainItemSettings.checked;
    const defaults = keepSettings ? {
      materialId: data.materialId,
      quantity: 1,
      edgeCode: data.edgeCode,
      edgeThicknessMm: data.edgeCode === '0-0' ? '' : data.edgeThicknessMm,
      edgeMaterialIdentifier: data.edgeCode === '0-0' ? '' : data.edgeMaterialIdentifier,
      edgeCode2: data.edgeCode2,
      edgeThicknessMm2: data.edgeThicknessMm2,
      edgeMaterialIdentifier2: data.edgeMaterialIdentifier2
    } : { quantity: 1 };
    resetItemComposer(defaults);
    const rowNumber = wasEditing
      ? [...itemList.querySelectorAll('.item-card')].indexOf(editingCard) + 1
      : itemList.querySelectorAll('.item-card').length;
    setComposerStatus(wasEditing
      ? `✓ A(z) ${rowNumber}. tétel módosítása elmentve.`
      : `✓ A(z) ${rowNumber}. tétel hozzáadva.${keepSettings ? ' Az anyag és az ABS megmaradt a következőhöz.' : ''}`);
    queueSave();
    if (refocus) composerField(keepSettings && data.materialId ? 'lengthMm' : 'materialId').focus();
    return true;
  }

  function editItem(card) {
    if (editingItemId === card.id) {
      itemComposer.scrollIntoView({ behavior: 'smooth', block: 'center' });
      composerField('name').focus({ preventScroll: true });
      return;
    }
    if (composerDirty && editingItemId !== card.id && !window.confirm('Van egy még nem mentett alkatrész vagy módosítás. Elveti, és megnyitja ezt a tételt?')) return;
    editingItemId = card.id;
    const index = [...itemList.querySelectorAll('.item-card')].indexOf(card) + 1;
    itemComposer.classList.add('editing');
    itemComposerTitle.textContent = `${index}. elem szerkesztése`;
    saveItemButton.textContent = 'Módosítás mentése';
    cancelItemEditButton.hidden = false;
    setComposerItem(readItem(card));
    setComposerStatus('');
    itemComposer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    composerField('name').focus({ preventScroll: true });
  }

  function focusItemComposer() {
    itemComposer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    composerField(composerField('materialId').value ? 'lengthMm' : 'materialId').focus({ preventScroll: true });
  }

  document.querySelector('#focus-item-composer').addEventListener('click', focusItemComposer);
  saveItemButton.addEventListener('click', () => commitComposerItem());
  cancelItemEditButton.addEventListener('click', () => {
    resetItemComposer({ materialId: readItems().at(-1)?.materialId || '' });
    setComposerStatus('A módosítás elvetve.');
  });
  document.querySelector('#add-composer-edge').addEventListener('click', () => {
    const row = itemComposer.querySelector('[data-composer-edge="2"]');
    if (document.querySelector('#add-composer-edge').disabled) return;
    row.hidden = false;
    syncComposerEdges();
    updateComposerDirtyState();
    composerField('edgeCode2').focus();
    queueSave();
  });
  document.querySelector('#remove-composer-edge').addEventListener('click', () => {
    ['edgeCode2', 'edgeThicknessMm2', 'edgeMaterialIdentifier2'].forEach((field) => { composerField(field).value = ''; });
    itemComposer.querySelector('[data-composer-edge="2"]').hidden = true;
    syncComposerEdges();
    updateComposerDirtyState();
    queueSave();
  });
  itemComposer.addEventListener('input', (event) => {
    if (event.target.matches('[data-composer-field^="edge"]')) syncComposerEdges();
    if (event.target.matches('[data-composer-field]')) updateComposerDirtyState();
    event.target.removeAttribute('aria-invalid');
    itemComposerError.textContent = '';
    setComposerStatus('');
    queueSave();
  });
  itemComposer.addEventListener('change', (event) => {
    if (event.target.matches('[data-composer-field^="edge"]')) syncComposerEdges();
    if (event.target.matches('[data-composer-field]')) updateComposerDirtyState();
    event.target.removeAttribute('aria-invalid');
    itemComposerError.textContent = '';
    setComposerStatus('');
    queueSave();
  });

  itemList.addEventListener('click', (event) => {
    const card = event.target.closest('.item-card');
    if (!card) return;
    const action = event.target.closest('[data-item-action]')?.dataset.itemAction;
    if (action === 'edit') {
      editItem(card);
    } else if (action === 'duplicate') {
      if (itemList.children.length >= MAX_ITEMS) return;
      const clone = newItem({ ...readItem(card), id: undefined });
      card.after(clone);
      renumberItems();
      queueSave();
    } else if (action === 'delete') {
      if (editingItemId === card.id) resetItemComposer({ materialId: readItems().at(-1)?.materialId || '' });
      card.remove();
      renumberItems();
      queueSave();
    }
  });

  function moveToNextManualField(event, selector, fallback, submitOnLast = false) {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('input') || !event.target.matches(selector)) return;
    event.preventDefault();
    const controls = [...document.querySelectorAll(selector)].filter((control) => !control.disabled && control.offsetParent !== null);
    const next = controls[controls.indexOf(event.target) + 1];
    if (next) next.focus();
    else if (submitOnLast) commitComposerItem();
    else document.querySelector(fallback)?.focus();
  }

  materialList.addEventListener('keydown', (event) => moveToNextManualField(event, '#material-list [data-material-field]', '#item-composer [data-composer-field="materialId"]'));
  itemComposer.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commitComposerItem();
      return;
    }
    if (event.key === 'Escape' && editingItemId) {
      event.preventDefault();
      resetItemComposer({ materialId: readItems().at(-1)?.materialId || '' });
      setComposerStatus('A módosítás elvetve.');
      return;
    }
    moveToNextManualField(event, '#item-composer [data-composer-field]', '#save-item', true);
  });
  itemComposer.addEventListener('focusin', (event) => {
    if (event.target.matches('input[type="number"]')) event.target.select();
  });
  resetItemComposer();

  function clearErrors() {
    errorSummary.classList.remove('visible');
    errorList.innerHTML = '';
    form.querySelectorAll('.field-error').forEach((node) => { if (!node.id.endsWith('files-error')) node.textContent = ''; });
    form.querySelectorAll('[aria-invalid="true"]').forEach((node) => node.removeAttribute('aria-invalid'));
    form.querySelectorAll('.material-card.invalid').forEach((node) => node.classList.remove('invalid'));
    form.querySelectorAll('.material-error').forEach((node) => { node.textContent = ''; });
    form.querySelectorAll('.item-card.invalid').forEach((node) => node.classList.remove('invalid'));
    form.querySelectorAll('.item-error').forEach((node) => { node.textContent = ''; });
  }

  function addError(errors, controlId, message, errorId = `${controlId}-error`) {
    const control = document.getElementById(controlId);
    const messageNode = document.getElementById(errorId);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      const describedBy = new Set((control.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
      describedBy.add(errorId);
      control.setAttribute('aria-describedby', [...describedBy].join(' '));
    }
    messageNode?.closest('fieldset')?.setAttribute('aria-invalid', 'true');
    if (messageNode) messageNode.textContent = message;
    errors.push({ id: controlId, message });
  }

  function validateDetails(errors) {
    if (activeFlow === 'upload') {
      const fileErrors = validateAttachmentSet(files.upload, 'upload', true);
      if (fileErrors.length) addError(errors, 'upload-files', fileErrors.join(' '), 'upload-files-error');
      else document.querySelector('#upload-files-error').textContent = '';
      if (!fieldValue('upload_material_source')) addError(errors, 'upload-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'upload-material-source-error');
      const uploadThickness = fieldValue('upload_thickness');
      if (uploadThickness && (Number(uploadThickness) < 1 || Number(uploadThickness) > 100)) addError(errors, 'upload-thickness', 'Adjon meg 1 és 100 mm közötti vastagságot.');
    }
    if (activeFlow === 'help') {
      const fileErrors = validateAttachmentSet(files.help, 'help');
      if (fileErrors.length) addError(errors, 'help-files', fileErrors.join(' '), 'help-files-error');
      else document.querySelector('#help-files-error').textContent = '';
      if (!fieldValue('help_topics').length) addError(errors, 'help-material', 'Válasszon legalább egy témát.', 'help-topics-error');
      const description = fieldValue('help_description');
      if (description.length < 20) addError(errors, 'help-description', 'Írja le legalább 20 karakterben, miben kér segítséget.');
    }
  }

  function validateItems(errors) {
    if (!fieldValue('manual_material_source')) addError(errors, 'manual-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'manual-material-source-error');
    const materialCards = [...materialList.querySelectorAll('.material-card')];
    const seenMaterialPairs = new Set();
    if (!materialCards.length) errors.push({ id: 'add-material', message: 'Vegyen fel legalább egy anyagot.' });
    if (materialCards.length > MAX_MATERIALS) errors.push({ id: 'add-material', message: `Legfeljebb ${MAX_MATERIALS} különböző anyag adható meg.` });
    materialCards.forEach((card, index) => {
      const material = readMaterial(card);
      const messages = [];
      const invalidControls = [];
      const mark = (field, label) => {
        messages.push(label);
        const control = card.querySelector(`[data-material-field="${field}"]`);
        if (control) invalidControls.push(control);
      };
      if (material.name.length < 2) mark('name', 'anyag / dekor vagy lapfajta');
      const thickness = Number(material.thicknessMm);
      if (!thickness || thickness < 1 || thickness > 100) mark('thicknessMm', 'vastagság');
      const pairKey = materialPairKey(material.name, material.thicknessMm);
      if (material.name.length >= 2 && thickness >= 1 && thickness <= 100) {
        if (seenMaterialPairs.has(pairKey)) mark('name', 'már felvett anyag–vastagság páros');
        else seenMaterialPairs.add(pairKey);
      }
      if (messages.length) {
        card.classList.add('invalid');
        const errorId = `${card.id}-error`;
        card.querySelector('.material-error').textContent = `Ellenőrizze: ${messages.join(', ')}.`;
        invalidControls.forEach((control) => {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', errorId);
        });
        errors.push({ id: invalidControls[0]?.id || card.id, message: `${index + 1}. anyag: ${messages.join(', ')}.` });
      }
    });
    const cards = [...itemList.querySelectorAll('.item-card')];
    if (!cards.length) {
      errors.push({ id: 'save-item', message: 'Vegyen fel legalább egy tételt.' });
      return;
    }
    if (cards.length > MAX_ITEMS) errors.push({ id: 'save-item', message: `Legfeljebb ${MAX_ITEMS} tételsor adható meg.` });
    cards.forEach((card, index) => {
      const item = readItem(card);
      const issues = itemValidationIssues(item, Boolean(item.edgeCode2));
      const messages = issues.map(({ label }) => label);
      const invalidControls = [];
      issues.forEach(({ field }) => {
        const control = card.querySelector(`[data-item-field="${field}"]`);
        if (control) invalidControls.push(control);
      });
      if (messages.length) {
        card.classList.add('invalid');
        const errorId = `${card.id}-error`;
        card.querySelector('.item-error').textContent = `Ellenőrizze: ${messages.join(', ')}.`;
        invalidControls.forEach((control) => {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', errorId);
        });
        errors.push({ id: card.id, message: `${index + 1}. tétel: ${messages.join(', ')}.` });
      }
    });
  }

  function validateLogistics(errors) {
    const fulfillment = fieldValue('fulfillment');
    if (!fulfillment) addError(errors, 'fulfillment-pickup', 'Válassza ki az átvétel módját.', 'fulfillment-error');
    if (fulfillment === 'delivery' && !/^[1-9]\d{3}$/.test(fieldValue('postal_code'))) addError(errors, 'postal-code', 'Adjon meg érvényes, 4 számjegyű magyar irányítószámot.');
    const target = fieldValue('target_date');
    if (target) {
      const selected = new Date(`${target}T12:00:00`);
      const today = new Date(); today.setHours(0,0,0,0);
      if (selected < today) addError(errors, 'target-date', 'A kívánt dátum nem lehet korábbi a mai napnál.');
    }
  }

  function validateContact(errors) {
    const name = fieldValue('customer_name');
    const companyName = fieldValue('company_name');
    const email = fieldValue('customer_email');
    const phone = fieldValue('customer_phone');
    const phoneDigits = phone.replace(/\D/g, '');
    const compactPhone = phone.replace(/[\s()./-]/g, '');
    if (name.length < 2) addError(errors, 'customer-name', 'Adja meg a nevét legalább 2 karakterben.');
    if (companyName && companyName.length < 2) addError(errors, 'company-name', 'A cégnév legalább 2 karakter legyen.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) addError(errors, 'customer-email', 'Adjon meg érvényes e-mail címet.');
    if (phone && (!/^\+?\d+$/.test(compactPhone) || phoneDigits.length < 7 || phoneDigits.length > 15)) addError(errors, 'customer-phone', 'Adjon meg érvényes telefonszámot, betűk nélkül.');
    if (!email && !phone) {
      addError(errors, 'customer-email', 'Az e-mail vagy a telefonszám közül legalább az egyik szükséges.');
      addError(errors, 'customer-phone', 'Az e-mail vagy a telefonszám közül legalább az egyik szükséges.');
    }
    if (email && !phone) document.querySelector('#contact-email').checked = true;
    if (phone && !email) document.querySelector('#contact-phone').checked = true;
    const preferred = fieldValue('preferred_contact');
    if ((email || phone) && preferred === 'email' && !email) addError(errors, 'customer-email', 'E-mailes kapcsolattartáshoz adja meg az e-mail címét.');
    if ((email || phone) && preferred === 'phone' && !phone) addError(errors, 'customer-phone', 'Telefonos kapcsolattartáshoz adja meg a telefonszámát.');
    if (!document.querySelector('#privacy-consent').checked) addError(errors, 'privacy-consent', 'Az ajánlatkéréshez el kell fogadnia az adatkezelési tájékoztatót.');
  }

  function cleanText(value) {
    return String(value ?? '').trim();
  }

  function optionalNumber(value) {
    const normalized = cleanText(value).replace(',', '.');
    if (!normalized) return null;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
  }

  function resolvePreferredContact(email, phone, preferredContact) {
    if (email && !phone) return 'email';
    if (phone && !email) return 'phone';
    return preferredContact === 'phone' ? 'phone' : 'email';
  }

  function buildSubmissionPayload({ flow, fields, materials = [], items = [] }) {
    const email = cleanText(fields.customer_email);
    const phone = cleanText(fields.customer_phone);
    const payload = {
      schemaVersion: 2,
      flow,
      sizeBasis: 'finished',
      contact: {
        name: cleanText(fields.customer_name),
        companyName: cleanText(fields.company_name),
        email,
        phone,
        preferredContact: resolvePreferredContact(email, phone, fields.preferred_contact)
      },
      privacyConsent: Boolean(fields.privacy_consent),
      details: null,
      logistics: null
    };

    if (flow === 'manual') {
      payload.details = {
        sizeBasis: 'finished',
        materialSource: cleanText(fields.manual_material_source),
        materials: materials.map((material, index) => ({
          clientId: cleanText(material.id),
          name: cleanText(material.name),
          thicknessMm: Number(canonicalThickness(material.thicknessMm)),
          displayOrder: index + 1
        })),
        items: items.map((item, index) => {
          const edgeBands = [{
            code: cleanText(item.edgeCode),
            thicknessMm: item.edgeCode === '0-0' ? null : optionalNumber(item.edgeThicknessMm),
            materialType: item.edgeCode === '0-0' ? null : cleanText(item.edgeMaterialIdentifier)
          }];
          if (item.edgeCode2) {
            edgeBands.push({
              code: cleanText(item.edgeCode2),
              thicknessMm: optionalNumber(item.edgeThicknessMm2),
              materialType: cleanText(item.edgeMaterialIdentifier2)
            });
          }
          return {
            materialClientId: cleanText(item.materialId),
            name: cleanText(item.name),
            lengthMm: Number(item.lengthMm),
            widthMm: Number(item.widthMm),
            quantity: Number(item.quantity),
            edgeBands,
            note: cleanText(item.note),
            displayOrder: index + 1
          };
        })
      };
    } else if (flow === 'upload') {
      payload.details = {
        sizeBasis: 'finished',
        materialSource: cleanText(fields.upload_material_source),
        materialHint: cleanText(fields.upload_material),
        thicknessMm: optionalNumber(fields.upload_thickness),
        note: cleanText(fields.upload_note)
      };
    } else if (flow === 'help') {
      payload.details = {
        topics: Array.isArray(fields.help_topics) ? fields.help_topics.map(cleanText).filter(Boolean) : [],
        description: cleanText(fields.help_description)
      };
    }

    if (flow !== 'help') {
      payload.logistics = {
        fulfillment: cleanText(fields.fulfillment),
        postalCode: fields.fulfillment === 'delivery' ? cleanText(fields.postal_code) : '',
        targetDate: cleanText(fields.target_date),
        note: cleanText(fields.project_note)
      };
    }

    return payload;
  }

  function parseRetryAfter(value, now = Date.now()) {
    const raw = cleanText(value);
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
    const retryAt = Date.parse(raw);
    if (!Number.isFinite(retryAt)) return null;
    return Math.max(0, Math.ceil((retryAt - now) / 1000));
  }

  function retryDelayText(seconds) {
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return `${Math.max(1, seconds)} másodperc múlva`;
    return `${Math.ceil(seconds / 60)} perc múlva`;
  }

  function submissionErrorMessage(status, responseBody, retryAfterHeader) {
    const code = cleanText(responseBody?.code);
    const wait = retryDelayText(parseRetryAfter(retryAfterHeader));
    if (status === 409 || code === 'submission-token-conflict') {
      return 'A beküldés azonosítója már egy másik ajánlatkéréshez tartozik. Új azonosítót készítettünk; kérjük, próbálja meg ismét.';
    }
    if (status === 429) {
      return wait
        ? `Rövid időn belül túl sok beküldési kísérlet érkezett. Kérjük, próbálja újra ${wait}.`
        : 'Rövid időn belül túl sok beküldési kísérlet érkezett. Kérjük, várjon egy kicsit, majd próbálja újra.';
    }
    if (status === 503) {
      return wait
        ? `Az ajánlatkérő átmenetileg nem érhető el. Kérjük, próbálja újra ${wait}.`
        : 'Az ajánlatkérő átmenetileg nem érhető el. Kérjük, próbálja újra néhány perc múlva.';
    }
    if (status === 413) return 'A mellékletek mérete túl nagy. Fájlonként legfeljebb 6 MB, összesen legfeljebb 15 MB küldhető.';
    if (status === 415) return 'Az egyik melléklet formátumát nem tudjuk fogadni. Kérjük, ellenőrizze a kiválasztott fájlokat.';
    if (status === 400 && code === 'validation-failed' && cleanText(responseBody?.error)) return cleanText(responseBody.error).slice(0, 500);
    if (status >= 400 && status < 500) return 'Az ajánlatkérést nem sikerült elküldeni. Kérjük, ellenőrizze a megadott adatokat és próbálja újra.';
    return 'Az ajánlatkérést most nem sikerült elküldeni. Az adatai megmaradtak; kérjük, próbálja újra néhány perc múlva.';
  }

  function collectSubmissionFields() {
    return {
      customer_name: fieldValue('customer_name'),
      company_name: fieldValue('company_name'),
      customer_email: fieldValue('customer_email'),
      customer_phone: fieldValue('customer_phone'),
      preferred_contact: fieldValue('preferred_contact'),
      privacy_consent: document.querySelector('#privacy-consent').checked,
      manual_material_source: fieldValue('manual_material_source'),
      upload_material_source: fieldValue('upload_material_source'),
      upload_material: fieldValue('upload_material'),
      upload_thickness: fieldValue('upload_thickness'),
      upload_note: fieldValue('upload_note'),
      help_topics: fieldValue('help_topics'),
      help_description: fieldValue('help_description'),
      fulfillment: fieldValue('fulfillment'),
      postal_code: fieldValue('postal_code'),
      target_date: fieldValue('target_date'),
      project_note: fieldValue('project_note')
    };
  }

  function setSubmitFeedback(message = '', tone = 'info') {
    submitFeedback.textContent = message;
    submitFeedback.className = `submit-feedback ${tone}`;
    submitFeedback.hidden = !message;
  }

  function validateStep(step, show = true) {
    if (show) clearErrors();
    const errors = [];
    if (step === 'details') validateDetails(errors);
    if (step === 'items') validateItems(errors);
    if (step === 'logistics') validateLogistics(errors);
    if (step === 'contact') validateContact(errors);
    if (show && errors.length) showErrors(errors);
    return errors;
  }

  function showErrors(errors) {
    errorList.innerHTML = errors.map((error) => `<li><a href="#${escapeHtml(error.id)}">${escapeHtml(error.message)}</a></li>`).join('');
    errorSummary.classList.add('visible');
    errorSummary.focus();
    errorList.querySelectorAll('a').forEach((link) => link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = document.getElementById(link.getAttribute('href').slice(1));
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target?.matches('input, select, textarea, button')) target.focus();
    }));
  }

  function seedFirstMaterial() {
    const first = materialList.querySelector('.material-card');
    if (!first) return newMaterial();
    return first;
  }

  function seedFirstItem() {
    const first = itemList.querySelector('.item-card');
    return first || itemComposer;
  }

  function reviewCard(title, step, rows) {
    return `<article class="review-card"><div class="review-head"><h3>${escapeHtml(title)}</h3><button class="review-edit" type="button" data-edit-step="${escapeHtml(step)}">Szerkesztés</button></div><dl>${rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value || 'Nincs megadva')}</dd>`).join('')}</dl></article>`;
  }

  function buildReview() {
    const review = document.querySelector('#review-list');
    const cards = [];
    if (activeFlow === 'upload') {
      const uploadThickness = fieldValue('upload_thickness');
      cards.push(reviewCard('Szabászjegyzék', 'details', [
        ['Beküldési mód', FLOW_NAMES.upload],
        ['Fájlok', files.upload.map((file) => file.name).join(', ')],
        ['Anyag biztosítása', MATERIAL_SOURCE_NAMES[fieldValue('upload_material_source')]],
        ['Anyag / dekor', fieldValue('upload_material')],
        ['Vastagság', uploadThickness === 'other' ? 'Más / egyeztetendő' : uploadThickness ? `${uploadThickness} mm` : 'A fájlban / egyeztetendő'],
        ['Méret', 'Kész méret, élzárással együtt'],
        ['Megjegyzés', fieldValue('upload_note')]
      ]));
    } else if (activeFlow === 'manual') {
      const materials = readMaterials();
      cards.push(reviewCard('Munka alapadatai', 'items', [
        ['Beküldési mód', FLOW_NAMES.manual],
        ['Anyag biztosítása', MATERIAL_SOURCE_NAMES[fieldValue('manual_material_source')]],
        ['Méret', 'Kész méret, élzárással együtt'],
        ['Anyagok', materials.map((material, index) => materialDisplayName(material, index)).join('\n')]
      ]));
      const totals = itemTotals();
      const items = readItems().map((item, index) => {
        const material = materials.find((profile) => profile.id === item.materialId);
        const materialName = material ? `${material.name || 'Névtelen anyag'}, ${material.thicknessMm || '?'} mm` : 'Anyag nincs kiválasztva';
        const edgeAssignments = [
          edgeAssignmentSummary(item.edgeCode, item.edgeThicknessMm, item.edgeMaterialIdentifier),
          item.edgeCode2 ? edgeAssignmentSummary(item.edgeCode2, item.edgeThicknessMm2, item.edgeMaterialIdentifier2) : ''
        ].filter(Boolean);
        const edgeData = item.edgeCode === '0-0'
          ? 'élzárás: 0-0 · élzárás nélkül'
          : `élzárás: ${edgeAssignments.map((assignment, assignmentIndex) => `${assignmentIndex + 1}. ${assignment}`).join('; ')}`;
        return `${index + 1}. ${item.name || 'Névtelen tétel'} – ${materialName}; ${item.lengthMm || '?'} × ${item.widthMm || '?'} mm (hossz/szálirány × szélesség/keresztirány), ${item.quantity || '?'} db; ${edgeData}${item.note ? `; megjegyzés: ${item.note}` : ''}`;
      }).join('\n');
      cards.push(reviewCard('Tételek', 'items', [
        ['Összesítés', `${totals.rows} tétel, ${totals.pieces} darab, ${totals.area.toFixed(2)} m², kb. ${totals.edge.toFixed(1)} fm él`],
        ['Részletek', items]
      ]));
    } else {
      cards.push(reviewCard('Segítségkérés', 'details', [
        ['Témák', fieldValue('help_topics').map((topic) => HELP_TOPIC_NAMES[topic]).join(', ')],
        ['Leírás', fieldValue('help_description')],
        ['Mellékletek', files.help.map((file) => file.name).join(', ') || 'Nincs']
      ]));
    }
    if (activeFlow !== 'help') {
      const fulfillment = fieldValue('fulfillment');
      cards.push(reviewCard('Átvétel és időzítés', 'logistics', [
        ['Átvétel', FULFILLMENT_NAMES[fulfillment]],
        ['Irányítószám', fulfillment === 'delivery' ? fieldValue('postal_code') : 'Nem szükséges'],
        ['Kívánt időpont', fieldValue('target_date')],
        ['Megjegyzés', fieldValue('project_note')]
      ]));
    }
    const email = fieldValue('customer_email');
    const phone = fieldValue('customer_phone');
    const preferredContact = email && !phone ? 'email' : phone && !email ? 'phone' : fieldValue('preferred_contact');
    cards.push(reviewCard('Kapcsolattartás', 'contact', [
      ['Név', fieldValue('customer_name')],
      ['Cégnév', fieldValue('company_name')],
      ['E-mail', email],
      ['Telefon', phone],
      ['Elsődleges kapcsolat', preferredContact === 'phone' ? 'Telefon' : 'E-mail']
    ]));
    review.innerHTML = cards.join('');
    review.querySelectorAll('[data-edit-step]').forEach((button) => button.addEventListener('click', () => {
      const targetIndex = FLOW_STEPS[activeFlow].indexOf(button.dataset.editStep);
      if (targetIndex >= 0) { stepIndex = targetIndex; updateStep(); }
    }));
  }

  function updateStep() {
    const steps = FLOW_STEPS[activeFlow];
    const activeStep = steps[stepIndex];
    document.querySelectorAll('.step-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.step === activeStep));
    stepLabel.textContent = `${stepIndex + 1}/${steps.length}. lépés · ${STEP_NAMES[activeStep]}`;
    progressBar.style.width = `${((stepIndex + 1) / steps.length) * 100}%`;
    backButton.textContent = stepIndex === 0 ? 'Kezdőképernyő' : 'Vissza';
    nextButton.hidden = stepIndex === steps.length - 1;
    submitButton.hidden = stepIndex !== steps.length - 1;
    nextButton.textContent = activeFlow === 'manual' && activeStep === 'items' ? 'Ajánlatkérés folytatása →' : 'Tovább →';
    document.querySelector('#change-flow').hidden = stepIndex === 0;
    if (activeStep === 'items') {
      seedFirstMaterial();
      seedFirstItem();
    }
    if (activeStep === 'review') buildReview();
    clearErrors();
    queueSave();
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
    const activePanel = document.querySelector(`.step-panel[data-step="${activeStep}"]`);
    const heading = activeStep === 'details' ? activePanel.querySelector('.flow-panel.active h2') : activePanel.querySelector('h2');
    requestAnimationFrame(() => heading?.focus({ preventScroll: true }));
  }

  function startFlow(flow, draft = null) {
    if (!FLOW_STEPS[flow]) return;
    setSubmitFeedback();
    activeFlow = flow;
    const requestedStep = Number(draft?.stepIndex);
    stepIndex = Number.isInteger(requestedStep) && requestedStep >= 0 && requestedStep < FLOW_STEPS[flow].length ? requestedStep : 0;
    flowChoice.style.display = 'none';
    wizard.classList.add('active');
    successPanel.classList.remove('active');
    document.body.classList.toggle('manual-workspace', flow === 'manual');
    document.querySelectorAll('[data-flow-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.flowPanel === flow));
    if (flow === 'manual') {
      if (!materialList.children.length) newMaterial();
    }
    updateStep();
  }

  function returnToChoice() {
    if (activeFlow) {
      clearTimeout(saveTimer);
      saveTimer = null;
      saveDraft();
    }
    wizard.classList.remove('active');
    successPanel.classList.remove('active');
    setSubmitFeedback();
    flowChoice.style.display = 'block';
    document.body.classList.remove('manual-workspace');
    activeFlow = null;
    stepIndex = 0;
    history.replaceState(null, '', location.pathname);
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
    requestAnimationFrame(() => document.querySelector('#flow-choice-title')?.focus({ preventScroll: true }));
  }

  document.querySelectorAll('[data-flow]').forEach((button) => button.addEventListener('click', () => {
    history.replaceState(null, '', `${location.pathname}?ut=${button.dataset.flow}`);
    startFlow(button.dataset.flow);
  }));
  document.querySelector('#change-flow').addEventListener('click', returnToChoice);
  backButton.addEventListener('click', () => {
    if (stepIndex === 0) returnToChoice();
    else { stepIndex -= 1; updateStep(); }
  });
  nextButton.addEventListener('click', () => {
    const step = FLOW_STEPS[activeFlow][stepIndex];
    if (step === 'items' && (composerDirty || editingItemId) && !commitComposerItem({ refocus: false })) return;
    if (validateStep(step).length) return;
    stepIndex += 1;
    updateStep();
  });

  document.querySelectorAll('input[name="fulfillment"]').forEach((control) => control.addEventListener('change', () => {
    const delivery = fieldValue('fulfillment') === 'delivery';
    document.querySelector('#postcode-field').hidden = !delivery;
    const postcode = document.querySelector('#postal-code');
    postcode.required = delivery;
    if (delivery) postcode.setAttribute('aria-required', 'true');
    else postcode.removeAttribute('aria-required');
  }));

  function collectDraft() {
    const fields = {};
    const handled = new Set();
    [...form.elements].forEach((control) => {
      if (!control.name || handled.has(control.name) || control.type === 'file') return;
      handled.add(control.name);
      fields[control.name] = control.type === 'checkbox' && control.name === 'privacy_consent' ? control.checked : fieldValue(control.name);
    });
    return {
      schemaVersion: 5,
      flow: activeFlow,
      stepIndex,
      submissionToken,
      fields,
      materialProfiles: readMaterials(),
      items: readItems(),
      composerItem: activeFlow === 'manual' ? readComposerItem() : null,
      composerDirty: activeFlow === 'manual' ? composerDirty : false,
      composerEditingItemId: activeFlow === 'manual' ? editingItemId : null,
      composerSecondEdgeActive: activeFlow === 'manual' ? !itemComposer.querySelector('[data-composer-edge="2"]').hidden : false,
      retainItemSettings: activeFlow === 'manual' ? retainItemSettings.checked : true,
      filesMeta: {
        upload: files.upload.length ? files.upload.map(({ name, size, type, lastModified }) => ({ name, size, type, lastModified })) : restoredFilesMeta.upload,
        help: files.help.length ? files.help.map(({ name, size, type, lastModified }) => ({ name, size, type, lastModified })) : restoredFilesMeta.help
      },
      updatedAt: new Date().toISOString()
    };
  }

  function saveDraft() {
    if (!activeFlow) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
      localStorage.removeItem(V4_DRAFT_KEY);
      localStorage.removeItem(V3_DRAFT_KEY);
      localStorage.removeItem(V2_DRAFT_KEY);
      localStorage.removeItem(V1_DRAFT_KEY);
      const time = new Intl.DateTimeFormat('hu-HU', { hour: '2-digit', minute: '2-digit' }).format(new Date());
      saveStatus.textContent = `Mentve: ${time}`;
    } catch (_) {
      saveStatus.textContent = 'A piszkozat mentése nem sikerült';
    }
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 600);
  }
  form.addEventListener('input', queueSave);
  form.addEventListener('change', queueSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveDraft(); });

  function migrateV1ToV2(draft) {
    if (draft?.schemaVersion !== 1) return draft;
    const legacyMaterial = draft.fields?.manual_material || '';
    const legacyThickness = draft.fields?.manual_thickness || '';
    const items = Array.isArray(draft.items) ? draft.items.map((rawItem) => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      return {
        ...item,
        material: item.material || legacyMaterial,
        thicknessMm: item.thicknessMm || legacyThickness,
        edgeCode: edgeCodeFromData(item)
      };
    }) : [];
    let migratedStep = Number(draft.stepIndex) || 0;
    if (draft.flow === 'manual') migratedStep = migratedStep <= 1 ? 0 : migratedStep - 1;
    return { ...draft, schemaVersion: 2, stepIndex: migratedStep, items };
  }

  function migrateEdgeMaterial(item, edgeCode) {
    if (edgeCode === '0-0') return '';
    if (String(item.edgeMaterialType || '').trim()) return String(item.edgeMaterialType).trim();
    const band = String(legacyEdgeBandValue(item.edgeBand)).trim();
    const rawThickness = String(item.edgeThickness ?? '').trim();
    const thickness = rawThickness === 'other'
      ? 'egyedi / egyeztetendő vastagság'
      : rawThickness
        ? `${rawThickness.replace('.', ',')} mm`
        : '';
    return [band, thickness].filter(Boolean).join(' · ');
  }

  function migrateV2ToV3(draft) {
    if (draft?.schemaVersion !== 2) return draft;
    const materialProfiles = [];
    const profileIdByPair = new Map();
    const getMaterialId = (item = {}) => {
      const name = String(item.material ?? '').trim().replace(/\s+/g, ' ');
      const thicknessMm = canonicalThickness(item.thicknessMm);
      const key = materialPairKey(name, thicknessMm);
      if (!profileIdByPair.has(key)) {
        const id = `material-migrated-${materialProfiles.length + 1}`;
        materialProfiles.push({ id, name, thicknessMm });
        profileIdByPair.set(key, id);
      }
      return profileIdByPair.get(key);
    };
    const items = (Array.isArray(draft.items) ? draft.items : []).map((rawItem) => {
      const oldItem = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const { material, thicknessMm, grainDirection, edgeBand, edgeThickness, edgeMaterialType, edges, ...rest } = oldItem;
      const originalEdgeCode = edgeCodeFromData(oldItem);
      const rotateToGrain = grainDirection === 'width';
      return {
        ...rest,
        materialId: getMaterialId(oldItem),
        lengthMm: rotateToGrain ? oldItem.widthMm : oldItem.lengthMm,
        widthMm: rotateToGrain ? oldItem.lengthMm : oldItem.widthMm,
        edgeCode: rotateToGrain ? swapEdgeCode(originalEdgeCode) : originalEdgeCode,
        edgeMaterialType: migrateEdgeMaterial(oldItem, originalEdgeCode)
      };
    });
    if (draft.flow === 'manual' && !materialProfiles.length) {
      const fallback = {
        material: draft.fields?.manual_material || '',
        thicknessMm: draft.fields?.manual_thickness || ''
      };
      getMaterialId(fallback);
    }
    return { ...draft, schemaVersion: 3, materialProfiles, items };
  }

  function migrateV3ToV4(draft) {
    if (draft?.schemaVersion !== 3) return draft;
    const fields = draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
    const previousSizeBasis = draft.flow === 'manual'
      ? fields.manual_size_basis
      : draft.flow === 'upload'
        ? fields.upload_size_basis
        : 'finished';
    if (previousSizeBasis !== 'finished') return null;
    return {
      ...draft,
      schemaVersion: 4,
      fields: {
        ...fields,
        manual_size_basis: 'finished',
        upload_size_basis: 'finished'
      }
    };
  }

  function splitLegacyEdgeMaterial(value) {
    const raw = String(value || '').trim();
    if (!raw) return { identifier: '', thicknessMm: '' };
    const thicknessMatch = raw.match(/(?:^|[·,;\s])([0-9]+(?:[.,][0-9]+)?)\s*mm\s*$/i);
    if (!thicknessMatch) return { identifier: raw, thicknessMm: '' };
    const identifier = raw
      .slice(0, thicknessMatch.index)
      .replace(/[·,;\s-]+$/u, '')
      .trim();
    return {
      identifier: identifier || 'Egyeztetendő élanyag',
      thicknessMm: canonicalThickness(thicknessMatch[1])
    };
  }

  function migrateV4ToV5(draft) {
    if (draft?.schemaVersion !== 4) return draft;
    const migrateItem = (rawItem) => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const legacy = splitLegacyEdgeMaterial(item.edgeMaterialType);
      const { edgeMaterialType, ...rest } = item;
      return {
        ...rest,
        edgeCode: edgeCodeFromData(item),
        edgeThicknessMm: item.edgeThicknessMm || legacy.thicknessMm,
        edgeMaterialIdentifier: item.edgeMaterialIdentifier || legacy.identifier,
        edgeCode2: item.edgeCode2 || '',
        edgeThicknessMm2: item.edgeThicknessMm2 || '',
        edgeMaterialIdentifier2: item.edgeMaterialIdentifier2 || ''
      };
    };
    const items = (Array.isArray(draft.items) ? draft.items : []).map(migrateItem);
    const composerItem = draft.composerItem && typeof draft.composerItem === 'object' ? migrateItem(draft.composerItem) : draft.composerItem;
    return { ...draft, schemaVersion: 5, items, composerItem };
  }

  function migrateDraft(draft) {
    let migrated = draft;
    if (migrated?.schemaVersion === 1) migrated = migrateV1ToV2(migrated);
    if (migrated?.schemaVersion === 2) migrated = migrateV2ToV3(migrated);
    if (migrated?.schemaVersion === 3) migrated = migrateV3ToV4(migrated);
    if (migrated?.schemaVersion === 4) migrated = migrateV4ToV5(migrated);
    return migrated;
  }

  function isValidDraft(draft) {
    const updatedAt = Date.parse(draft?.updatedAt);
    const validStep = Number.isInteger(Number(draft?.stepIndex))
      && Number(draft.stepIndex) >= 0
      && Number(draft.stepIndex) < (FLOW_STEPS[draft?.flow]?.length || 0);
    const materials = draft?.materialProfiles;
    const items = draft?.items;
    const validMaterials = Array.isArray(materials)
      && materials.every((material) => material && typeof material === 'object' && typeof material.id === 'string' && material.id.trim());
    const uniqueMaterialIds = validMaterials && new Set(materials.map((material) => material.id)).size === materials.length;
    const validItems = Array.isArray(items) && items.every((item) => item && typeof item === 'object');
    const validManualCollections = draft?.flow !== 'manual' || (validMaterials && materials.length > 0 && validItems);
    return Boolean(draft)
      && draft.schemaVersion === 5
      && draft.fields?.manual_size_basis === 'finished'
      && draft.fields?.upload_size_basis === 'finished'
      && Boolean(FLOW_STEPS[draft.flow])
      && Number.isFinite(updatedAt)
      && Date.now() - updatedAt <= DRAFT_MAX_AGE
      && Date.now() >= updatedAt
      && validStep
      && validMaterials
      && uniqueMaterialIds
      && validItems
      && validManualCollections;
  }

  function readDraft() {
    for (const key of [DRAFT_KEY, V4_DRAFT_KEY, V3_DRAFT_KEY, V2_DRAFT_KEY, V1_DRAFT_KEY]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const draft = migrateDraft(JSON.parse(raw));
        if (!isValidDraft(draft)) {
          localStorage.removeItem(key);
          continue;
        }
        if (key !== DRAFT_KEY) localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        localStorage.removeItem(V4_DRAFT_KEY);
        localStorage.removeItem(V3_DRAFT_KEY);
        localStorage.removeItem(V2_DRAFT_KEY);
        localStorage.removeItem(V1_DRAFT_KEY);
        return draft;
      } catch (_) {
        localStorage.removeItem(key);
      }
    }
    return null;
  }

  function applyDraft(draft) {
    form.reset();
    editingItemId = null;
    composerDirty = false;
    itemComposer.classList.remove('editing');
    itemComposerTitle.textContent = 'Elem hozzáadása';
    saveItemButton.textContent = '+ Elem hozzáadása';
    cancelItemEditButton.hidden = true;
    files = { upload: [], help: [] };
    submissionToken = isUuid(draft.submissionToken) ? draft.submissionToken : createSubmissionToken();
    Object.entries(draft.fields || {}).forEach(([name, value]) => {
      if (name === 'manual_size_basis' || name === 'upload_size_basis') return;
      setFieldValue(name, value);
    });
    setFieldValue('manual_size_basis', 'finished');
    setFieldValue('upload_size_basis', 'finished');
    document.querySelector('#privacy-consent').checked = Boolean(draft.fields?.privacy_consent);
    materialList.innerHTML = '';
    itemList.innerHTML = '';
    const materialsToRestore = draft.materialProfiles?.length ? draft.materialProfiles : draft.flow === 'manual' ? [{}] : [];
    const itemsToRestore = draft.items?.length ? draft.items : [];
    materialsToRestore.forEach((material) => newMaterial(material));
    itemsToRestore.forEach((item) => newItem(item));
    if (draft.flow === 'manual') {
      retainItemSettings.checked = draft.retainItemSettings !== false;
      const restoredComposer = draft.composerItem || { materialId: itemsToRestore.at(-1)?.materialId || '', quantity: 1 };
      const olderDraftHasInput = [restoredComposer.name, restoredComposer.lengthMm, restoredComposer.widthMm, restoredComposer.note, restoredComposer.edgeCode, restoredComposer.edgeCode2].some(Boolean)
        || (restoredComposer.quantity && String(restoredComposer.quantity) !== '1');
      setComposerItem(restoredComposer, { dirty: Boolean(draft.composerDirty ?? olderDraftHasInput) });
      if (draft.composerSecondEdgeActive && EDGE_CODES_WITH_MATERIAL.includes(restoredComposer.edgeCode)) {
        itemComposer.querySelector('[data-composer-edge="2"]').hidden = false;
        syncComposerEdges();
      }
      const restoredEditingCard = draft.composerEditingItemId ? document.getElementById(draft.composerEditingItemId) : null;
      editingItemId = restoredEditingCard ? restoredEditingCard.id : null;
      if (editingItemId) {
        const index = [...itemList.querySelectorAll('.item-card')].indexOf(restoredEditingCard) + 1;
        itemComposer.classList.add('editing');
        itemComposerTitle.textContent = `${index}. elem szerkesztése`;
        saveItemButton.textContent = 'Módosítás mentése';
        cancelItemEditButton.hidden = false;
      }
    }
    restoredFilesMeta = { upload: Array.isArray(draft.filesMeta?.upload) ? draft.filesMeta.upload : [], help: Array.isArray(draft.filesMeta?.help) ? draft.filesMeta.help : [] };
    renderFiles('upload');
    renderFiles('help');
    const delivery = fieldValue('fulfillment') === 'delivery';
    document.querySelector('#postcode-field').hidden = !delivery;
    document.querySelector('#postal-code').required = delivery;
    if (delivery) document.querySelector('#postal-code').setAttribute('aria-required', 'true');
    else document.querySelector('#postal-code').removeAttribute('aria-required');
    draftBanner.classList.remove('visible');
    startFlow(draft.flow, draft);
  }

  restoredDraft = readDraft();
  if (restoredDraft) {
    draftTime.textContent = `Utolsó mentés: ${new Intl.DateTimeFormat('hu-HU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(restoredDraft.updatedAt))}`;
    draftBanner.classList.add('visible');
  }
  document.querySelector('#restore-draft').addEventListener('click', () => applyDraft(restoredDraft));
  document.querySelector('#delete-draft').addEventListener('click', () => {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(V4_DRAFT_KEY);
    localStorage.removeItem(V3_DRAFT_KEY);
    localStorage.removeItem(V2_DRAFT_KEY);
    localStorage.removeItem(V1_DRAFT_KEY);
    restoredDraft = null;
    submissionToken = createSubmissionToken();
    draftBanner.classList.remove('visible');
  });

  function clearDraftStorage() {
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(V4_DRAFT_KEY);
    localStorage.removeItem(V3_DRAFT_KEY);
    localStorage.removeItem(V2_DRAFT_KEY);
    localStorage.removeItem(V1_DRAFT_KEY);
  }

  function buildMultipartBody(payload, token, honeypotValue, attachments) {
    const body = new FormData();
    body.append('payload', JSON.stringify(payload));
    body.append('submission_token', token);
    body.append('company_website', cleanText(honeypotValue));
    attachments.forEach((file) => body.append('attachments', file, file.name));
    return body;
  }

  async function readJsonResponse(response) {
    try {
      return await response.json();
    } catch (_) {
      return null;
    }
  }

  function setSubmitting(submitting) {
    isSubmitting = submitting;
    form.setAttribute('aria-busy', String(submitting));
    submitButton.disabled = submitting;
    backButton.disabled = submitting;
    document.querySelector('#change-flow').disabled = submitting;
    submitButton.textContent = submitting ? 'Küldés folyamatban…' : 'Ajánlatkérés elküldése';
  }

  function showSuccessfulSubmission(reference, reviewHtml) {
    document.querySelector('#submission-reference').textContent = reference;
    document.querySelector('#success-review').innerHTML = reviewHtml;
    clearTimeout(saveTimer);
    saveTimer = null;
    clearDraftStorage();
    restoredDraft = null;
    submissionToken = createSubmissionToken();
    activeFlow = null;
    document.body.classList.remove('manual-workspace');
    wizard.classList.remove('active');
    successPanel.classList.add('active');
    history.replaceState(null, '', location.pathname);
    successPanel.focus();
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!activeFlow || isSubmitting) return;
    const steps = FLOW_STEPS[activeFlow];
    if (stepIndex !== steps.length - 1) {
      nextButton.click();
      return;
    }
    for (let index = 0; index < steps.length - 1; index += 1) {
      const errors = validateStep(steps[index], false);
      if (errors.length) {
        stepIndex = index;
        updateStep();
        validateStep(steps[index], true);
        return;
      }
    }
    clearTimeout(saveTimer);
    saveTimer = null;
    saveDraft();

    const flowAtSubmission = activeFlow;
    const payload = buildSubmissionPayload({
      flow: flowAtSubmission,
      fields: collectSubmissionFields(),
      materials: flowAtSubmission === 'manual' ? readMaterials() : [],
      items: flowAtSubmission === 'manual' ? readItems() : []
    });
    const attachments = flowAtSubmission === 'upload' ? files.upload : flowAtSubmission === 'help' ? files.help : [];
    const multipartBody = buildMultipartBody(payload, submissionToken, fieldValue('company_website'), attachments);
    const reviewHtml = document.querySelector('#review-list').innerHTML;

    setSubmitFeedback('Az ajánlatkérés küldése folyamatban van…', 'info');
    setSubmitting(true);
    try {
      const response = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: multipartBody
      });
      const responseBody = await readJsonResponse(response);
      const reference = cleanText(responseBody?.reference);
      if (!response.ok || responseBody?.ok !== true || !reference) {
        if (response.status === 409 || responseBody?.code === 'submission-token-conflict') {
          submissionToken = createSubmissionToken();
          saveDraft();
        }
        const message = submissionErrorMessage(response.status || 500, responseBody, response.headers.get('Retry-After'));
        setSubmitFeedback(message, 'error');
        submitFeedback.focus();
        return;
      }
      showSuccessfulSubmission(reference, reviewHtml);
    } catch (_) {
      setSubmitFeedback('Nem sikerült kapcsolódni az ajánlatkérőhöz. Az adatai megmaradtak; ellenőrizze az internetkapcsolatát, majd próbálja újra.', 'error');
      submitFeedback.focus();
    } finally {
      setSubmitting(false);
    }
  });

  document.querySelector('#print-summary').addEventListener('click', () => window.print());
  document.querySelector('#new-request').addEventListener('click', () => {
    form.reset();
    materialList.innerHTML = '';
    itemList.innerHTML = '';
    resetItemComposer();
    files = { upload: [], help: [] };
    restoredFilesMeta = { upload: [], help: [] };
    renderFiles('upload'); renderFiles('help');
    document.querySelector('#postcode-field').hidden = true;
    document.querySelector('#postal-code').required = false;
    document.querySelector('#success-review').innerHTML = '';
    document.querySelector('#submission-reference').textContent = '';
    submissionToken = createSubmissionToken();
    setSubmitFeedback();
    returnToChoice();
  });

  const requestedFlow = new URLSearchParams(location.search).get('ut');
  if (!restoredDraft && FLOW_STEPS[requestedFlow]) startFlow(requestedFlow);
})();

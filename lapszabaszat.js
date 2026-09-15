(() => {
  'use strict';

  const DRAFT_KEY = 'hepa_cutting_quote_draft_v2';
  const LEGACY_DRAFT_KEY = 'hepa_cutting_quote_draft_v1';
  const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const FLOW_STEPS = {
    upload: ['details', 'logistics', 'contact', 'review'],
    manual: ['items', 'logistics', 'contact', 'review'],
    help: ['details', 'contact', 'review']
  };
  const STEP_NAMES = {
    details: 'Az ajánlat tartalma',
    items: 'Alkatrészek',
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
  const SIZE_BASIS_NAMES = {
    finished: 'Készméret, éllel együtt',
    cut: 'Vágási méret, él nélkül',
    unknown: 'Nem vagyok benne biztos'
  };
  const HELP_TOPIC_NAMES = {
    material: 'Anyag vagy dekor',
    size: 'Méretek és szabászjegyzék',
    edge: 'ABS élzárás',
    delivery: 'Átvétel vagy szállítás'
  };
  const GRAIN_NAMES = { length: 'a hossz irányában', width: 'a szélesség irányában', none: 'mindegy / nincs szálirány' };
  const EDGE_BAND_NAMES = { matching: 'dekorazonos ABS', different: 'eltérő színű ABS', customer: 'hozott élanyag', unknown: 'egyeztetendő' };
  const EDGE_CODES = ['0-0', '0-1', '0-2', '1-0', '1-1', '1-2', '2-0', '2-1', '2-2'];
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
  const itemList = document.querySelector('#item-list');
  const itemSummary = document.querySelector('#items-summary');
  const draftBanner = document.querySelector('#draft-banner');
  const draftTime = document.querySelector('#draft-time');

  let activeFlow = null;
  let stepIndex = 0;
  let itemCounter = 0;
  let saveTimer = null;
  let restoredDraft = null;
  let files = { upload: [], help: [] };
  let restoredFilesMeta = { upload: [], help: [] };

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

  function allowedFile(file, flow) {
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const uploadExtensions = ['xlsx', 'xls', 'csv', 'pdf', 'jpg', 'jpeg', 'png'];
    const helpExtensions = ['pdf', 'jpg', 'jpeg', 'png'];
    return (flow === 'upload' ? uploadExtensions : helpExtensions).includes(extension);
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
    const accepted = [];
    const messages = [];
    [...incoming].forEach((file) => {
      if (!allowedFile(file, flow)) messages.push(`${file.name}: nem támogatott formátum.`);
      else if (file.size === 0) messages.push(`${file.name}: a fájl üres.`);
      else if (file.size > MAX_FILE_SIZE) messages.push(`${file.name}: nagyobb 10 MB-nál.`);
      else accepted.push(file);
    });
    const slots = Math.max(0, MAX_FILES - files[flow].length);
    if (accepted.length > slots) messages.push(`Legfeljebb ${MAX_FILES} fájl választható.`);
    if (accepted.length) restoredFilesMeta[flow] = [];
    files[flow].push(...accepted.slice(0, slots));
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

  function edgePreviewMarkup(code, extraClass = '') {
    const [longEdges, shortEdges] = edgeCodeParts(code);
    return `<span class="part l-${longEdges} s-${shortEdges} ${extraClass}" aria-hidden="true"><i class="top"></i><i class="right"></i><i class="bottom"></i><i class="left"></i></span>`;
  }

  function newItem(data = {}) {
    itemCounter += 1;
    const id = `item-${Date.now()}-${itemCounter}`;
    const edgeCode = edgeCodeFromData(data);
    const edgeBand = legacyEdgeBandValue(data.edgeBand);
    const card = document.createElement('article');
    card.className = 'item-card';
    card.id = id;
    card.tabIndex = -1;
    card.dataset.itemId = id;
    card.innerHTML = `
      <h3 class="sr-only"><span class="item-number-a11y"></span>. szabászjegyzék-tétel</h3>
      <div class="item-main-grid">
        <div class="item-index"><span>Tétel</span><strong class="item-number"></strong></div>
        <div class="field item-name"><label for="${id}-name">Megnevezés</label><input id="${id}-name" data-item-field="name" type="text" maxlength="100" value="${escapeHtml(data.name)}" placeholder="Pl. oldallap"></div>
        <div class="field item-material"><label class="required" for="${id}-material">Anyag / dekor</label><input id="${id}-material" data-item-field="material" type="text" required aria-required="true" maxlength="120" value="${escapeHtml(data.material)}" placeholder="Pl. Egger H3303"></div>
        <div class="field item-thickness"><label class="required" for="${id}-thickness">Vastagság</label><input id="${id}-thickness" data-item-field="thicknessMm" type="number" required aria-required="true" min="1" max="100" step="0.1" inputmode="decimal" value="${escapeHtml(data.thicknessMm)}" placeholder="18"><span class="input-unit">mm</span></div>
        <div class="field item-length"><label class="required" for="${id}-length">Hossz</label><input id="${id}-length" data-item-field="lengthMm" type="number" required aria-required="true" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.lengthMm)}" placeholder="800"><span class="input-unit">mm</span></div>
        <div class="field item-width"><label class="required" for="${id}-width">Szélesség</label><input id="${id}-width" data-item-field="widthMm" type="number" required aria-required="true" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.widthMm)}" placeholder="400"><span class="input-unit">mm</span></div>
        <div class="field item-quantity"><label class="required" for="${id}-quantity">Darab</label><input id="${id}-quantity" data-item-field="quantity" type="number" required aria-required="true" min="1" max="999" step="1" inputmode="numeric" value="${escapeHtml(data.quantity ?? 1)}"></div>
        <div class="field item-edge-code"><label class="required" for="${id}-edge-code">Élkód</label><div class="edge-code-control"><select id="${id}-edge-code" data-item-field="edgeCode" required aria-required="true"><option value="">Válasszon...</option>${EDGE_CODES.map((code) => `<option value="${code}" ${edgeCode === code ? 'selected' : ''}>${code} · ${EDGE_CODE_NAMES[code]}</option>`).join('')}</select>${edgePreviewMarkup(edgeCode, 'edge-row-preview')}</div></div>
        <div class="item-actions">
          <button class="icon-button" type="button" data-item-action="duplicate">Másolás</button>
          <button class="icon-button delete" type="button" data-item-action="delete">Törlés</button>
        </div>
      </div>
      <details class="item-more">
        <summary>További adatok: szálirány, ABS és megjegyzés</summary>
        <div class="item-secondary-grid">
          <div class="field"><label class="required" for="${id}-grain">Szálirány</label><select id="${id}-grain" data-item-field="grainDirection" required aria-required="true"><option value="">Válasszon...</option><option value="length" ${data.grainDirection === 'length' ? 'selected' : ''}>Hossz irányában</option><option value="width" ${data.grainDirection === 'width' ? 'selected' : ''}>Szélesség irányában</option><option value="none" ${data.grainDirection === 'none' ? 'selected' : ''}>Mindegy / nincs</option></select></div>
          <div class="field"><label class="edge-required-label" for="${id}-edge-thickness">Élvastagság</label><select id="${id}-edge-thickness" data-item-field="edgeThickness"><option value="">Válasszon...</option><option value="0.4" ${data.edgeThickness === '0.4' ? 'selected' : ''}>0,4 mm</option><option value="0.6" ${data.edgeThickness === '0.6' ? 'selected' : ''}>0,6 mm</option><option value="1" ${data.edgeThickness === '1' ? 'selected' : ''}>1 mm</option><option value="2" ${data.edgeThickness === '2' ? 'selected' : ''}>2 mm</option><option value="other" ${data.edgeThickness === 'other' ? 'selected' : ''}>Más / egyeztetendő</option></select></div>
          <div class="field"><label class="edge-required-label" for="${id}-edge-band">ABS színe / dekorkódja</label><input id="${id}-edge-band" data-item-field="edgeBand" type="text" maxlength="120" value="${escapeHtml(edgeBand)}" placeholder="Pl. dekorazonos ABS vagy H3303"></div>
          <div class="field item-note"><label for="${id}-note">Megjegyzés</label><textarea id="${id}-note" data-item-field="note" maxlength="500" placeholder="Egyedi kérés vagy pontosítás">${escapeHtml(data.note)}</textarea></div>
        </div>
      </details>
      <p class="item-error" id="${id}-error" role="alert"></p>`;
    itemList.append(card);
    syncEdgeRequirements(card);
    renumberItems();
    return card;
  }

  function syncEdgeRequirements(card) {
    const edgeCodeControl = card.querySelector('[data-item-field="edgeCode"]');
    const edgeCode = edgeCodeControl?.value || '';
    const hasEdge = EDGE_CODES.includes(edgeCode) && edgeCode !== '0-0';
    const [longEdges, shortEdges] = edgeCodeParts(edgeCode);
    const preview = card.querySelector('.edge-row-preview');
    if (preview) preview.className = `part l-${longEdges} s-${shortEdges} edge-row-preview`;
    ['edgeBand', 'edgeThickness'].forEach((fieldName) => {
      const control = card.querySelector(`[data-item-field="${fieldName}"]`);
      control.required = hasEdge;
      control.disabled = !hasEdge;
      if (hasEdge) control.setAttribute('aria-required', 'true');
      else {
        control.removeAttribute('aria-required');
        control.value = '';
      }
      control.closest('.field').querySelector('.edge-required-label').classList.toggle('required', hasEdge);
    });
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
    [...itemList.querySelectorAll('.item-card')].forEach((card, index) => {
      card.querySelector('.item-number').textContent = String(index + 1);
      card.querySelector('.item-number-a11y').textContent = String(index + 1);
      const copyButton = card.querySelector('[data-item-action="duplicate"]');
      const deleteButton = card.querySelector('[data-item-action="delete"]');
      copyButton.setAttribute('aria-label', `${index + 1}. tétel másolása`);
      deleteButton.setAttribute('aria-label', `${index + 1}. tétel törlése`);
      deleteButton.disabled = itemList.children.length === 1;
    });
    updateItemSummary();
  }

  function itemTotals() {
    return readItems().reduce((totals, item) => {
      const meaningful = [item.name, item.material, item.thicknessMm, item.lengthMm, item.widthMm, item.grainDirection, item.edgeCode, item.edgeBand, item.edgeThickness, item.note].some(Boolean);
      if (!meaningful) return totals;
      const quantity = Number(item.quantity) || 0;
      const length = Number(item.lengthMm) || 0;
      const width = Number(item.widthMm) || 0;
      const [longEdges, shortEdges] = edgeCodeParts(item.edgeCode);
      totals.rows += 1;
      totals.pieces += quantity;
      totals.area += quantity * length * width / 1_000_000;
      totals.edge += quantity * (longEdges * length + shortEdges * width) / 1000;
      return totals;
    }, { rows: 0, pieces: 0, area: 0, edge: 0 });
  }

  function updateItemSummary() {
    const totals = itemTotals();
    itemSummary.textContent = `${totals.rows} tétel · ${totals.pieces} darab · ${totals.area.toFixed(2)} m² · kb. ${totals.edge.toFixed(1)} fm él`;
  }

  document.querySelector('#add-item').addEventListener('click', () => {
    const previous = readItems().at(-1) || {};
    const card = newItem({ material: previous.material, thicknessMm: previous.thicknessMm, quantity: 1, grainDirection: previous.grainDirection, edgeCode: previous.edgeCode, edgeBand: previous.edgeBand, edgeThickness: previous.edgeThickness });
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector(previous.material ? '[data-item-field="name"]' : '[data-item-field="material"]').focus();
    queueSave();
  });

  itemList.addEventListener('click', (event) => {
    const card = event.target.closest('.item-card');
    if (!card) return;
    const action = event.target.closest('[data-item-action]')?.dataset.itemAction;
    if (action === 'duplicate') {
      const clone = newItem({ ...readItem(card), id: undefined });
      card.after(clone); renumberItems(); queueSave();
    } else if (action === 'delete' && itemList.children.length > 1) {
      card.remove(); renumberItems(); queueSave();
    }
  });
  itemList.addEventListener('input', () => { updateItemSummary(); queueSave(); });
  itemList.addEventListener('change', (event) => {
    const card = event.target.closest('.item-card');
    if (card && event.target.matches('[data-item-field="edgeCode"]')) syncEdgeRequirements(card);
    updateItemSummary();
    queueSave();
  });

  function clearErrors() {
    errorSummary.classList.remove('visible');
    errorList.innerHTML = '';
    form.querySelectorAll('.field-error').forEach((node) => { if (!node.id.endsWith('files-error')) node.textContent = ''; });
    form.querySelectorAll('[aria-invalid="true"]').forEach((node) => node.removeAttribute('aria-invalid'));
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
      if (!files.upload.length) addError(errors, 'upload-files', 'Válasszon ki legalább egy szabászjegyzéket.', 'upload-files-error');
      if (!fieldValue('upload_material_source')) addError(errors, 'upload-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'upload-material-source-error');
      const uploadThickness = fieldValue('upload_thickness');
      if (uploadThickness && (Number(uploadThickness) < 1 || Number(uploadThickness) > 100)) addError(errors, 'upload-thickness', 'Adjon meg 1 és 100 mm közötti vastagságot.');
    }
    if (activeFlow === 'help') {
      if (!fieldValue('help_topics').length) addError(errors, 'help-material', 'Válasszon legalább egy témát.', 'help-topics-error');
      const description = fieldValue('help_description');
      if (description.length < 20) addError(errors, 'help-description', 'Írja le legalább 20 karakterben, miben kér segítséget.');
    }
  }

  function validateItems(errors) {
    if (!fieldValue('manual_material_source')) addError(errors, 'manual-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'manual-material-source-error');
    if (!fieldValue('manual_size_basis')) addError(errors, 'manual-size-finished', 'Jelölje meg, milyen méretet ad meg.', 'manual-size-basis-error');
    const cards = [...itemList.querySelectorAll('.item-card')];
    if (!cards.length) {
      errors.push({ id: 'add-item', message: 'Vegyen fel legalább egy tételt.' });
      return;
    }
    cards.forEach((card, index) => {
      const item = readItem(card);
      const messages = [];
      const invalidControls = [];
      const mark = (field, label) => {
        messages.push(label);
        const control = card.querySelector(`[data-item-field="${field}"]`);
        if (control) invalidControls.push(control);
      };
      if (item.material.length < 2) mark('material', 'anyag/dekor');
      const thickness = Number(item.thicknessMm);
      if (!thickness || thickness < 1 || thickness > 100) mark('thicknessMm', 'vastagság');
      const length = Number(item.lengthMm);
      if (!length || length < 10 || length > 5000) mark('lengthMm', 'hossz');
      const width = Number(item.widthMm);
      if (!width || width < 10 || width > 5000) mark('widthMm', 'szélesség');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) mark('quantity', 'darabszám');
      if (!item.grainDirection) mark('grainDirection', 'szálirány');
      if (!EDGE_CODES.includes(item.edgeCode)) mark('edgeCode', 'élkód');
      const hasEdge = EDGE_CODES.includes(item.edgeCode) && item.edgeCode !== '0-0';
      if (hasEdge && !item.edgeBand) mark('edgeBand', 'ABS színe / dekorkódja');
      if (hasEdge && !item.edgeThickness) mark('edgeThickness', 'élvastagság');
      if (messages.length) {
        card.classList.add('invalid');
        card.querySelector('.item-more').open = true;
        const errorId = `${card.id}-error`;
        card.querySelector('.item-error').textContent = `Ellenőrizze: ${messages.join(', ')}.`;
        invalidControls.forEach((control) => {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', errorId);
        });
        errors.push({ id: invalidControls[0]?.id || card.id, message: `${index + 1}. tétel: ${messages.join(', ')}.` });
      }
    });
  }

  function validateLogistics(errors) {
    const fulfillment = fieldValue('fulfillment');
    if (!fulfillment) addError(errors, 'fulfillment-pickup', 'Válassza ki az átvétel módját.', 'fulfillment-error');
    if (fulfillment === 'delivery' && !/^\d{4}$/.test(fieldValue('postal_code'))) addError(errors, 'postal-code', 'Adja meg a 4 számjegyű irányítószámot.');
    const target = fieldValue('target_date');
    if (target) {
      const selected = new Date(`${target}T12:00:00`);
      const today = new Date(); today.setHours(0,0,0,0);
      if (selected < today) addError(errors, 'target-date', 'A kívánt dátum nem lehet korábbi a mai napnál.');
    }
  }

  function validateContact(errors) {
    const name = fieldValue('customer_name');
    const email = fieldValue('customer_email');
    const phone = fieldValue('customer_phone');
    const phoneDigits = phone.replace(/\D/g, '');
    if (name.length < 2) addError(errors, 'customer-name', 'Adja meg a nevét legalább 2 karakterben.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) addError(errors, 'customer-email', 'Adjon meg érvényes e-mail címet.');
    if (phone && (phoneDigits.length < 7 || phoneDigits.length > 15)) addError(errors, 'customer-phone', 'Adjon meg érvényes telefonszámot.');
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

  function seedFirstItem() {
    const first = itemList.querySelector('.item-card');
    if (!first) return newItem({ quantity: 1 });
    return first;
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
        ['Méretértelmezés', SIZE_BASIS_NAMES[fieldValue('upload_size_basis')]],
        ['Megjegyzés', fieldValue('upload_note')]
      ]));
    } else if (activeFlow === 'manual') {
      cards.push(reviewCard('Munka alapadatai', 'items', [
        ['Beküldési mód', FLOW_NAMES.manual],
        ['Anyag biztosítása', MATERIAL_SOURCE_NAMES[fieldValue('manual_material_source')]],
        ['Méretértelmezés', SIZE_BASIS_NAMES[fieldValue('manual_size_basis')]]
      ]));
      const totals = itemTotals();
      const items = readItems().map((item, index) => {
        const edgeData = item.edgeCode === '0-0'
          ? 'élkód: 0-0, élzárás nélkül'
          : `élkód: ${item.edgeCode} (${EDGE_CODE_NAMES[item.edgeCode] || 'egyeztetendő'}); ${item.edgeBand || 'élanyag egyeztetendő'}, ${item.edgeThickness === 'other' ? 'egyedi élvastagság' : `${item.edgeThickness} mm`}`;
        return `${index + 1}. ${item.name || 'Névtelen tétel'} – ${item.material}, ${item.thicknessMm} mm; ${item.lengthMm} × ${item.widthMm} mm, ${item.quantity} db; szálirány: ${GRAIN_NAMES[item.grainDirection] || 'egyeztetendő'}; ${edgeData}${item.note ? `; megjegyzés: ${item.note}` : ''}`;
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
    if (activeStep === 'items') seedFirstItem();
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
    activeFlow = flow;
    const requestedStep = Number(draft?.stepIndex);
    stepIndex = Number.isInteger(requestedStep) && requestedStep >= 0 && requestedStep < FLOW_STEPS[flow].length ? requestedStep : 0;
    flowChoice.style.display = 'none';
    wizard.classList.add('active');
    successPanel.classList.remove('active');
    document.body.classList.toggle('manual-workspace', flow === 'manual');
    document.querySelectorAll('[data-flow-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.flowPanel === flow));
    if (flow === 'manual' && !itemList.children.length) newItem({ quantity: 1 });
    updateStep();
  }

  function returnToChoice() {
    wizard.classList.remove('active');
    successPanel.classList.remove('active');
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
      schemaVersion: 2,
      flow: activeFlow,
      stepIndex,
      fields,
      items: readItems(),
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
      localStorage.removeItem(LEGACY_DRAFT_KEY);
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

  function migrateLegacyDraft(draft) {
    if (draft?.schemaVersion !== 1) return draft;
    const legacyMaterial = draft.fields?.manual_material || '';
    const legacyThickness = draft.fields?.manual_thickness || '';
    const items = Array.isArray(draft.items) ? draft.items.map((item) => ({
      ...item,
      material: item.material || legacyMaterial,
      thicknessMm: item.thicknessMm || legacyThickness,
      edgeCode: edgeCodeFromData(item)
    })) : [];
    let migratedStep = Number(draft.stepIndex) || 0;
    if (draft.flow === 'manual') migratedStep = migratedStep <= 1 ? 0 : migratedStep - 1;
    return { ...draft, schemaVersion: 2, stepIndex: migratedStep, items };
  }

  function readDraft() {
    try {
      const currentRaw = localStorage.getItem(DRAFT_KEY);
      const legacyRaw = currentRaw ? null : localStorage.getItem(LEGACY_DRAFT_KEY);
      const draft = migrateLegacyDraft(JSON.parse(currentRaw || legacyRaw));
      const updatedAt = Date.parse(draft?.updatedAt);
      const validStep = Number.isInteger(Number(draft?.stepIndex)) && Number(draft.stepIndex) >= 0 && Number(draft.stepIndex) < (FLOW_STEPS[draft?.flow]?.length || 0);
      if (!draft || draft.schemaVersion !== 2 || !FLOW_STEPS[draft.flow] || !Number.isFinite(updatedAt) || Date.now() - updatedAt > DRAFT_MAX_AGE || Date.now() < updatedAt || !validStep || (draft.items && !Array.isArray(draft.items))) {
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(LEGACY_DRAFT_KEY);
        return null;
      }
      if (legacyRaw) {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }
      return draft;
    } catch (_) {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(LEGACY_DRAFT_KEY);
      return null;
    }
  }

  function applyDraft(draft) {
    Object.entries(draft.fields || {}).forEach(([name, value]) => setFieldValue(name, value));
    document.querySelector('#privacy-consent').checked = Boolean(draft.fields?.privacy_consent);
    itemList.innerHTML = '';
    (draft.items?.length ? draft.items : [{}]).forEach((item) => newItem(item));
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
    localStorage.removeItem(LEGACY_DRAFT_KEY);
    restoredDraft = null;
    draftBanner.classList.remove('visible');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!activeFlow) return;
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
    const now = new Date();
    const date = now.toISOString().slice(0, 10).replaceAll('-', '');
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    document.querySelector('#demo-reference').textContent = `DEMO-${date}-${suffix}`;
    document.querySelector('#success-review').innerHTML = document.querySelector('#review-list').innerHTML;
    clearTimeout(saveTimer);
    saveTimer = null;
    localStorage.removeItem(DRAFT_KEY);
    localStorage.removeItem(LEGACY_DRAFT_KEY);
    activeFlow = null;
    document.body.classList.remove('manual-workspace');
    wizard.classList.remove('active');
    successPanel.classList.add('active');
    successPanel.focus();
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
  });

  document.querySelector('#print-summary').addEventListener('click', () => window.print());
  document.querySelector('#new-request').addEventListener('click', () => {
    form.reset();
    itemList.innerHTML = '';
    files = { upload: [], help: [] };
    restoredFilesMeta = { upload: [], help: [] };
    renderFiles('upload'); renderFiles('help');
    document.querySelector('#postcode-field').hidden = true;
    document.querySelector('#postal-code').required = false;
    document.querySelector('#success-review').innerHTML = '';
    returnToChoice();
  });

  const requestedFlow = new URLSearchParams(location.search).get('ut');
  if (!restoredDraft && FLOW_STEPS[requestedFlow]) startFlow(requestedFlow);
})();

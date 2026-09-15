(() => {
  'use strict';

  const DRAFT_KEY = 'hepa_cutting_quote_draft_v1';
  const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
  const MAX_FILES = 5;
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const FLOW_STEPS = {
    upload: ['details', 'logistics', 'contact', 'review'],
    manual: ['details', 'items', 'logistics', 'contact', 'review'],
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

  const menuButton = document.querySelector('.menu-toggle');
  const menu = document.querySelector('.main-nav');
  menuButton?.addEventListener('click', () => {
    const open = menu.classList.toggle('open');
    menuButton.setAttribute('aria-expanded', String(open));
    menuButton.setAttribute('aria-label', open ? 'Menü bezárása' : 'Menü megnyitása');
    menuButton.textContent = open ? '×' : '☰';
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

  function renderFiles(flow, restoredMeta = null) {
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

  function newItem(data = {}) {
    itemCounter += 1;
    const id = data.id || `item-${Date.now()}-${itemCounter}`;
    const edges = data.edges || { A: false, B: false, C: false, D: false };
    const card = document.createElement('article');
    card.className = 'item-card';
    card.id = id;
    card.dataset.itemId = id;
    card.innerHTML = `
      <div class="item-head">
        <h3>Tétel <span class="item-number"></span></h3>
        <div class="item-actions">
          <button class="icon-button" type="button" data-item-action="duplicate">Másolás</button>
          <button class="icon-button delete" type="button" data-item-action="delete">Törlés</button>
        </div>
      </div>
      <div class="item-body">
        <div class="field-grid three">
          <div class="field full"><label for="${id}-name">Alkatrész neve – opcionális</label><input id="${id}-name" data-item-field="name" type="text" maxlength="100" value="${escapeHtml(data.name)}" placeholder="Pl. oldallap vagy polc"></div>
          <div class="field"><label class="required" for="${id}-material">Anyag / dekor</label><input id="${id}-material" data-item-field="material" type="text" maxlength="120" value="${escapeHtml(data.material)}" placeholder="Pl. Egger H3303"></div>
          <div class="field"><label class="required" for="${id}-thickness">Vastagság (mm)</label><input id="${id}-thickness" data-item-field="thicknessMm" type="number" min="1" max="100" step="0.1" inputmode="decimal" value="${escapeHtml(data.thicknessMm)}" placeholder="18"></div>
          <div class="field"><label class="required" for="${id}-quantity">Darabszám</label><input id="${id}-quantity" data-item-field="quantity" type="number" min="1" max="999" step="1" inputmode="numeric" value="${escapeHtml(data.quantity || 1)}"></div>
          <div class="field"><label class="required" for="${id}-length">Hossz (mm)</label><input id="${id}-length" data-item-field="lengthMm" type="number" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.lengthMm)}" placeholder="800"></div>
          <div class="field"><label class="required" for="${id}-width">Szélesség (mm)</label><input id="${id}-width" data-item-field="widthMm" type="number" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.widthMm)}" placeholder="400"></div>
          <div class="field"><label class="required" for="${id}-grain">Szálirány</label><select id="${id}-grain" data-item-field="grainDirection"><option value="">Válasszon...</option><option value="length" ${data.grainDirection === 'length' ? 'selected' : ''}>A hossz irányában</option><option value="width" ${data.grainDirection === 'width' ? 'selected' : ''}>A szélesség irányában</option><option value="none" ${data.grainDirection === 'none' ? 'selected' : ''}>Mindegy / nincs szálirány</option></select></div>
        </div>
        <div class="edge-editor">
          <div>
            <span class="fieldset-label">Élzárandó oldalak</span>
            <div class="edge-diagram" aria-label="Élzárandó oldalak kiválasztása">
              ${['A','B','C','D'].map((edge) => `<button class="edge-control edge-${edge.toLowerCase()}" type="button" data-edge="${edge}" aria-pressed="${Boolean(edges[edge])}" aria-label="${edge} oldal ${edges[edge] ? 'élzárt' : 'nincs élzárva'}">${edge}</button>`).join('')}
              <span class="dimension-x">Hossz</span><span class="dimension-y">Szélesség</span>
            </div>
            <div class="edge-presets"><button type="button" data-edge-preset="none">Nincs él</button><button type="button" data-edge-preset="long">A + B</button><button type="button" data-edge-preset="all">Mind a négy</button></div>
          </div>
          <div class="edge-fields">
            <div class="field"><label for="${id}-edge-band">Élanyag</label><select id="${id}-edge-band" data-item-field="edgeBand"><option value="">Nincs / még nem tudom</option><option value="matching" ${data.edgeBand === 'matching' ? 'selected' : ''}>Dekorazonos ABS</option><option value="different" ${data.edgeBand === 'different' ? 'selected' : ''}>Eltérő színű ABS</option><option value="customer" ${data.edgeBand === 'customer' ? 'selected' : ''}>Saját élanyagot hozok</option><option value="unknown" ${data.edgeBand === 'unknown' ? 'selected' : ''}>Segítséget kérek</option></select></div>
            <div class="field"><label for="${id}-edge-thickness">Élvastagság</label><select id="${id}-edge-thickness" data-item-field="edgeThickness"><option value="">Nincs / még nem tudom</option><option value="0.4" ${data.edgeThickness === '0.4' ? 'selected' : ''}>0,4 mm</option><option value="0.6" ${data.edgeThickness === '0.6' ? 'selected' : ''}>0,6 mm</option><option value="1" ${data.edgeThickness === '1' ? 'selected' : ''}>1 mm</option><option value="2" ${data.edgeThickness === '2' ? 'selected' : ''}>2 mm</option><option value="other" ${data.edgeThickness === 'other' ? 'selected' : ''}>Más / egyeztetendő</option></select></div>
            <div class="field"><label for="${id}-note">Tétel megjegyzése</label><textarea id="${id}-note" data-item-field="note" maxlength="500" placeholder="Egyedi kérés vagy pontosítás">${escapeHtml(data.note)}</textarea></div>
          </div>
        </div>
      </div>
      <p class="item-error"></p>`;
    itemList.append(card);
    renumberItems();
    return card;
  }

  function readItem(card) {
    const data = { id: card.dataset.itemId, edges: {} };
    card.querySelectorAll('[data-item-field]').forEach((control) => { data[control.dataset.itemField] = control.value.trim(); });
    card.querySelectorAll('[data-edge]').forEach((control) => { data.edges[control.dataset.edge] = control.getAttribute('aria-pressed') === 'true'; });
    return data;
  }

  function readItems() {
    return [...itemList.querySelectorAll('.item-card')].map(readItem);
  }

  function renumberItems() {
    [...itemList.querySelectorAll('.item-card')].forEach((card, index) => {
      card.querySelector('.item-number').textContent = String(index + 1);
      card.querySelector('[data-item-action="delete"]').disabled = itemList.children.length === 1;
    });
    updateItemSummary();
  }

  function itemTotals() {
    return readItems().reduce((totals, item) => {
      const quantity = Number(item.quantity) || 0;
      const length = Number(item.lengthMm) || 0;
      const width = Number(item.widthMm) || 0;
      const longEdges = Number(Boolean(item.edges.A)) + Number(Boolean(item.edges.B));
      const shortEdges = Number(Boolean(item.edges.C)) + Number(Boolean(item.edges.D));
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
    const card = newItem({ material: previous.material || fieldValue('manual_material'), thicknessMm: previous.thicknessMm || fieldValue('manual_thickness'), quantity: 1, grainDirection: previous.grainDirection || '' });
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('[data-item-field="name"]').focus();
    queueSave();
  });

  itemList.addEventListener('click', (event) => {
    const card = event.target.closest('.item-card');
    if (!card) return;
    const edge = event.target.closest('[data-edge]');
    if (edge) {
      const pressed = edge.getAttribute('aria-pressed') !== 'true';
      edge.setAttribute('aria-pressed', String(pressed));
      edge.setAttribute('aria-label', `${edge.dataset.edge} oldal ${pressed ? 'élzárt' : 'nincs élzárva'}`);
      updateItemSummary(); queueSave(); return;
    }
    const preset = event.target.closest('[data-edge-preset]');
    if (preset) {
      const mode = preset.dataset.edgePreset;
      card.querySelectorAll('[data-edge]').forEach((control) => {
        const pressed = mode === 'all' || (mode === 'long' && ['A','B'].includes(control.dataset.edge));
        control.setAttribute('aria-pressed', String(pressed));
        control.setAttribute('aria-label', `${control.dataset.edge} oldal ${pressed ? 'élzárt' : 'nincs élzárva'}`);
      });
      updateItemSummary(); queueSave(); return;
    }
    const action = event.target.closest('[data-item-action]')?.dataset.itemAction;
    if (action === 'duplicate') {
      const clone = newItem({ ...readItem(card), id: undefined });
      card.after(clone); renumberItems(); queueSave();
    } else if (action === 'delete' && itemList.children.length > 1) {
      card.remove(); renumberItems(); queueSave();
    }
  });
  itemList.addEventListener('input', () => { updateItemSummary(); queueSave(); });
  itemList.addEventListener('change', () => { updateItemSummary(); queueSave(); });

  function clearErrors() {
    errorSummary.classList.remove('visible');
    errorList.innerHTML = '';
    form.querySelectorAll('.field-error').forEach((node) => { if (!node.id.endsWith('files-error')) node.textContent = ''; });
    form.querySelectorAll('[aria-invalid="true"]').forEach((node) => node.removeAttribute('aria-invalid'));
    form.querySelectorAll('.item-card.invalid').forEach((node) => node.classList.remove('invalid'));
  }

  function addError(errors, controlId, message, errorId = `${controlId}-error`) {
    const control = document.getElementById(controlId);
    const messageNode = document.getElementById(errorId);
    if (control) {
      control.setAttribute('aria-invalid', 'true');
      control.setAttribute('aria-describedby', errorId);
    }
    if (messageNode) messageNode.textContent = message;
    errors.push({ id: controlId, message });
  }

  function validateDetails(errors) {
    if (activeFlow === 'upload') {
      if (!files.upload.length) addError(errors, 'upload-files', 'Válasszon ki legalább egy szabászjegyzéket.', 'upload-files-error');
      if (!fieldValue('upload_material_source')) addError(errors, 'upload-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'upload-material-source-error');
    }
    if (activeFlow === 'manual') {
      if (!fieldValue('manual_material_source')) addError(errors, 'manual-source-hepa', 'Jelölje meg, honnan legyen az anyag.', 'manual-material-source-error');
      const material = fieldValue('manual_material');
      if (material.length < 2) addError(errors, 'manual-material', 'Adja meg az anyagot, vagy írja be: „egyeztetést kérek”.');
      const thickness = Number(fieldValue('manual_thickness'));
      if (!thickness || thickness < 1 || thickness > 100) addError(errors, 'manual-thickness', 'Adjon meg 1 és 100 mm közötti vastagságot.');
      if (!fieldValue('manual_size_basis')) addError(errors, 'manual-size-finished', 'Jelölje meg, milyen méretet fog megadni.', 'manual-size-basis-error');
    }
    if (activeFlow === 'help') {
      if (!fieldValue('help_topics').length) addError(errors, 'help-material', 'Válasszon legalább egy témát.', 'help-topics-error');
      const description = fieldValue('help_description');
      if (description.length < 20) addError(errors, 'help-description', 'Írja le legalább 20 karakterben, miben kér segítséget.');
    }
  }

  function validateItems(errors) {
    const cards = [...itemList.querySelectorAll('.item-card')];
    if (!cards.length) {
      errors.push({ id: 'add-item', message: 'Vegyen fel legalább egy tételt.' });
      return;
    }
    cards.forEach((card, index) => {
      const item = readItem(card);
      const messages = [];
      if (item.material.length < 2) messages.push('anyag/dekor');
      const thickness = Number(item.thicknessMm);
      if (!thickness || thickness < 1 || thickness > 100) messages.push('vastagság');
      const length = Number(item.lengthMm);
      if (!length || length < 10 || length > 5000) messages.push('hossz');
      const width = Number(item.widthMm);
      if (!width || width < 10 || width > 5000) messages.push('szélesség');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) messages.push('darabszám');
      if (!item.grainDirection) messages.push('szálirány');
      const hasEdge = Object.values(item.edges).some(Boolean);
      if (hasEdge && (!item.edgeBand || !item.edgeThickness)) messages.push('élanyag és élvastagság');
      if (messages.length) {
        card.classList.add('invalid');
        card.querySelector('.item-error').textContent = `Ellenőrizze: ${messages.join(', ')}.`;
        errors.push({ id: card.id, message: `${index + 1}. tétel: ${messages.join(', ')}.` });
      }
    });
  }

  function validateLogistics(errors) {
    const fulfillment = fieldValue('fulfillment');
    if (!fulfillment) addError(errors, 'fulfillment-pickup', 'Válassza ki az átvétel módját.', 'fulfillment-error');
    if (fulfillment === 'delivery' && fieldValue('postal_code').length < 3) addError(errors, 'postal-code', 'Adja meg a szállítási irányítószámot.');
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
    const preferred = fieldValue('preferred_contact');
    if (preferred === 'email' && !email) addError(errors, 'customer-email', 'E-mailes kapcsolattartáshoz adja meg az e-mail címét.');
    if (preferred === 'phone' && !phone) addError(errors, 'customer-phone', 'Telefonos kapcsolattartáshoz adja meg a telefonszámát.');
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
    if (!first) return newItem({ material: fieldValue('manual_material'), thicknessMm: fieldValue('manual_thickness'), quantity: 1 });
    const material = first.querySelector('[data-item-field="material"]');
    const thickness = first.querySelector('[data-item-field="thicknessMm"]');
    if (!material.value) material.value = fieldValue('manual_material');
    if (!thickness.value) thickness.value = fieldValue('manual_thickness');
  }

  function reviewCard(title, step, rows) {
    return `<article class="review-card"><div class="review-head"><h3>${escapeHtml(title)}</h3><button class="review-edit" type="button" data-edit-step="${escapeHtml(step)}">Szerkesztés</button></div><dl>${rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value || 'Nincs megadva')}</dd>`).join('')}</dl></article>`;
  }

  function buildReview() {
    const review = document.querySelector('#review-list');
    const cards = [];
    if (activeFlow === 'upload') {
      cards.push(reviewCard('Szabászjegyzék', 'details', [
        ['Beküldési mód', FLOW_NAMES.upload],
        ['Fájlok', files.upload.map((file) => file.name).join(', ')],
        ['Anyag biztosítása', MATERIAL_SOURCE_NAMES[fieldValue('upload_material_source')]],
        ['Anyag / dekor', fieldValue('upload_material')],
        ['Vastagság', fieldValue('upload_thickness') ? `${fieldValue('upload_thickness')} mm` : 'A fájlban / egyeztetendő'],
        ['Méretértelmezés', SIZE_BASIS_NAMES[fieldValue('upload_size_basis')]]
      ]));
    } else if (activeFlow === 'manual') {
      cards.push(reviewCard('Anyag és méret', 'details', [
        ['Beküldési mód', FLOW_NAMES.manual],
        ['Anyag biztosítása', MATERIAL_SOURCE_NAMES[fieldValue('manual_material_source')]],
        ['Alapanyag / dekor', fieldValue('manual_material')],
        ['Vastagság', `${fieldValue('manual_thickness')} mm`],
        ['Méretértelmezés', SIZE_BASIS_NAMES[fieldValue('manual_size_basis')]]
      ]));
      const totals = itemTotals();
      const items = readItems().map((item, index) => {
        const edges = Object.entries(item.edges).filter(([, selected]) => selected).map(([edge]) => edge).join(', ') || 'nincs';
        return `${index + 1}. ${item.name || 'Névtelen tétel'} – ${item.lengthMm} × ${item.widthMm} mm, ${item.quantity} db, élek: ${edges}`;
      }).join(' | ');
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
      cards.push(reviewCard('Átvétel és időzítés', 'logistics', [
        ['Átvétel', FULFILLMENT_NAMES[fieldValue('fulfillment')]],
        ['Irányítószám', fieldValue('postal_code')],
        ['Kívánt időpont', fieldValue('target_date')],
        ['Megjegyzés', fieldValue('project_note')]
      ]));
    }
    cards.push(reviewCard('Kapcsolattartás', 'contact', [
      ['Név', fieldValue('customer_name')],
      ['Cégnév', fieldValue('company_name')],
      ['E-mail', fieldValue('customer_email')],
      ['Telefon', fieldValue('customer_phone')],
      ['Elsődleges kapcsolat', fieldValue('preferred_contact') === 'phone' ? 'Telefon' : 'E-mail']
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
    document.querySelector('#change-flow').hidden = stepIndex === 0;
    if (activeStep === 'items') seedFirstItem();
    if (activeStep === 'review') buildReview();
    clearErrors();
    queueSave();
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
  }

  function startFlow(flow, draft = null) {
    if (!FLOW_STEPS[flow]) return;
    activeFlow = flow;
    stepIndex = Number(draft?.stepIndex) || 0;
    if (stepIndex >= FLOW_STEPS[flow].length) stepIndex = 0;
    flowChoice.style.display = 'none';
    wizard.classList.add('active');
    successPanel.classList.remove('active');
    document.querySelectorAll('[data-flow-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.flowPanel === flow));
    if (flow === 'manual' && !itemList.children.length) newItem({ material: fieldValue('manual_material'), thicknessMm: fieldValue('manual_thickness'), quantity: 1 });
    updateStep();
  }

  function returnToChoice() {
    wizard.classList.remove('active');
    successPanel.classList.remove('active');
    flowChoice.style.display = 'block';
    activeFlow = null;
    stepIndex = 0;
    history.replaceState(null, '', location.pathname);
    window.scrollTo({ top: document.querySelector('.form-card').offsetTop - 100, behavior: 'smooth' });
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
    document.querySelector('#postcode-field').hidden = fieldValue('fulfillment') !== 'delivery';
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
      schemaVersion: 1,
      flow: activeFlow,
      stepIndex,
      fields,
      items: readItems(),
      filesMeta: {
        upload: files.upload.map(({ name, size, type, lastModified }) => ({ name, size, type, lastModified })),
        help: files.help.map(({ name, size, type, lastModified }) => ({ name, size, type, lastModified }))
      },
      updatedAt: new Date().toISOString()
    };
  }

  function saveDraft() {
    if (!activeFlow) return;
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
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

  function readDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (!draft || draft.schemaVersion !== 1 || !draft.updatedAt || Date.now() - new Date(draft.updatedAt).getTime() > DRAFT_MAX_AGE) {
        localStorage.removeItem(DRAFT_KEY);
        return null;
      }
      return draft;
    } catch (_) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
  }

  function applyDraft(draft) {
    Object.entries(draft.fields || {}).forEach(([name, value]) => setFieldValue(name, value));
    document.querySelector('#privacy-consent').checked = Boolean(draft.fields?.privacy_consent);
    itemList.innerHTML = '';
    (draft.items?.length ? draft.items : [{}]).forEach((item) => newItem(item));
    renderFiles('upload', draft.filesMeta?.upload);
    renderFiles('help', draft.filesMeta?.help);
    document.querySelector('#postcode-field').hidden = fieldValue('fulfillment') !== 'delivery';
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
    restoredDraft = null;
    draftBanner.classList.remove('visible');
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const steps = FLOW_STEPS[activeFlow];
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
    localStorage.removeItem(DRAFT_KEY);
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
    renderFiles('upload'); renderFiles('help');
    returnToChoice();
  });

  const requestedFlow = new URLSearchParams(location.search).get('ut');
  if (!restoredDraft && FLOW_STEPS[requestedFlow]) startFlow(requestedFlow);
})();

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
  const MAX_EDGE_PROFILES = 50;
  const MAX_ITEMS = 500;
  const EDGE_MATERIAL_TYPE_MAX_LENGTH = 120;
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
  const materialList = document.querySelector('#material-list');
  const edgeProfileList = document.querySelector('#edge-profile-list');
  const itemList = document.querySelector('#item-list');
  const itemSummary = document.querySelector('#items-summary');
  const draftBanner = document.querySelector('#draft-banner');
  const draftTime = document.querySelector('#draft-time');
  const submitFeedback = document.querySelector('#submit-feedback');

  let activeFlow = null;
  let stepIndex = 0;
  let materialCounter = 0;
  let edgeProfileCounter = 0;
  let itemCounter = 0;
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

  function hasSecondEdge(item = {}) {
    return Boolean(item.edgeProfileId2 && EDGE_CODES.includes(item.edgeCode2) && item.edgeCode2 !== '0-0');
  }

  function combinedEdgeCode(item = {}) {
    if (!hasSecondEdge(item)) return item.edgeCode;
    const [longEdges1, shortEdges1] = edgeCodeParts(item.edgeCode);
    const [longEdges2, shortEdges2] = edgeCodeParts(item.edgeCode2);
    return `${longEdges1 + longEdges2}-${shortEdges1 + shortEdges2}`;
  }

  function combinedEdgeMaterialType(item = {}) {
    if (!hasSecondEdge(item)) return item.edgeMaterialType;
    return `${item.edgeCode}: ${item.edgeMaterialType} | ${item.edgeCode2}: ${item.edgeMaterialType2}`;
  }

  function secondEdgeDirectionsOverlap(item = {}) {
    if (!hasSecondEdge(item)) return false;
    const [longEdges1, shortEdges1] = edgeCodeParts(item.edgeCode);
    const [longEdges2, shortEdges2] = edgeCodeParts(item.edgeCode2);
    return (longEdges1 > 0 && longEdges2 > 0) || (shortEdges1 > 0 && shortEdges2 > 0);
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

  function edgePreviewMarkup(code, extraClass = '') {
    const [longEdges, shortEdges] = edgeCodeParts(code);
    return `<span class="part l-${longEdges} s-${shortEdges} ${extraClass}" aria-hidden="true"><i class="top"></i><i class="right"></i><i class="bottom"></i><i class="left"></i></span>`;
  }

  function edgeProfilePairKey(identifier, thicknessMm) {
    const normalizedIdentifier = String(identifier ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('hu-HU');
    return `${normalizedIdentifier}\u001f${canonicalThickness(thicknessMm)}`;
  }

  function edgeProfileDisplayName(profile, index) {
    const identifier = String(profile?.identifier || '').trim();
    const thickness = String(profile?.thicknessMm || '').trim();
    if (!identifier && !thickness) return `${index + 1}. ABS – még nincs kitöltve`;
    if (!identifier) return `${index + 1}. ABS – ${thickness.replace('.', ',')} mm`;
    return thickness ? `${identifier} – ${thickness.replace('.', ',')} mm` : `${identifier} – vastagság nélkül`;
  }

  function edgeProfilePayloadName(profile) {
    if (!profile) return '';
    const identifier = String(profile.identifier || '').trim();
    const thickness = canonicalThickness(profile.thicknessMm);
    return [identifier, thickness ? `${thickness.replace('.', ',')} mm` : ''].filter(Boolean).join(' · ');
  }

  function parseLegacyEdgeProfile(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(.*?)\s*(?:·|–|-)\s*(\d+(?:[.,]\d+)?)\s*mm$/i);
    return match
      ? { identifier: match[1].trim(), thicknessMm: canonicalThickness(match[2]) }
      : { identifier: text, thicknessMm: '' };
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
    itemList.querySelectorAll('[data-item-field="materialId"]').forEach((select) => {
      const selectedId = select.value;
      const placeholder = new Option('Válasszon anyagot…', '');
      select.replaceChildren(placeholder);
      materials.forEach((material, index) => select.add(new Option(materialDisplayName(material, index), material.id)));
      if (materials.some((material) => material.id === selectedId)) select.value = selectedId;
      else if (materials.length === 1) select.value = materials[0].id;
    });
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

  function readEdgeProfile(card) {
    const data = { id: card.dataset.edgeProfileId };
    card.querySelectorAll('[data-edge-profile-field]').forEach((control) => { data[control.dataset.edgeProfileField] = control.value.trim(); });
    return data;
  }

  function readEdgeProfiles() {
    return [...edgeProfileList.querySelectorAll('.edge-profile-card')].map(readEdgeProfile);
  }

  function getEdgeProfile(profileId) {
    return readEdgeProfiles().find((profile) => profile.id === profileId) || null;
  }

  function isUsableEdgeProfile(profile) {
    const thickness = Number(canonicalThickness(profile?.thicknessMm));
    return String(profile?.identifier || '').trim().length >= 2 && Number.isFinite(thickness) && thickness >= 0.1 && thickness <= 10;
  }

  function updateEdgeProfileOptions() {
    const profiles = readEdgeProfiles();
    const usableProfiles = profiles.filter(isUsableEdgeProfile);
    itemList.querySelectorAll('.item-card').forEach((card) => {
      const primarySelect = card.querySelector('[data-item-field="edgeProfileId"]');
      const secondarySelect = card.querySelector('[data-item-field="edgeProfileId2"]');
      const primarySelectedId = primarySelect.value;
      const secondarySelectedId = secondarySelect.value;

      primarySelect.replaceChildren(new Option(profiles.length ? 'Válasszon ABS élanyagot…' : 'Előbb vegyen fel ABS-t fent…', ''));
      profiles.forEach((profile, index) => primarySelect.add(new Option(edgeProfileDisplayName(profile, index), profile.id)));
      if (profiles.some((profile) => profile.id === primarySelectedId)) primarySelect.value = primarySelectedId;
      else if (usableProfiles.length === 1 && card.querySelector('[data-item-field="edgeCode"]')?.value !== '0-0') primarySelect.value = usableProfiles[0].id;

      secondarySelect.replaceChildren(new Option('Nincs második ABS', ''));
      profiles.forEach((profile, index) => {
        const option = new Option(edgeProfileDisplayName(profile, index), profile.id);
        option.disabled = profile.id === primarySelect.value;
        secondarySelect.add(option);
      });
      if (profiles.some((profile) => profile.id === secondarySelectedId)) secondarySelect.value = secondarySelectedId;
    });
  }

  function updateEdgeProfileUsageState() {
    const cards = [...edgeProfileList.querySelectorAll('.edge-profile-card')];
    const usedIds = new Set();
    readItems().forEach((item) => {
      if (item.edgeCode && item.edgeCode !== '0-0' && isUsableEdgeProfile(getEdgeProfile(item.edgeProfileId))) usedIds.add(item.edgeProfileId);
      if (item.edgeCode2 && item.edgeCode2 !== '0-0' && isUsableEdgeProfile(getEdgeProfile(item.edgeProfileId2))) usedIds.add(item.edgeProfileId2);
    });
    cards.forEach((card, index) => {
      const button = card.querySelector('[data-edge-profile-action="delete"]');
      const onlyEdgeProfile = cards.length === 1;
      const inUse = usedIds.has(card.dataset.edgeProfileId);
      button.disabled = onlyEdgeProfile || inUse;
      button.title = onlyEdgeProfile
        ? 'Legalább egy ABS élanyag szükséges.'
        : inUse
          ? 'Ezt az ABS élanyagot használja egy tételsor. Előbb válasszon ott másikat.'
          : `${index + 1}. ABS élanyag törlése`;
    });
  }

  function renumberEdgeProfiles() {
    const cards = [...edgeProfileList.querySelectorAll('.edge-profile-card')];
    cards.forEach((card, index) => {
      card.querySelector('.edge-profile-number').textContent = String(index + 1);
      card.querySelector('.edge-profile-number-a11y').textContent = String(index + 1);
      card.querySelector('[data-edge-profile-action="delete"]').setAttribute('aria-label', `${index + 1}. ABS élanyag törlése`);
    });
    document.querySelector('#add-edge-profile').disabled = cards.length >= MAX_EDGE_PROFILES;
    updateEdgeProfileOptions();
    updateEdgeProfileUsageState();
  }

  function newEdgeProfile(data = {}) {
    if (edgeProfileList.children.length >= MAX_EDGE_PROFILES) return null;
    edgeProfileCounter += 1;
    const domId = `edge-profile-${Date.now()}-${edgeProfileCounter}`;
    const usedIds = new Set(readEdgeProfiles().map((profile) => profile.id));
    const preferredId = String(data.id || '').trim();
    const profileId = preferredId && !usedIds.has(preferredId) ? preferredId : `edge-${Date.now()}-${edgeProfileCounter}`;
    const card = document.createElement('article');
    card.className = 'material-card edge-profile-card';
    card.id = domId;
    card.tabIndex = -1;
    card.dataset.edgeProfileId = profileId;
    card.innerHTML = `
      <h4 class="sr-only"><span class="edge-profile-number-a11y"></span>. ABS élanyag</h4>
      <div class="material-grid">
        <div class="material-index"><span>ABS</span><strong class="edge-profile-number"></strong></div>
        <div class="field material-profile-name"><label class="required" for="${domId}-identifier">ABS színe / azonosítója</label><input id="${domId}-identifier" data-edge-profile-field="identifier" type="text" required aria-required="true" maxlength="100" value="${escapeHtml(data.identifier)}" placeholder="Pl. U604 lapazonos vagy Fehér"></div>
        <div class="field material-profile-thickness"><label class="required" for="${domId}-thickness">Vastagság (mm)</label><input id="${domId}-thickness" data-edge-profile-field="thicknessMm" type="number" required aria-required="true" min="0.1" max="10" step="0.1" inputmode="decimal" value="${escapeHtml(data.thicknessMm)}" placeholder="0,8"><span class="input-unit" aria-hidden="true">mm</span></div>
        <div class="material-actions"><button class="icon-button delete" type="button" data-edge-profile-action="delete">Törlés</button></div>
      </div>
      <p class="material-error" id="${domId}-error" role="alert"></p>`;
    edgeProfileList.append(card);
    renumberEdgeProfiles();
    return card;
  }

  document.querySelector('#add-edge-profile').addEventListener('click', () => {
    const card = newEdgeProfile();
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector('[data-edge-profile-field="identifier"]').focus();
    queueSave();
  });

  edgeProfileList.addEventListener('click', (event) => {
    const card = event.target.closest('.edge-profile-card');
    const button = event.target.closest('[data-edge-profile-action="delete"]');
    if (!card || !button || button.disabled) return;
    card.remove();
    renumberEdgeProfiles();
    queueSave();
  });

  edgeProfileList.addEventListener('input', () => {
    updateEdgeProfileOptions();
    updateEdgeProfileUsageState();
    queueSave();
  });

  function newItem(data = {}) {
    itemCounter += 1;
    const id = `item-${Date.now()}-${itemCounter}`;
    const edgeCode = edgeCodeFromData(data);
    const edgeCode2 = EDGE_CODES.includes(data.edgeCode2) && data.edgeCode2 !== '0-0' ? data.edgeCode2 : '';
    const card = document.createElement('article');
    card.className = 'item-card';
    card.id = id;
    card.tabIndex = -1;
    card.dataset.itemId = id;
    card.innerHTML = `
      <h3 class="sr-only"><span class="item-number-a11y"></span>. szabászjegyzék-tétel</h3>
      <div class="item-main-grid">
        <div class="item-index"><span>Tétel</span><strong class="item-number"></strong></div>
        <div class="field item-material"><label class="required" for="${id}-material">Anyag</label><select id="${id}-material" data-item-field="materialId" required aria-required="true"></select></div>
        <div class="field item-name"><label for="${id}-name">Elnevezés</label><input id="${id}-name" data-item-field="name" type="text" maxlength="100" value="${escapeHtml(data.name)}" placeholder="Pl. oldallap"></div>
        <div class="field item-length"><label for="${id}-length"><span class="required">Hossz (mm)</span><small>Szálirány</small></label><input id="${id}-length" data-item-field="lengthMm" type="number" required aria-required="true" aria-label="Hossz milliméterben, szálirány" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.lengthMm)}" placeholder="Szálirány"><span class="input-unit" aria-hidden="true">mm</span></div>
        <div class="field item-width"><label for="${id}-width"><span class="required">Szélesség (mm)</span><small>Keresztirány</small></label><input id="${id}-width" data-item-field="widthMm" type="number" required aria-required="true" aria-label="Szélesség milliméterben, keresztirány" min="10" max="5000" step="0.1" inputmode="decimal" value="${escapeHtml(data.widthMm)}" placeholder="Keresztirány"><span class="input-unit" aria-hidden="true">mm</span></div>
        <div class="field item-quantity"><label class="required" for="${id}-quantity">Mennyiség</label><input id="${id}-quantity" data-item-field="quantity" type="number" required aria-required="true" min="1" max="999" step="1" inputmode="numeric" value="${escapeHtml(data.quantity ?? 1)}"></div>
        <div class="field item-edge-material"><label class="edge-required-label" for="${id}-edge-material">1. ABS élanyag</label><select id="${id}-edge-material" data-item-field="edgeProfileId"><option value="">Előbb vegyen fel ABS-t fent…</option></select></div>
        <div class="field item-edge-code"><label class="required" for="${id}-edge-code">1. élkód</label><div class="edge-code-control"><select id="${id}-edge-code" data-item-field="edgeCode" required aria-required="true"><option value="">Válasszon...</option>${EDGE_CODES.map((code) => `<option value="${code}" ${edgeCode === code ? 'selected' : ''}>${code} · ${EDGE_CODE_NAMES[code]}</option>`).join('')}</select>${edgePreviewMarkup(edgeCode, 'edge-row-preview edge-row-preview-1')}</div></div>
        <div class="field item-edge-material-2"><label for="${id}-edge-material-2">2. ABS élanyag <small>Opcionális</small></label><select id="${id}-edge-material-2" data-item-field="edgeProfileId2"><option value="">Nincs második ABS</option></select></div>
        <div class="field item-edge-code-2"><label class="edge-required-label-2" for="${id}-edge-code-2">2. élkód</label><div class="edge-code-control"><select id="${id}-edge-code-2" data-item-field="edgeCode2" disabled><option value="">Válasszon...</option>${EDGE_CODES.filter((code) => code !== '0-0').map((code) => `<option value="${code}">${code} · ${EDGE_CODE_NAMES[code]}</option>`).join('')}</select>${edgePreviewMarkup(edgeCode2, 'edge-row-preview edge-row-preview-2')}</div></div>
        <div class="field item-note"><label class="item-note-label" for="${id}-note">Megjegyzés</label><input id="${id}-note" data-item-field="note" type="text" maxlength="500" value="${escapeHtml(data.note)}" placeholder="Egyedi kérés"></div>
        <div class="item-actions">
          <button class="icon-button" type="button" data-item-action="duplicate">Másolás</button>
          <button class="icon-button delete" type="button" data-item-action="delete">Törlés</button>
        </div>
      </div>
      <p class="item-error" id="${id}-error" role="alert"></p>`;
    itemList.append(card);
    updateMaterialOptions();
    updateEdgeProfileOptions();
    const materialSelect = card.querySelector('[data-item-field="materialId"]');
    const requestedMaterialId = String(data.materialId || '');
    if ([...materialSelect.options].some((option) => option.value === requestedMaterialId)) materialSelect.value = requestedMaterialId;
    const edgeProfileSelect = card.querySelector('[data-item-field="edgeProfileId"]');
    const requestedEdgeProfileId = String(data.edgeProfileId || '');
    if ([...edgeProfileSelect.options].some((option) => option.value === requestedEdgeProfileId)) edgeProfileSelect.value = requestedEdgeProfileId;
    updateEdgeProfileOptions();
    const edgeProfileSelect2 = card.querySelector('[data-item-field="edgeProfileId2"]');
    const requestedEdgeProfileId2 = String(data.edgeProfileId2 || '');
    if ([...edgeProfileSelect2.options].some((option) => option.value === requestedEdgeProfileId2)) edgeProfileSelect2.value = requestedEdgeProfileId2;
    const edgeCodeSelect2 = card.querySelector('[data-item-field="edgeCode2"]');
    if ([...edgeCodeSelect2.options].some((option) => option.value === edgeCode2)) edgeCodeSelect2.value = edgeCode2;
    syncEdgeRequirements(card);
    renumberItems();
    return card;
  }

  function syncEdgeRequirements(card) {
    const edgeCodeControl = card.querySelector('[data-item-field="edgeCode"]');
    const edgeCode = edgeCodeControl?.value || '';
    const hasEdge = EDGE_CODES.includes(edgeCode) && edgeCode !== '0-0';
    const explicitlyNoEdge = edgeCode === '0-0';
    const [longEdges, shortEdges] = edgeCodeParts(edgeCode);
    const preview = card.querySelector('.edge-row-preview-1');
    if (preview) preview.className = `part l-${longEdges} s-${shortEdges} edge-row-preview edge-row-preview-1`;
    const primaryProfileControl = card.querySelector('[data-item-field="edgeProfileId"]');
    if (hasEdge && !primaryProfileControl.value) {
      const profiles = readEdgeProfiles().filter(isUsableEdgeProfile);
      if (profiles.length === 1) primaryProfileControl.value = profiles[0].id;
    }
    primaryProfileControl.required = hasEdge;
    primaryProfileControl.disabled = explicitlyNoEdge;
    if (hasEdge) primaryProfileControl.setAttribute('aria-required', 'true');
    else primaryProfileControl.removeAttribute('aria-required');
    primaryProfileControl.closest('.field').querySelector('.edge-required-label').classList.toggle('required', hasEdge);

    const secondaryProfileControl = card.querySelector('[data-item-field="edgeProfileId2"]');
    const secondaryCodeControl = card.querySelector('[data-item-field="edgeCode2"]');
    const secondaryUnavailable = !hasEdge || (longEdges === 2 && shortEdges === 2);
    secondaryProfileControl.disabled = secondaryUnavailable;
    if (secondaryUnavailable) {
      secondaryProfileControl.value = '';
      secondaryCodeControl.value = '';
    }

    [...secondaryProfileControl.options].forEach((option) => {
      if (option.value) option.disabled = option.value === primaryProfileControl.value;
    });
    const remainingLongEdges = 2 - longEdges;
    const remainingShortEdges = 2 - shortEdges;
    [...secondaryCodeControl.options].forEach((option) => {
      if (!option.value) return;
      const [optionLongEdges, optionShortEdges] = edgeCodeParts(option.value);
      option.disabled = optionLongEdges > remainingLongEdges || optionShortEdges > remainingShortEdges;
    });
    if (secondaryCodeControl.selectedOptions[0]?.disabled) secondaryCodeControl.value = '';

    const hasSecondaryProfile = !secondaryUnavailable && Boolean(secondaryProfileControl.value);
    secondaryCodeControl.disabled = !hasSecondaryProfile;
    secondaryCodeControl.required = hasSecondaryProfile;
    if (hasSecondaryProfile) secondaryCodeControl.setAttribute('aria-required', 'true');
    else secondaryCodeControl.removeAttribute('aria-required');
    card.querySelector('.edge-required-label-2').classList.toggle('required', hasSecondaryProfile);

    const [longEdges2, shortEdges2] = edgeCodeParts(secondaryCodeControl.value);
    const preview2 = card.querySelector('.edge-row-preview-2');
    if (preview2) preview2.className = `part l-${longEdges2} s-${shortEdges2} edge-row-preview edge-row-preview-2`;

    const item = {
      edgeProfileId2: secondaryProfileControl.value,
      edgeCode,
      edgeCode2: secondaryCodeControl.value
    };
    const noteControl = card.querySelector('[data-item-field="note"]');
    const noteRequired = secondEdgeDirectionsOverlap(item);
    noteControl.required = noteRequired;
    if (noteRequired) noteControl.setAttribute('aria-required', 'true');
    else noteControl.removeAttribute('aria-required');
    card.querySelector('.item-note-label').classList.toggle('required', noteRequired);
  }

  function readItem(card) {
    const data = { id: card.dataset.itemId };
    card.querySelectorAll('[data-item-field]').forEach((control) => { data[control.dataset.itemField] = control.value.trim(); });
    data.edgeMaterialType = edgeProfilePayloadName(getEdgeProfile(data.edgeProfileId));
    data.edgeMaterialType2 = edgeProfilePayloadName(getEdgeProfile(data.edgeProfileId2));
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
    updateMaterialUsageState();
    updateEdgeProfileUsageState();
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
      const [longEdges, shortEdges] = edgeCodeParts(item.edgeCode);
      const [longEdges2, shortEdges2] = edgeCodeParts(item.edgeCode2);
      totals.rows += 1;
      totals.pieces += quantity;
      totals.area += quantity * length * width / 1_000_000;
      totals.edge += quantity * ((longEdges + longEdges2) * length + (shortEdges + shortEdges2) * width) / 1000;
      return totals;
    }, { rows: 0, pieces: 0, area: 0, edge: 0 });
  }

  function updateItemSummary() {
    const totals = itemTotals();
    itemSummary.textContent = `${totals.rows} tétel · ${totals.pieces} darab · ${totals.area.toFixed(2)} m² · kb. ${totals.edge.toFixed(1)} fm él`;
  }

  function addItemRow() {
    const previous = readItems().at(-1) || {};
    const card = newItem({ materialId: previous.materialId, quantity: 1, edgeProfileId: previous.edgeCode === '0-0' ? '' : previous.edgeProfileId });
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.querySelector(previous.materialId ? '[data-item-field="name"]' : '[data-item-field="materialId"]').focus();
    queueSave();
  }

  document.querySelectorAll('[data-add-item]').forEach((button) => button.addEventListener('click', addItemRow));

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
    if (card && event.target.matches('[data-item-field="edgeProfileId"]')) {
      updateEdgeProfileOptions();
      const secondaryProfile = card.querySelector('[data-item-field="edgeProfileId2"]');
      if (event.target.value && secondaryProfile.value === event.target.value) {
        secondaryProfile.value = '';
        card.querySelector('[data-item-field="edgeCode2"]').value = '';
      }
    }
    if (card && event.target.matches('[data-item-field="edgeProfileId2"]') && !event.target.value) {
      card.querySelector('[data-item-field="edgeCode2"]').value = '';
    }
    if (card && event.target.matches('[data-item-field="edgeCode"], [data-item-field="edgeProfileId"], [data-item-field="edgeProfileId2"], [data-item-field="edgeCode2"]')) syncEdgeRequirements(card);
    updateItemSummary();
    updateMaterialUsageState();
    updateEdgeProfileUsageState();
    queueSave();
  });

  function moveToNextManualField(event, selector, fallback) {
    if (event.key !== 'Enter' || event.isComposing || !event.target.matches('input')) return;
    event.preventDefault();
    const controls = [...document.querySelectorAll(selector)].filter((control) => !control.disabled && control.offsetParent !== null);
    const next = controls[controls.indexOf(event.target) + 1];
    (next || document.querySelector(fallback))?.focus();
  }

  materialList.addEventListener('keydown', (event) => moveToNextManualField(event, '#material-list [data-material-field]', '#item-list [data-item-field="materialId"]'));
  edgeProfileList.addEventListener('keydown', (event) => moveToNextManualField(event, '#edge-profile-list [data-edge-profile-field]', '#item-list [data-item-field="materialId"]'));
  itemList.addEventListener('keydown', (event) => moveToNextManualField(event, '#item-list [data-item-field]', '.items-footer [data-add-item]'));

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
    const edgeProfileCards = [...edgeProfileList.querySelectorAll('.edge-profile-card')];
    const seenEdgeProfilePairs = new Set();
    if (!edgeProfileCards.length) errors.push({ id: 'add-edge-profile', message: 'Vegyen fel legalább egy ABS élanyagot.' });
    if (edgeProfileCards.length > MAX_EDGE_PROFILES) errors.push({ id: 'add-edge-profile', message: `Legfeljebb ${MAX_EDGE_PROFILES} különböző ABS élanyag adható meg.` });
    edgeProfileCards.forEach((card, index) => {
      const profile = readEdgeProfile(card);
      const messages = [];
      const invalidControls = [];
      const mark = (field, label) => {
        messages.push(label);
        const control = card.querySelector(`[data-edge-profile-field="${field}"]`);
        if (control) invalidControls.push(control);
      };
      if (profile.identifier.length < 2) mark('identifier', 'ABS színe / azonosítója');
      const thickness = Number(canonicalThickness(profile.thicknessMm));
      if (!Number.isFinite(thickness) || thickness < 0.1 || thickness > 10) mark('thicknessMm', 'vastagság');
      const pairKey = edgeProfilePairKey(profile.identifier, profile.thicknessMm);
      if (profile.identifier.length >= 2 && thickness >= 0.1 && thickness <= 10) {
        if (seenEdgeProfilePairs.has(pairKey)) mark('identifier', 'már felvett ABS–vastagság páros');
        else seenEdgeProfilePairs.add(pairKey);
      }
      if (messages.length) {
        card.classList.add('invalid');
        const errorId = `${card.id}-error`;
        card.querySelector('.material-error').textContent = `Ellenőrizze: ${messages.join(', ')}.`;
        invalidControls.forEach((control) => {
          control.setAttribute('aria-invalid', 'true');
          control.setAttribute('aria-describedby', errorId);
        });
        errors.push({ id: invalidControls[0]?.id || card.id, message: `${index + 1}. ABS élanyag: ${messages.join(', ')}.` });
      }
    });
    const cards = [...itemList.querySelectorAll('.item-card')];
    if (!cards.length) {
      errors.push({ id: 'add-item', message: 'Vegyen fel legalább egy tételt.' });
      return;
    }
    if (cards.length > MAX_ITEMS) errors.push({ id: 'add-item', message: `Legfeljebb ${MAX_ITEMS} tételsor adható meg.` });
    cards.forEach((card, index) => {
      const item = readItem(card);
      const messages = [];
      const invalidControls = [];
      const mark = (field, label) => {
        messages.push(label);
        const control = card.querySelector(`[data-item-field="${field}"]`);
        if (control) invalidControls.push(control);
      };
      if (!getMaterialProfile(item.materialId)) mark('materialId', 'anyag');
      const length = Number(item.lengthMm);
      if (!length || length < 10 || length > 5000) mark('lengthMm', 'hossz');
      const width = Number(item.widthMm);
      if (!width || width < 10 || width > 5000) mark('widthMm', 'szélesség');
      const quantity = Number(item.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) mark('quantity', 'darabszám');
      if (!EDGE_CODES.includes(item.edgeCode)) mark('edgeCode', 'élkód');
      const hasEdge = EDGE_CODES.includes(item.edgeCode) && item.edgeCode !== '0-0';
      if (hasEdge && !isUsableEdgeProfile(getEdgeProfile(item.edgeProfileId))) mark('edgeProfileId', 'ABS élanyag');
      const secondEdgeRequested = Boolean(item.edgeProfileId2 || item.edgeCode2);
      if (secondEdgeRequested) {
        const validSecondProfile = isUsableEdgeProfile(getEdgeProfile(item.edgeProfileId2));
        const validSecondCode = EDGE_CODES.includes(item.edgeCode2) && item.edgeCode2 !== '0-0';
        if (!hasEdge) mark('edgeCode2', 'a 2. ABS csak az 1. élkód megadása mellett használható');
        if (!validSecondProfile) mark('edgeProfileId2', '2. ABS élanyag');
        if (!validSecondCode) mark('edgeCode2', '2. élkód');
        if (item.edgeProfileId2 && item.edgeProfileId2 === item.edgeProfileId) mark('edgeProfileId2', 'a két ABS élanyag legyen különböző');
        if (hasEdge && validSecondCode) {
          const [longEdges1, shortEdges1] = edgeCodeParts(item.edgeCode);
          const [longEdges2, shortEdges2] = edgeCodeParts(item.edgeCode2);
          if (longEdges1 + longEdges2 > 2 || shortEdges1 + shortEdges2 > 2) {
            mark('edgeCode2', 'a két élkód együtt legfeljebb 2 hosszanti és 2 rövid élt jelölhet');
          }
        }
        if (hasEdge && validSecondProfile && validSecondCode && combinedEdgeMaterialType(item).length > EDGE_MATERIAL_TYPE_MAX_LENGTH) {
          mark('edgeProfileId2', 'a két ABS megnevezése túl hosszú; rövidítse az ABS azonosítókat');
        }
        if (secondEdgeDirectionsOverlap(item) && !item.note.trim()) {
          mark('note', 'megjegyzés: írja le, melyik oldal kapja az 1. és a 2. ABS-t');
        }
      }
      if (messages.length) {
        card.classList.add('invalid');
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
      schemaVersion: 1,
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
          const edgeCode = combinedEdgeCode(item);
          return {
            materialClientId: cleanText(item.materialId),
            name: cleanText(item.name),
            lengthMm: Number(item.lengthMm),
            widthMm: Number(item.widthMm),
            quantity: Number(item.quantity),
            edgeCode: cleanText(edgeCode),
            edgeMaterialType: edgeCode === '0-0' ? null : cleanText(combinedEdgeMaterialType(item)),
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
        const edgeData = item.edgeCode === '0-0'
          ? 'élkód: 0-0, élzárás nélkül'
          : hasSecondEdge(item)
            ? `1. ABS: ${item.edgeCode} (${EDGE_CODE_NAMES[item.edgeCode] || 'egyeztetendő'}), ${item.edgeMaterialType || 'élanyag egyeztetendő'}; 2. ABS: ${item.edgeCode2} (${EDGE_CODE_NAMES[item.edgeCode2] || 'egyeztetendő'}), ${item.edgeMaterialType2 || 'élanyag egyeztetendő'}`
            : `élkód: ${item.edgeCode || 'nincs megadva'} (${EDGE_CODE_NAMES[item.edgeCode] || 'egyeztetendő'}); ${item.edgeMaterialType || 'élanyag egyeztetendő'}`;
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
      if (!edgeProfileList.children.length) newEdgeProfile();
      if (!itemList.children.length) newItem({ quantity: 1 });
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
      edgeProfiles: readEdgeProfiles(),
      items: readItems().map(({ edgeMaterialType, edgeMaterialType2, ...item }) => item),
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

  function migrateV4ToV5(draft) {
    if (draft?.schemaVersion !== 4) return draft;
    const edgeProfiles = [];
    const profileIdByPair = new Map();
    const getEdgeProfileId = (value) => {
      const parsed = parseLegacyEdgeProfile(value);
      if (!parsed.identifier) return '';
      const pairKey = edgeProfilePairKey(parsed.identifier, parsed.thicknessMm);
      if (!profileIdByPair.has(pairKey)) {
        const id = `edge-migrated-${edgeProfiles.length + 1}`;
        edgeProfiles.push({ id, identifier: parsed.identifier, thicknessMm: parsed.thicknessMm });
        profileIdByPair.set(pairKey, id);
      }
      return profileIdByPair.get(pairKey);
    };
    const items = (Array.isArray(draft.items) ? draft.items : []).map((rawItem) => {
      const item = rawItem && typeof rawItem === 'object' ? rawItem : {};
      const { edgeMaterialType, ...rest } = item;
      const edgeCode = edgeCodeFromData(item);
      return {
        ...rest,
        edgeCode,
        edgeProfileId: edgeCode === '0-0' ? '' : getEdgeProfileId(edgeMaterialType)
      };
    });
    return { ...draft, schemaVersion: 5, edgeProfiles, items };
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
    const edgeProfiles = draft?.edgeProfiles;
    const items = draft?.items;
    const validMaterials = Array.isArray(materials)
      && materials.every((material) => material && typeof material === 'object' && typeof material.id === 'string' && material.id.trim());
    const uniqueMaterialIds = validMaterials && new Set(materials.map((material) => material.id)).size === materials.length;
    const validEdgeProfiles = Array.isArray(edgeProfiles)
      && edgeProfiles.every((profile) => profile && typeof profile === 'object' && typeof profile.id === 'string' && profile.id.trim());
    const uniqueEdgeProfileIds = validEdgeProfiles && new Set(edgeProfiles.map((profile) => profile.id)).size === edgeProfiles.length;
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
      && validEdgeProfiles
      && uniqueEdgeProfileIds
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
    files = { upload: [], help: [] };
    submissionToken = isUuid(draft.submissionToken) ? draft.submissionToken : createSubmissionToken();
    Object.entries(draft.fields || {}).forEach(([name, value]) => {
      if (name === 'manual_size_basis' || name === 'upload_size_basis') return;
      setFieldValue(name, value);
    });
    if (draft.flow === 'manual' && !fieldValue('manual_material_source')) setFieldValue('manual_material_source', 'hepa');
    setFieldValue('manual_size_basis', 'finished');
    setFieldValue('upload_size_basis', 'finished');
    document.querySelector('#privacy-consent').checked = Boolean(draft.fields?.privacy_consent);
    materialList.innerHTML = '';
    edgeProfileList.innerHTML = '';
    itemList.innerHTML = '';
    const materialsToRestore = draft.materialProfiles?.length ? draft.materialProfiles : draft.flow === 'manual' ? [{}] : [];
    const edgeProfilesToRestore = draft.edgeProfiles?.length ? draft.edgeProfiles : draft.flow === 'manual' ? [{}] : [];
    const itemsToRestore = draft.items?.length ? draft.items : draft.flow === 'manual' ? [{ quantity: 1 }] : [];
    materialsToRestore.forEach((material) => newMaterial(material));
    edgeProfilesToRestore.forEach((profile) => newEdgeProfile(profile));
    renumberEdgeProfiles();
    itemsToRestore.forEach((item) => newItem(item));
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
    edgeProfileList.innerHTML = '';
    itemList.innerHTML = '';
    renumberEdgeProfiles();
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

/* Shared, grouped photo viewer for project comparisons and reference galleries. */
(() => {
  const dialog = document.getElementById('lightbox');
  if (!dialog) return;
  // Keep the modal outside the main content before making the background inert.
  document.body.append(dialog);
  const panel = dialog.querySelector('.lightbox-panel');
  const photo = dialog.querySelector('.lightbox-photo');
  const title = dialog.querySelector('#lightbox-title');
  const caption = dialog.querySelector('.lightbox-caption');
  const position = dialog.querySelector('.lightbox-position');
  const strip = dialog.querySelector('.lightbox-thumbs');
  const stage = dialog.querySelector('.lightbox-stage');
  const feedback = dialog.querySelector('.lightbox-feedback');
  const message = dialog.querySelector('.lightbox-message');
  const retry = dialog.querySelector('[data-lightbox-retry]');
  const closeButton = dialog.querySelector('.lightbox-close');
  const previous = dialog.querySelector('[data-lightbox-prev]');
  const next = dialog.querySelector('[data-lightbox-next]');
  let items = [];
  let index = 0;
  let trigger = null;
  let generation = 0;
  let loader = null;
  let background = [];

  const isOpen = () => !dialog.hidden;
  const centerThumbnail = button => {
    if (!button) return;
    strip.scrollTo({ left: button.offsetLeft - strip.offsetLeft - (strip.clientWidth - button.offsetWidth) / 2, behavior: 'instant' });
  };
  const stopLoading = () => {
    if (loader) loader.onload = loader.onerror = null;
    loader = null;
  };

  function show(requested, focusThumbnail = false) {
    if (!items.length || !isOpen()) return;
    index = (requested + items.length) % items.length;
    const item = items[index];
    const token = ++generation;
    stopLoading();
    caption.textContent = item.caption;
    position.textContent = `${index + 1} / ${items.length}`;
    photo.hidden = true;
    photo.removeAttribute('src');
    photo.alt = item.alt;
    stage.setAttribute('aria-busy', 'true');
    message.textContent = 'Kép betöltése…';
    feedback.hidden = false;
    retry.hidden = true;
    for (const [i, button] of [...strip.children].entries()) {
      button.setAttribute('aria-pressed', String(i === index));
      button.tabIndex = i === index ? 0 : -1;
    }
    const selected = strip.children[index];
    centerThumbnail(selected);
    if (focusThumbnail) selected?.focus({ preventScroll: true });

    function load(source, canFallback) {
      const pending = new Image();
      loader = pending;
      pending.onload = async () => {
        if (generation !== token || !isOpen()) return;
        photo.src = source;
        try { await photo.decode(); } catch { /* A newer selection can cancel decoding. */ }
        if (generation !== token || !isOpen()) return;
        photo.hidden = false;
        feedback.hidden = true;
        stage.setAttribute('aria-busy', 'false');
        loader = null;
      };
      pending.onerror = () => {
        if (generation !== token || !isOpen()) return;
        if (canFallback && item.thumbnail !== source) {
          load(item.thumbnail, false);
          return;
        }
        stage.setAttribute('aria-busy', 'false');
        message.textContent = 'Ez a kép most nem tölthető be. Próbálja újra, vagy válasszon másik képet.';
        retry.hidden = false;
        loader = null;
      };
      pending.src = source;
    }
    load(item.full, true);
  }

  function open(button) {
    const group = button.closest('.kitchen-project') || button.closest('.reference-container')
      || button.closest('.gallery');
    const buttons = group ? [...group.querySelectorAll('.gallery-item, [data-lightbox]')] : [button];
    items = buttons.map(element => {
      const image = element.querySelector('img');
      if (!image) return null;
      const thumbnail = image.currentSrc || image.src;
      const label = element.closest('figure')?.querySelector('figcaption')?.textContent.trim();
      return { element, thumbnail, full: element.dataset.full || thumbnail, alt: image.alt,
        caption: label || image.alt || 'Bútorreferencia' };
    }).filter(Boolean);
    if (!items.length) return;
    trigger = button;
    title.textContent = group?.querySelector('h3, h2')?.textContent.trim() || 'Munkáink részletei';
    strip.replaceChildren();
    for (const [i, item] of items.entries()) {
      const thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'lightbox-thumb';
      thumb.dataset.index = String(i);
      thumb.setAttribute('aria-label', `${i + 1}. kép: ${item.caption}`);
      thumb.title = item.caption;
      const image = document.createElement('img');
      image.src = item.thumbnail;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      thumb.append(image);
      strip.append(thumb);
    }
    previous.hidden = next.hidden = strip.hidden = items.length < 2;
    background = [...document.body.children].filter(element => element !== dialog
      && !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName) && !element.inert);
    for (const element of background) element.inert = true;
    dialog.hidden = false;
    dialog.classList.add('active');
    dialog.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lightbox-open');
    show(Math.max(0, items.findIndex(item => item.element === button)));
    closeButton.focus({ preventScroll: true });
  }

  function close() {
    if (!isOpen()) return;
    ++generation;
    stopLoading();
    dialog.hidden = true;
    dialog.classList.remove('active');
    dialog.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lightbox-open');
    for (const element of background) element.inert = false;
    background = [];
    photo.removeAttribute('src');
    photo.alt = '';
    strip.replaceChildren();
    items = [];
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || isOpen()) return;
    const button = event.target.closest('.gallery-item, [data-lightbox]');
    if (button) open(button);
  });
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  previous.addEventListener('click', () => show(index - 1));
  next.addEventListener('click', () => show(index + 1));
  retry.addEventListener('click', () => { show(index); closeButton.focus({ preventScroll: true }); });
  strip.addEventListener('click', event => {
    const button = event.target.closest('.lightbox-thumb');
    if (button) show(Number(button.dataset.index), true);
  });
  document.addEventListener('focusin', event => {
    if (isOpen() && !dialog.contains(event.target)) closeButton.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    const focusThumbnail = strip.contains(document.activeElement);
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : index + (event.key === 'ArrowRight' ? 1 : -1);
      show(target, focusThumbnail);
    }
    if (event.key === 'Tab') {
      const focusable = [...panel.querySelectorAll('button')]
        .filter(button => !button.disabled && button.tabIndex >= 0 && button.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first?.focus();
      }
    }
  });
})();

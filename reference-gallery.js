/* Published references stay in the CMS; grouping and smaller copies are presentation only. */
(() => {
  'use strict';
  const labels = { konyha: 'Konyhabútor', gardrob: 'Gardrób', eloszoba: 'Előszobabútor',
    furdo: 'Fürdőszobabútor', nappali: 'Nappali bútor', egyedi: 'Egyedi bútor' };
  const projects = [
    { key: 'bezs', title: 'Bézs konyha, letisztult vonalakkal', ids: [60] },
    { key: 'feher-sziget', title: 'Fehér konyha szigettel', ids: [11] },
    { key: 'vilagos-u', title: 'Világos, U alakú konyha', ids: [52, 50, 49, 51] },
    { key: 'feher-fa', title: 'Fehér frontok, fa hatású felületek', ids: [59] },
    { key: 'fa-szurke', title: 'Fa hatású konyha szürke frontokkal', ids: [18, 17, 16, 14, 15] },
    { key: 'fa-fekete', title: 'Fa hatású konyha fekete felsőkkel', ids: [22, 25, 23, 26, 24, 10] },
    { key: 'tetoter', title: 'Tetőtéri konyha méretre készítve', ids: [12] },
    { key: 'etkezopult', title: 'Fehér konyha étkezőpulttal', ids: [13] },
    { key: 'szurke-sziget', title: 'Szürke konyha étkezőszigettel', ids: [21, 20, 19] },
    { key: 'tarolos-sziget', title: 'Tárolós konyhasziget', ids: [55, 53, 54] },
    { key: 'fa-sarok', title: 'Fa hatású sarokkonyha', ids: [58, 57] },
    { key: 'klasszikus', title: 'Klasszikus fehér sarokkonyha', ids: [56] }
  ];

  function groupKitchenImages(images) {
    const remaining = [...images];
    const groups = [];
    for (const project of projects) {
      const photos = [];
      for (const id of project.ids) {
        const index = remaining.findIndex(image => Number(image.id) === id);
        if (index >= 0) photos.push(...remaining.splice(index, 1));
      }
      if (photos.length) groups.push({ ...project, photos });
    }
    // New uploads and references outside the curated list must always remain visible.
    if (remaining.length) groups.push({ key: 'ujabb', title: 'További konyhai munkáink', photos: remaining });
    return groups;
  }

  function imageSources(reference, variants = {}) {
    const variant = variants[String(reference.id)];
    // A replaced CMS image must never be overridden by an older optimized copy.
    if (!variant || variant.original !== reference.url) return { thumbnail: reference.url, full: reference.url };
    return { ...variant, thumbnail: variant.medium, full: variant.full || reference.url };
  }

  function photoButton(reference, alt, variants, cover = false) {
    const sources = imageSources(reference, variants);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cover ? 'gallery-item reference-project-cover' : 'gallery-item';
    button.dataset.referenceId = String(reference.id);
    button.dataset.full = sources.full;
    button.setAttribute('aria-label', `${alt} nagyítása`);
    const image = document.createElement('img');
    image.alt = reference.alt || alt;
    image.loading = 'lazy';
    image.decoding = 'async';
    if (sources.width && sources.height) {
      image.width = sources.width;
      image.height = sources.height;
      const candidates = new Map([[sources.smallWidth, sources.small], [sources.mediumWidth, sources.medium],
        [sources.width, sources.full]]);
      image.srcset = [...candidates].filter(([width, url]) => width && url)
        .map(([width, url]) => `${url} ${width}w`).join(', ');
      image.sizes = cover
        ? '(max-width: 640px) calc(100vw - 48px), (max-width: 1100px) calc((100vw - 96px) / 2), 560px'
        : '(max-width: 640px) calc((100vw - 76px) / 2), 240px';
    }
    image.addEventListener('error', () => {
      if (image.dataset.originalFallback === 'true' || sources.thumbnail === reference.url) return;
      image.dataset.originalFallback = 'true';
      image.removeAttribute('srcset');
      image.removeAttribute('sizes');
      image.src = reference.url;
      button.dataset.full = reference.url;
    });
    image.src = sources.thumbnail;
    button.append(image);
    return button;
  }

  function projectCard(project, variants) {
    const card = document.createElement('article');
    card.className = 'reference-project';
    card.dataset.referenceProject = project.key;
    card.append(photoButton(project.photos[0], project.title, variants, true));
    const body = document.createElement('div');
    body.className = 'reference-project-body';
    const heading = document.createElement('h3');
    heading.textContent = project.title;
    body.append(heading);
    const hint = document.createElement('p');
    hint.className = 'reference-project-hint';
    hint.textContent = project.photos.length === 1 ? 'A kép kattintással nagyítható.'
      : `${project.photos.length} fotó erről a munkánkról · Kattintson a nagyításhoz!`;
    body.append(hint);
    if (project.photos.length > 1) {
      const details = document.createElement('details');
      details.className = 'reference-project-details';
      const summary = document.createElement('summary');
      summary.textContent = `További ${project.photos.length - 1} kép erről a konyháról`;
      const gallery = document.createElement('div');
      gallery.className = 'reference-project-extra';
      project.photos.slice(1).forEach((photo, index) => {
        gallery.append(photoButton(photo, `${project.title} – ${index + 2}. nézet`, variants));
      });
      details.append(summary, gallery);
      body.append(details);
    }
    card.append(body);
    return card;
  }

  function kitchenGallery(images, variants) {
    const root = document.createElement('div');
    root.className = 'reference-project-list';
    const groups = groupKitchenImages(images);
    const featured = document.createElement('div');
    featured.className = 'reference-project-grid';
    groups.slice(0, 6).forEach(project => featured.append(projectCard(project, variants)));
    root.append(featured);
    if (groups.length > 6) {
      const details = document.createElement('details');
      details.className = 'reference-more-projects';
      const summary = document.createElement('summary');
      summary.textContent = `További ${groups.length - 6} munkánk megtekintése`;
      const more = document.createElement('div');
      more.className = 'reference-project-grid';
      groups.slice(6).forEach(project => more.append(projectCard(project, variants)));
      details.append(summary, more);
      root.append(details);
    }
    return root;
  }

  function render(images, variants = {}) {
    for (const [category, label] of Object.entries(labels)) {
      const categoryImages = images.filter(image => image.category === category);
      const container = document.getElementById(category);
      if (!categoryImages.length || !container) continue;
      let content;
      if (category === 'konyha') content = kitchenGallery(categoryImages, variants);
      else {
        content = document.createElement('div');
        content.className = 'gallery';
        categoryImages.forEach(reference => content.append(photoButton(reference, `${label} referencia`, {})));
      }
      const previous = container.querySelector('.reference-project-list, .gallery, .empty-reference');
      if (previous) previous.replaceWith(content);
      else container.append(content);
    }
  }

  async function load() {
    try {
      const [response, variants] = await Promise.all([
        fetch(`https://torczkyodukcvxwzutgf.supabase.co/functions/v1/list-reference-images?v=${Date.now()}`,
          { cache: 'no-store', headers: { accept: 'application/json' } }),
        fetch('/reference-gallery-assets.json').then(result => result.ok ? result.json() : {}).catch(() => ({}))
      ]);
      if (!response.ok) return;
      const payload = await response.json();
      if (Array.isArray(payload.images)) render(payload.images, variants);
    } catch { /* Keep the existing fallback and the rest of the page usable. */ }
  }

  const api = { groupKitchenImages, imageSources, render };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    window.HEPAReferenceGallery = Object.freeze(api);
    load();
  }
})();

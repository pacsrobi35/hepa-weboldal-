(() => {
  'use strict';

  const heicTypes = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
  const prepared = new WeakMap();
  let decoderPromise;

  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name || '') || heicTypes.has((file.type || '').split(';')[0].trim().toLowerCase());
  }

  // The decoder and its worker are loaded only when a HEIC photo needs them.
  // Photos are converted on this device; the server receives ordinary JPEGs.
  function loadDecoder() {
    if (typeof window.HeicTo === 'function') return Promise.resolve(window.HeicTo);
    if (decoderPromise) return decoderPromise;
    decoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const fail = () => {
        clearTimeout(timer);
        script.remove();
        decoderPromise = null;
        reject(new Error('A fotók előkészítése nem indult el. Kérjük, próbálja újra.'));
      };
      const timer = setTimeout(fail, 20000);
      script.src = '/vendor/heic-to-1.6.5.js';
      script.onload = () => {
        if (typeof window.HeicTo !== 'function') { fail(); return; }
        clearTimeout(timer);
        resolve(window.HeicTo);
      };
      script.onerror = fail;
      document.head.appendChild(script);
    });
    return decoderPromise;
  }

  async function encodeBitmap(bitmap) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    try {
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('A képet nem sikerült előkészíteni.')),
        'image/jpeg', .9
      ));
    } finally {
      bitmap.close();
      canvas.width = canvas.height = 1;
    }
  }

  async function convert(file) {
    const header = new Uint8Array(await file.slice(0, 3).arrayBuffer());
    // Some phone pickers already convert the data, but retain the HEIC filename.
    if (header[0] === 255 && header[1] === 216 && header[2] === 255) return file;
    if (typeof createImageBitmap === 'function') {
      try { return await encodeBitmap(await createImageBitmap(file)); } catch { /* Use the bundled decoder below. */ }
    }
    const decoder = await loadDecoder();
    let timer;
    try {
      const jpeg = await Promise.race([
        decoder({ blob: file, type: 'image/jpeg', quality: .9 }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('A fotó előkészítése túl sokáig tartott.')), 60000); })
      ]);
      // Keep high resolution phone photos within a practical mobile upload size.
      if (typeof createImageBitmap === 'function') return await encodeBitmap(await createImageBitmap(jpeg));
      return jpeg;
    } finally {
      clearTimeout(timer);
    }
  }

  async function prepare(file, { maxBytes } = {}) {
    if (!isHeic(file)) return file;
    if (!file.size) throw new Error(`${file.name}: a fájl üres.`);
    if (maxBytes && file.size > maxBytes) throw new Error(`${file.name}: nagyobb a megengedett fájlméretnél.`);
    try {
      if (!prepared.has(file)) {
        const conversion = convert(file).then(async (jpeg) => {
          const bytes = new Uint8Array(await jpeg.slice(0, 3).arrayBuffer());
          if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255) throw new Error('A képet nem sikerült JPG-vé alakítani.');
          return new File([jpeg],
            (file.name || 'foto.heic').replace(/\.(heic|heif)$/i, '') + '.jpg',
            { type: 'image/jpeg', lastModified: file.lastModified }
          );
        });
        prepared.set(file, conversion);
        conversion.catch(() => prepared.delete(file));
      }
      const jpeg = await prepared.get(file);
      if (!jpeg.size || jpeg.type !== 'image/jpeg') throw new Error('A képet nem sikerült előkészíteni.');
      if (maxBytes && jpeg.size > maxBytes) throw new Error('A kép az átalakítás után nagyobb a megengedett fájlméretnél.');
      return jpeg;
    } catch (error) {
      throw new Error(`${file.name}: ${error.message || 'A fotót nem sikerült előkészíteni. Kérjük, próbáljon másik képet vagy JPG-fájlt.'}`);
    }
  }

  window.HEPAPhotoUploads = { isHeic, prepare };
})();

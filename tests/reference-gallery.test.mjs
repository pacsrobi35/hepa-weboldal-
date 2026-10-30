import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { groupKitchenImages, imageSources } = require('../reference-gallery.js');
const variants = JSON.parse(readFileSync(new URL('../reference-gallery-assets.json', import.meta.url)));
const currentImages = Object.entries(variants).map(([id, asset]) => ({ id: Number(id), category: 'konyha', url: asset.original }));

test('every published photo survives grouping, including new uploads and changed API order', () => {
  const newPhoto = { id: 999, url: 'https://example.com/new.webp', category: 'konyha' };
  const published = [newPhoto, ...currentImages.toReversed()];
  const groups = groupKitchenImages(published);
  const actual = groups.flatMap(group => group.photos);
  assert.deepEqual(actual.map(image => image.id).sort((a, b) => a - b), published.map(image => image.id).sort((a, b) => a - b));
  assert.equal(new Set(actual.map(image => image.id)).size, published.length);
  assert.ok(actual.includes(newPhoto));
  assert.deepEqual(published[0], newPhoto, 'The API response is not mutated.');
});

test('unpublished or removed CMS images are never resurrected from the static asset catalogue', () => {
  const published = currentImages.filter(image => ![60, 52, 18].includes(image.id));
  const result = groupKitchenImages(published).flatMap(group => group.photos);
  assert.equal(result.length, published.length);
  assert.ok(!result.some(image => [60, 52, 18].includes(image.id)));
});

test('replacing a CMS image with the same id uses the new original, not a stale optimized copy', () => {
  const original = currentImages[0];
  assert.notEqual(imageSources(original, variants).thumbnail, original.url);
  const replacement = { ...original, url: 'https://example.com/replaced.webp' };
  assert.deepEqual(imageSources(replacement, variants), { thumbnail: replacement.url, full: replacement.url });
});

test('every local optimized variant exists and no full-size PNG is needed for the existing kitchen gallery', () => {
  assert.equal(currentImages.length, 29);
  for (const image of currentImages) {
    const source = imageSources(image, variants);
    for (const path of [source.small, source.medium, source.full].filter(path => path.startsWith('/'))) {
      assert.ok(existsSync(fileURLToPath(new URL(`..${path}`, import.meta.url))), path);
    }
    assert.ok(!source.full.endsWith('.png'));
    assert.ok(source.width > 0 && source.height > 0);
  }
});

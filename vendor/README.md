# HEIC photo decoder

`heic-to-1.6.5.js` is the unmodified IIFE build of [heic-to 1.6.5](https://github.com/hoppergee/heic-to), licensed under LGPL-3.0. The license is included in `heic-to-LICENSE.txt`.

The exact release, including source and build scripts, is available at https://registry.npmjs.org/heic-to/-/heic-to-1.6.5.tgz . The upstream package bundles libheif and libde265; their source and license information is maintained in the upstream package's README and build instructions. The decoder is loaded only for HEIC/HEIF files that the browser cannot decode itself, and conversion takes place locally.

To update, download a pinned upstream release, retain its license, replace this standalone build and update the URL in `photo-uploads.js`. Keep decoding optional for ordinary JPEG/PNG/PDF uploads.

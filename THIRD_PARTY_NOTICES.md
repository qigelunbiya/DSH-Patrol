# Third-party notices

Parts of `browser-bridge-runtime/` and the browser-extension protocol design are derived from
[dsh-browser-bridge](https://github.com/egnmosk/dsh-browser-bridge), licensed under the MIT License.

MIT License

Copyright (c) 2026 dsh-browser-bridge contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ddddocr

DSH Patrol's optional owned-site CAPTCHA demo helper installs and imports `ddddocr` 1.6.1 from PyPI at local setup time. The ddddocr project is distributed under the MIT License.

- Upstream: https://github.com/sml2h3/ddddocr
- License: MIT
- DSH Patrol does not vendor or modify ddddocr's source or model files in this repository; the optional local Python virtual environment is ignored by Git.

## Text_select_captcha

The public `MgArcher/Text_select_captcha` repository was reviewed for its documented architecture and API shape. At the time this integration was implemented, the repository did not publish a license through GitHub and did not contain a root LICENSE file, so DSH Patrol does **not** copy, vendor, redistribute, or import its source/model files. The owned-site ordered-click implementation in DSH Patrol is an independent implementation using ddddocr detection/OCR plus local image processing.

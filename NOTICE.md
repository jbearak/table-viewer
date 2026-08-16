# Third-party notices

Table Viewer is licensed under the [GPL-3.0](LICENSE). This file covers the
third-party assets that are not npm packages — the bundled color themes, which
are ports/adaptations of the palettes below into this app's own
`--vscode-*` variable set (see `desktop/main/theme-definitions.ts`). No upstream
code is included; only the color values, remapped onto this app's roles.

All are MIT licensed except Cyberpunk, whose upstream states two licenses (noted
in its entry). Every one of them permits this use under GPL-3.0.

- **Solarized** — Copyright (c) 2011 Ethan Schoonover — <https://github.com/altercation/solarized>
  (ported as "Solarized Light" and "Solarized Dark")
- **Catppuccin** — Copyright (c) 2021 Catppuccin — <https://github.com/catppuccin/catppuccin>
  (ported as "Catppuccin Latte", "Frappé", "Macchiato", and "Mocha")
- **SynthWave '84** — Copyright (c) 2019 Robb Owen — <https://github.com/robb0wen/synthwave-vscode>
  (ported as "SynthWave '84")
- **gruvbox** — Copyright (c) Pavel Pertsev (morhetz) — <https://github.com/morhetz/gruvbox>
  (ported as "Gruvbox Light Hard/Medium/Soft" and "Gruvbox Dark Hard/Medium/Soft").
  The palette comes from upstream's `colors/gruvbox.vim`; where a color's *role*
  in an editor UI needed deciding, the mapping follows the MIT-licensed VS Code
  port, Copyright (c) 2017 JD (jdinhify) — <https://github.com/jdinhify/vscode-theme-gruvbox>
- **Cyberpunk** — Copyright (c) Max SS — <https://github.com/prometheux-ar/cyberpunk>
  (ported as "Cyberpunk" and "Cyberpunk Scarlet Protocol", the latter from
  upstream's "Activate SCARLET protocol" variant). That project's `package.json`
  declares MIT while the repository also ships a GPL-3.0 `LICENSE` file; the two
  disagree, but either grant permits this port, since this app is itself GPL-3.0
  (see [LICENSE](LICENSE) for the GPL-3.0 text).
- **Red** — Copyright (c) Microsoft Corporation —
  <https://github.com/microsoft/vscode/tree/1.101.0/extensions/theme-red>
  (ported from VS Code 1.101's built-in `vscode.theme-red`).

## MIT License

Every MIT notice above is the unmodified MIT license, so its text is reproduced
once rather than once per project — per-project duplication only invites drift.

MIT License

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

## Bundled npm package licenses

The packaged desktop app also ships `THIRD_PARTY_NOTICES.txt`, covering every npm
package bundled into it: the license text where the published tarball includes
one, and otherwise the license identifier from the package metadata — some
packages publish a license identifier without shipping the text. It is generated
from `package-lock.json` by `desktop/collect-licenses.mjs` at build time and is
therefore not checked in; the packaged app puts it in `Contents/Resources`, and
the About window (**About Table Viewer**) opens it. Electron's own license and
the Chromium third-party notices ship alongside it.

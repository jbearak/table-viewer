# @jbearak/dta-parser 1.1.0, vendored

`jbearak-dta-parser-1.1.0.tgz` is the npm package `@jbearak/dta-parser`
1.1.0, which reads Parquet as well as `.dta`. It is not on npm yet, so
`package.json` installs it from this file:

```json
"@jbearak/dta-parser": "file:vendor/dta-parser/jbearak-dta-parser-1.1.0.tgz"
```

`package-lock.json` records the tarball's sha512 integrity, so `npm ci`
fails if the file changes. `docs/plans/parquet.md` explains why the
package is vendored and what happens when 1.1.0 is published.

## Provenance

- Source: https://github.com/jbearak/dta-parser at commit
  `394562f` (main, "Parquet docs pass Gate 2 in round 3 ...").
- sha256: `04eec0f59d136c67b8a3ebd1f48b490cc967346d9804d41078a686d6e89ba8b2`
- Built on macOS (arm64) with rustc 1.99.1 (rustup's stable toolchain,
  with the `wasm32-unknown-unknown` target), Homebrew clang 23.1.4 and
  `llvm-ar` for zstd, Node 26.12.1, and npm 11.20.0.

From a checkout of dta-parser at that commit:

```sh
T=~/.rustup/toolchains/stable-aarch64-apple-darwin/bin
PATH="$T:$PATH" CARGO=$T/cargo RUSTC=$T/rustc sh scripts/build-wasm.sh
cd js
npm ci
npm run build
npm pack
```

## Releases

A Table Viewer release would ship this unpublished version, so
`scripts/check-release-dependencies.mjs` fails every job of
`.github/workflows/release-build.yml` while any runtime dependency is a
`file:` dependency. When 1.1.0 is on npm, depend on `^1.1.0`, check
that the registry tarball's sha256 matches the one above (or, for a
different build, that its `dist/` files match), and delete this
directory and the check.

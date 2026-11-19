# pqparser 0.0.2, vendored

`pqparser-0.0.2.tgz` is what `npm pack` made from
[jbearak/pqparser](https://github.com/jbearak/pqparser) at commit
d17145f (pull request #3). pqparser is not on npm. It reads Parquet
files for Table Viewer: TypeScript over arrow-rs, with a wasm module that
the tarball embeds, so installing it needs no Rust.

Built on macOS with:

    rustup's stable toolchain (rustc 1.99.1), target wasm32-unknown-unknown
    Homebrew LLVM 23.1.4 (clang and llvm-ar, for zstd's C code)
    Node 26.12.1, npm 11.20.0

    sh scripts/build-wasm.sh   # with CC_wasm32_unknown_unknown and AR_wasm32_unknown_unknown set to Homebrew's clang and llvm-ar
    npm ci && npm run build && npm test   # 208 tests pass
    npm pack

sha256: `1b4343abd829d0cf383cf780c214dd4c161851cf875e18d2553adf270af861ac`

`package-lock.json` records the tarball's sha512 integrity, so `npm ci`
fails if the file changes. The extension and desktop bundles inline the
package, so neither reads `vendor/` at run time; `.vscodeignore` leaves
it out of the VSIX. To update it, build the new version the same way,
replace the tarball, and run `npm install --save
file:vendor/pqparser/pqparser-<version>.tgz`.

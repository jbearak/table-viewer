# OOXML surgery package boundary

Stage 7 declares the future package boundary in-tree without physically extracting a package. The intended package identity is `@jbearak/ooxml-surgery`; extraction remains work for #240.

## Public entry point

`src/ooxml-surgery/index.ts` is the sole public TypeScript root. Its one operation is:

```ts
apply_worksheet_edits(request: WorksheetEditRequest): WorksheetEditResult
```

The request supplies one worksheet XML part as bytes, its optional relationships part as text, ordered cell and hyperlink edits, and the existing TypeScript write options. The result supplies replacement worksheet bytes, replacement relationships text (or `null` when that part is unchanged), and whether a formula was removed.

The operation composes the behavior that previously lived directly in `xlsx-package.ts`:

1. promote a cleared hyperlink's display text when no cell already supplies it;
2. apply cell edits through the shared byte scanner;
3. widen `dimension` for effective cell edits;
4. apply worksheet hyperlink and relationships edits;
5. report formula removal so the host can remove `calcChain.xml`.

It is pure with respect to the `.xlsx` container. It does not locate package parts, mutate CFB entries, serialize ZIP data, parse workbook/style metadata, or remove package relationships.

Runtime exports are intentionally limited to:

- `apply_worksheet_edits`
- `OoxmlRefusalError`
- `OOXML_SURGERY_API_VERSION`
- `OOXML_CONFORMANCE_VERSION`

The public root also exports the structural request/result, edit, write-context, rich-text, hyperlink, and refusal-code types needed to call the operation.

Low-level scanners, spans, offsets, splicers, namespace frames, formula counters, and dimension helpers remain implementation details. Their behavior is covered only through observable output bytes and refusal codes; they are not portability contracts.

## Dependency boundary

The package implementation closure is:

- `src/ooxml-surgery/**`
- `src/ooxml-refusal.ts`
- `src/ooxml-worksheet-scan.ts`
- `src/ooxml-xml.ts`
- `src/ooxml-relationships.ts`
- `src/xlsx-cell-write.ts`
- `src/xlsx-hyperlink-write.ts`
- the OOXML-facing style/run/hyperlink types and `text_styles_equal` from `src/cell-content.ts`
- `conformance/**`

The following stay in Table Viewer as host adapters:

- `src/xlsx-package.ts`: CFB/ZIP reads and writes, worksheet routing, atomic package replacement, calc-chain removal, and package serialization;
- `src/parse-xlsx.ts`: workbook and worksheet reader integration;
- `src/xlsx-rich-text.ts` and `src/spreadsheet-format.ts`: workbook style parsing used to build `XlsxWriteOptions`;
- viewer/controller/edit-session code; and
- benchmark fixtures and frozen baselines.

The TypeScript API may retain callback lookups in `XlsxWriteOptions`. The cross-language conformance format does not: it records date and font context as tables, and each implementation adapts those tables to its native lookup mechanism.

## Migration plan for #240

1. Create the standalone `@jbearak/ooxml-surgery` package and move the implementation closure above without behavior changes.
2. Publish JavaScript, declarations, and the versioned `conformance/` directory only. Do not add Rust, Node-API, WASM, postinstall compilation, native artifacts, or a new runtime dependency as part of the extraction.
3. Keep API version `1` and corpus version `1.0.0`; publish an exact implementation pin equivalent to `conformance/pins/typescript.json`.
4. Add an exact Table Viewer dependency (no caret) and pin the resolved artifact in the lockfile.
5. Before cutover, run the same checked-out corpus once against the in-tree façade and once against the installed package. Require identical output bytes, identical refusal codes, and identical normalized no-authoritative-body outcomes.
6. Change the `xlsx-package.ts` import from the local façade to `@jbearak/ooxml-surgery`.
7. In that same #240 cutover, keep the reader bound to the exact moved scanner implementation—either by moving its worksheet core behind the package or through a package-owned reader adapter. Do not copy the scanner or ship local and packaged implementations side by side.
8. Remove the local implementation closure in the cutover change after the packaged path passes TypeScript, the complete two-project Vitest suite, package byte-preservation tests, and the OOXML performance gate. Rollback uses version control and the exact package pin, not a dormant second scanner.
9. A later Rust implementation under #240 claims compatibility by running this same corpus and declaring the exact corpus revision it satisfies. Excel round-trip fixtures may supplement the authored goldens, but do not rewrite version `1.0.0`.

## Deliberate non-goals and deferred surface

This boundary does not restructure the reader hot path, redesign refusal codes, generalize the scanner into an XML parser, or change non-worksheet parts to bytes. Workbook, styles, shared strings, content types, and the `.rels` half of hyperlink editing remain string-based where they are today.

The known legacy namespace surface remains deferred: prefixed `row`/`c`/`f`/`is`/`v` identity checks and the `<f>` namespace checks are range-scoped rather than structurally scoped. Extraction must preserve that behavior until a separately reviewed change replaces it.

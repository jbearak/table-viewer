# Worksheet OOXML conformance corpus

This directory is the language-neutral compatibility contract for surgical worksheet edits. It describes one pure operation: apply ordered edits to UTF-8 worksheet bytes and observe either exact output bytes, one stable refusal code, or the legacy plain no-authoritative-`sheetData` outcome.

The corpus deliberately does **not** expose scanner spans, byte offsets, namespace stacks, detector names, TypeScript classes, or any other implementation structure. A port may tokenize or organize the document differently as long as these observable results agree.

## Version pins

Corpus revision `1.1.0` is recorded independently in four places so an implementation cannot claim compatibility accidentally:

- `VERSION`
- `manifest.json` → `corpus_version`
- `pins/typescript.json` → `corpus_version`
- `src/ooxml-surgery/version.ts` → `OOXML_CONFORMANCE_VERSION`

`manifest.json` also pins package API version `1`, matched by `OOXML_SURGERY_API_VERSION`. `schema-v1.json` describes format version `1` using JSON Schema 2020-12.

Any change to a fixture, edit, context, golden output, expected outcome, or refusal code creates a new immutable corpus revision. A schema-shape change also increments `format_version` and adds a new schema file rather than rewriting `schema-v1.json` in place.

## Portable case format

Every case contains:

- a stable kebab-case `id` and human description;
- one relative UTF-8 XML fixture path;
- ordered zero-based cell edits (`row`, `column`, `value`, optional `force_text` and rich-text `runs`);
- pure JSON style context; and
- one expected observable outcome.

Style context is data, never executable behavior:

- `date_system`: `"1900"` or `"1904"`;
- `date_style_matches`: exact `(style_index, serial)` pairs for date classification;
- `font_styles`: style-indexed bold/italic/underline/strikethrough flags; and
- `run_font_bases`: style-indexed raw run-property XML.

An implementation adapter may turn those tables into its native lookup mechanism. No callback, expression, regex, class, `Map`, or `Set` crosses the language boundary.

Expected outcomes are:

- `output`: compare the resulting worksheet part to the named golden as raw bytes;
- `refusal`: compare only the five-code `OoxmlRefusalCode`; or
- `no-authoritative-sheet-data`: normalize the existing plain structural error without pinning its prose or inventing a sixth refusal code.

The five refusal codes are exactly:

1. `namespace-prefixed-worksheet-element`
2. `markup-compatibility-alternate-content`
3. `foreign-worksheet-namespace`
4. `missing-cell-reference`
5. `invalid-cell-reference`

## Initial 41 cases

### Exact successful outputs

| Case | Contract pinned |
|---|---|
| `basic-replace-preserves-style` | Replacements retain the existing style index. |
| `insert-cells-in-column-order` | Inserts are ordered by coordinate, not request order. |
| `commented-cell-is-text` | Cell-shaped comments remain untouched text. |
| `cdata-and-pi-are-text` | CDATA and processing-instruction payloads are not live cells. |
| `duplicate-coordinate-last-wins` | The last scanned duplicate coordinate receives the edit. |
| `whitespace-in-end-tags` | Whitespace-bearing cell and row end tags remain writable. |
| `self-closing-sheet-data` | A self-closing body expands while retaining attributes. |
| `self-closing-row` | A self-closing row expands, retains unrelated attributes, and drops stale `spans`. |
| `entity-spelled-reference` | A decoded canonical coordinate edits in place without duplication. |
| `single-quoted-reference-and-style` | Single-quoted references and styles are read and preserved. |
| `grouped-formula-outside-edit` | An edit outside a shared-formula range leaves the group byte-preserved. |
| `merged-top-left-edit` | Editing a merge's top-left cell preserves its follower declaration. |
| `transitional-root-redundant-declarations` | Transitional root plus same-dialect redundant declarations succeeds. |
| `strict-root-redundant-declarations` | ISO Strict root plus same-dialect redundant declarations succeeds. |
| `first-direct-sheet-data-is-authoritative` | The first complete unprefixed direct body is selected; nested and later lookalikes are untouched. |
| `bare-alternate-content-is-not-mc` | A bare name with no MC binding does not acquire the MC refusal. |
| `wrongly-bound-mc-prefix-is-not-mc` | An `mc` prefix bound to a vendor URI does not acquire the MC refusal. |
| `disjoint-extension-alternate-content` | Vendor names and exact MC content in disjoint `extLst` payloads stay opaque. |
| `prefixed-namespace-declaration-is-accepted` | An unused prefixed declaration does not rebind unprefixed worksheet elements. |
| `maximum-cell-reference` | `XFD1048576` is accepted at the exact format boundary. |
| `date-style-context-is-data` | Data-only style context can drive date-to-serial writing. |
| `supported-prefixed-sheet-data` | A direct prefixed SpreadsheetML body is edited with matching qualified names. |

### Structured refusals

| Case | Contract pinned |
|---|---|
| `cross-dialect-descendant` | A descendant that switches SpreadsheetML dialect refuses as foreign. |
| `foreign-root` | A genuinely foreign worksheet root refuses. |
| `mc-alternate-content-inside-sheet-data` | Exact expanded-name MC content inside the authoritative body refuses. |
| `mc-wrapper-with-sheet-data-candidate` | A direct MC wrapper with no body refuses only when its subtree contains a SpreadsheetML body candidate. |
| `missing-cell-reference` | A missing `r` has its own refusal code. |
| `column-past-format-limit` | `XFE1048576` is invalid. |
| `row-past-format-limit` | `XFD1048577` is invalid. |
| `leading-zero-row-reference` | `A01` is invalid rather than normalized. |
| `lowercase-reference` | `a1` is invalid rather than normalized. |
| `row-zero-reference` | `A0` is invalid. |
| `early-invalid-before-late-prefixed` | An earlier invalid cell beats a later prefixed element. |
| `early-invalid-before-late-mc` | An earlier invalid cell beats later exact MC content. |
| `ancestor-foreign-before-descendant-missing` | A foreign ancestor beats a descendant missing `r`. |
| `same-tag-foreign-before-invalid` | Within one opening tag, foreign namespace beats invalid `r`. |
| `early-prefixed-before-late-invalid` | Reversing physical order reverses the primary code. |

### Plain structural outcomes

| Case | Contract pinned |
|---|---|
| `mc-wrapper-without-sheet-data-candidate` | A direct MC wrapper without a body candidate does not receive the MC code. |
| `nested-mc-wrapper-with-sheet-data-candidate` | An exact MC wrapper nested outside the worksheet root’s direct children does not receive the MC refusal, even when its subtree has a SpreadsheetML body candidate. |
| `nested-vendor-sheet-data-only` | A nested vendor body is never selected or written. |
| `foreign-prefixed-sheet-data-only` | A direct foreign-prefixed lookalike does not explain absence or receive a worksheet refusal code. |

Run `npm run test:ooxml:conformance` for the corpus and public-boundary checks. The repository's required release gate remains the bare `npx vitest run`, which includes both Vitest projects.

# A shared byte-oriented OOXML scanner for the XLSX reader and writer (#153)

Parent tracker: #240. Sibling: #241 (arbitrary worksheet extents).
Scope here is **TypeScript only** — no Rust, Node-API, WASM, or native artifacts
enter Table Viewer (#153 acceptance criterion (g)).

## Problem

The reader and the writer scan the same worksheet XML with two different
scanners, and they disagree.

Only two reader scans are markup-aware: `find_element_section(xml,
'hyperlinks')` (`parse-xlsx.ts:468`) and `.rels` via `parse_relationships`. The
entire `<sheetData>`/`<row>`/`<c>` hot path — plus sharedStrings, styles,
`dimension`, `mergeCells` — uses the naive `get_text`/`iter_elements` pair
(17 callsites in `parse-xlsx.ts`). Meanwhile `xlsx-cell-write.ts` hand-rolls its
own markup-aware equivalents (`indexOf_live`, `end_tag_after`, `scan_rows`,
`scan_cells`) plus 14 private attribute regexes.

`assert_writable_sheet_data` (`xlsx-cell-write.ts:1049-1196`) exists to fail
closed over exactly that gap: 9 `unsupported()` sites whose only job is to
refuse shapes where the two scanners would diverge. They share one local
`unsupported()` closure emitting a single "cannot edit safely" message, which is
why 8 separate tests all assert the same regex.

Git history measures the cost. **9 of the 37 commits that have ever touched
`xlsx-cell-write.ts` are reader/writer agreement fixes** — about a quarter of
the file's history: "Make the writer agree with the reader about the same file",
"Agree with the reader on the sheetData close and on namespaces", "Match the
reader on duplicate rows, comments, and slot entitlement", "Edit the row element
the reader shows, not the first one", "Read XML the way a parser does in three
more places", "Refuse three more reader/writer disagreements", and three more.
That is the recurring tax this issue retires.

The divergence is confined to this one pair. `src/xlsx-hyperlink-write.ts`
(451 lines) hand-rolls no scanning at all — it already imports the shared
`ooxml-xml` primitives including the markup-aware ones (`iter_elements_markup`,
`last_index_of_markup`). So there is no third scanner to reconcile, and Stage 2's
extraction surface is exactly the writer's private machinery.

I verified four divergence classes by running the code:

| Shape | Reader sees | Writer sees | Outcome today |
|---|---|---|---|
| commented-out `<row>` before a live one | both cells | live only | refused by guard |
| `r='A1'` (single-quoted) | `A1` | invisible | refused |
| `r="A&#49;"` (entity) | `A1` (decoded) | invisible | refused |
| **`r="a1"` (lowercase)** | **rejected — no cell** | **accepted** | **silent duplicate coordinate on save** |

The last one is a **live bug**, not a refusal. `parse_cell_ref` requires
`/^([A-Z]+)(\d+)$/` so the reader drops the cell; `letter_to_index` accepts
lowercase and computes a wrong index. A save emits both cells into one row:

```xml
<c r="a1"><v>5</v></c><c r="A1" t="inlineStr">…</c>
```

### Two stale doc comments, both load-bearing for a reader of this code

- `xlsx-cell-write.ts:413` — `Span` is documented as "`[start, end)` byte
  offsets". The values are **UTF-16 string indices**. On a 200k-row sheet with
  one accented character per row the drift reaches 199,999 bytes.
- `ooxml-xml.ts:9` — says `get_attr` "reads only double-quoted values". The
  implementation handles both quote forms.

### The memory cost is real, live, and fixable inside #153

I previously told you byte offsets buy correctness but not speed, and that the
memory win belonged to #240's ZIP work. That was wrong, and it is the reason
this plan has a byte-offset stage.

Measured on the committed fixture
`src/test/fixtures/undesa_pd_2024_wcu_country_data_survey-based.xlsx`
(`sheet4.xml` = 57.2 MiB, 70,453 rows):

| Path | RSS after two forced GCs | `external` delta |
|---|---|---|
| hold `bytes.toString('utf8')` | 236.9 MiB | **+57.2 MiB** |
| byte scan, no string | 179.5 MiB | −123.6 MiB |

That 57.2 MiB survives `global.gc()` twice, so it is **steady-state live
memory, not a transient peak**. It is separable from `CFB.read`'s 59.8 MiB of
inflated entries (which *is* #240's problem) because `entry.content` is
**already a `Buffer`** — a byte scanner avoids the decode without touching ZIP
handling at all.

And the decode is nearly all waste. Of that 57.2 MiB part, the reader only ever
consumes:

- 11.6 MiB of `r`/`t`/`s` attribute values (3,723,097 values)
- 5.2 MiB of `<v>` text content (1,334,553 values) — all of it numeric, i.e.
  parseable straight from bytes with no JS string at all

**16.7 MiB = 29.3% of the part.** The other **40.4 MiB is markup that gets
decoded into a JS string and never read.**

Speed is a genuine non-goal here: byte scan 41 ms vs string scan 43 ms —
equivalent. Byte offsets buy **memory and correctness**. (Separately, and not
addressed by this plan: `ignorable_ranges` runs over the whole part ~7×/save at
74 ms ≈ 500 ms, and `formula_count` twice at 36 ms.)

## Sequencing constraint (verified, and the one ordering that matters)

**Guards come out only *after* attribute reads are shared, never before.**

Deleting the single-quote and entity guards requires first moving the writer's
private attribute regexes onto shared `get_attr`. Otherwise a single-quoted
`ref='A1:B2'` becomes invisible to `grouped_formula_ranges`, the array-formula
refusal silently stops firing, and a save corrupts a formula group. That is
Stage 3 before Stage 5, and it is not negotiable.

## Stages

Seven stages, each on its own branch off the issue branch, each merged back
`--no-ff` when its own simplify + review gates pass. Stages are **sequential** —
every stage builds on the previous one's merge, and Stage 6 needs Stage 1's
harness to prove its own claim. There is no fan-out here; the parallelism the
plan buys is *reviewer* parallelism inside each stage.

### Stage 1 — Memory + time benchmark harness

Nothing in this repo measures memory. `benchmarks/grid/compare.mjs` is
frame-timing only, and #240's RSS figures came from an uncommitted local probe.
Acceptance criterion (a) therefore requires *building* the thing it asks for —
uncosted scope in the issue as written.

- New `benchmarks/ooxml/` following `benchmarks/grid`'s conventions: exit 0
  pass / 1 regression / 2 shape error, baselines committed as JSON.
- Measure per phase (`CFB.read`, worksheet decode, coordinate scan, save): live
  RSS via fresh child processes + `process.resourceUsage().maxRSS`, plus
  `--expose-gc` double-GC `external`/`heapUsed` deltas. Both, because the
  peak/live distinction is exactly what I got wrong earlier.
- Baseline committed from `main` before any src change lands.
- **Touches no `src/`.** Fully risk-free.

### Stage 2 — Extract the shared worksheet scanner

- New `src/ooxml-worksheet-scan.ts`. Move the writer's markup-aware machinery
  (`indexOf_live`, `end_tag_after`, `scan_rows`, `scan_cells`,
  `row_indexes_from_cells`) out of `xlsx-cell-write.ts`.
- Writer consumes it. **Reader untouched. All 9 guards stay in place.**
- All 136 + 58 tests green, byte-identical save output.
- Pure refactor, no behavior change — this is the stage that makes the rest
  reviewable.

### Stage 3 — Share attribute reads (prerequisite for Stage 5)

- Writer's 14 private attribute regexes → shared `get_attr`.
- Fix both stale doc comments (`Span` "byte offsets", `get_attr`
  "double-quoted").
- Still no guard deletion, still no reader change.

### Stage 4 — Reader adopts the markup-aware scan

- `parse_worksheet_core`'s `<sheetData>`/`<row>`/`<c>` path moves onto the
  shared scanner. **Scoped to those three elements only** — sharedStrings,
  styles, `dimension`, `mergeCells` stay naive in this stage; widening them is
  not needed to close the divergence and would multiply the diff.
- The single authoritative coordinate rule lands here, one implementation, both
  sides (criterion (b)): **`<c r="…">` is the sole authority; last-scanned-wins
  per coordinate.** No positional inference, ever.
- `parse_xlsx` and `parse_xlsx_streaming` both funnel through
  `parse_worksheet_core`, so parity comes free; extend
  `xlsx-streaming-parity.test.ts` (existing precedent for parity-testing two
  implementations).

### Stage 5 — Refusal taxonomy, and the guards that can now go

Today every refusal is a plain `new Error(string)` — there is no structured
taxonomy, which is a blocker for a language-neutral corpus (criterion (f)).

- One `OoxmlRefusalError` with a stable `code`, optional `coordinate`, and
  today's human message preserved verbatim. Tests assert `code`, never prose.
- **Delete 4 guards** now dead because both sides share one scanner: cells
  inside comments/CDATA/PI, row-`r` disagreement, unreadable attributes, entity
  references. Plus **both `<sheetData>` hard errors**.
- **Keep 4:** namespace-prefixed cell elements, `AlternateContent`, **missing
  `r`**, foreign default namespace.
  - Missing `r` must stay, and I nearly got this wrong: the guard is *not*
    "invisible to both sides, nothing to disagree about". Excel infers a
    coordinate positionally where our contract has none, so we would write an
    explicit `<c r="B2">` and create a semantic duplicate of a cell Excel
    already knew about.
  - Namespace-prefixed cells and `AlternateContent` stay refusals. They are not
    reachable-with-more-work; they are shapes where the correct edit is
    genuinely undetermined.
- **Fixes the live lowercase bug:** reader keeps rejecting `r="a1"`, writer
  refuses with `invalid_cell_reference`. Never silently normalize to `A1` —
  inserting a coordinate we did not read is how the duplicate got emitted.
- Criterion (d) lands here.

### Stage 6 — Byte offsets

Justified by the 40.4 MiB above, and now provable because Stage 1 exists.

- Scanner operates on `Uint8Array`; `Span` becomes what its comment always
  claimed — true UTF-8 byte offsets.
- Decode only the ~29.3% actually consumed. Numeric `<v>` parses from bytes
  with no string allocation.
- Exact-span replacement demonstrated on real bytes, unrelated package content
  byte-identical (criterion (c)) — already how the writer splices, so this is
  preserved, not invented.
- Gate: **≥40 MiB live-RSS reduction** on the fixture, parse time within noise
  of baseline (speed is not the claim), all tests green.

### Stage 7 — Package boundary and conformance corpus

- Versioned language-neutral `conformance/` — fixtures, golden outputs, refusal
  codes, version pins. Criterion (f).
- **Correction to an earlier premise.** I had cited the sibling checkout
  `/Users/jmb/repos/Extensions/dta-parser` as precedent for a TS→Rust→R split
  pinned by a `conformance/cases.json`. I read it: that is not what it does.
  There is **no Rust in it at all** and no conformance corpus. Its R package
  (`r-package/dtaparser/`) **embeds the compiled TypeScript** in
  `inst/js/dta-parser.js` behind an `adapter.js` bridge, and its parity tests
  assert against **`haven`** — an external reference implementation — rather than
  against shared golden files.
  Two things follow. First, this repo has **no in-house precedent** for the
  corpus format, so Stage 7 is designing it rather than copying it, and should be
  costed accordingly. Second, dta-parser is still a useful precedent for the
  thing it actually demonstrates: shipping one implementation to a second
  language via an embedded-JS bridge, and pinning correctness to an independent
  reference implementation. For OOXML the analogue of `haven` is **Excel's own
  round-trip output** — worth considering as a corpus input for #240's port,
  since goldens we author ourselves can only prove self-consistency.
- Corpus asserts **observable outputs and refusal codes only — never internal
  spans**, so the Rust port can pin it without inheriting our data structures.
  **No callbacks in case context data** (today's `XlsxWriteOptions` passes
  `is_date_style`, `cell_font_style`, `run_font_base` as functions — those
  cannot cross a language boundary and must not leak into the corpus format).
- ~40 curated cases to start, migrating incrementally. The 136 existing
  `xlsx-cell-write.test.ts` names already map almost 1:1 onto the hostile shapes
  a corpus needs (CDATA, PIs, duplicate coordinates, whitespace end tags,
  self-closing, grouped formulas, merged followers, namespace declarations).
- Public TypeScript boundary declared **in-tree** (criterion (e)); physical
  extraction to a separate package happens under #240. dta-parser itself was
  built flat and split later — same trajectory, deliberately.

## Delegation and branch strategy

```
main
 └── issue153                     (integration branch, I own it)
      ├── issue153-s1-bench       → merge --no-ff at stage end
      ├── issue153-s2-extract     → merge --no-ff
      ├── … one per stage
      └── issue153-s7-conformance → PR to main
```

One level-2 subagent per stage. Each owns its stage branch end to end and,
before merging, dispatches its own level-3 reviewers:

1. Implement on `issue153-sN-<slug>`.
2. `npx tsc --noEmit` (strict TS is the only static gate — no ESLint, Prettier,
   or Biome in this repo) and `npx vitest run --project unit`.
3. Dispatch **simplification** and **review in parallel**, one message, several
   tool uses.
4. Address findings, re-verify, merge `--no-ff` into `issue153`, report back.

Available gates, verified present on this machine:

- `feature-dev:code-reviewer` — a listed agent type, correctness + conventions.
- `codex-review` — user skill at `~/.claude/skills/codex-review`, runs
  gpt-5.6-sol at xhigh and loops until clean. Its own guidance says to run it
  *alongside* Claude reviewers, not instead of them, because they find different
  things. Worth spending on Stages 5 and 6.
- Simplification: the `code-simplifier` plugin is enabled and its agent
  definition is at
  `~/.claude/plugins/cache/claude-plugins-official/code-simplifier/1.0.0/agents/code-simplifier.md`,
  but **`code-simplifier` is not in this session's list of resolvable agent
  types**. The stage agent should try it and, if it does not resolve, fall back
  to a `general-purpose` agent briefed with that file's charter — simplify for
  clarity while preserving exact behavior. Flagging rather than assuming it
  works.

House conventions the stage agents must follow: `snake_case` functions,
`kebab-case` files, `PascalCase` types. Per `CLAUDE.md`: never wait a fixed
delay for async work — poll for the observable result. And when the vitest
`unit` project is green but a desktop smoke test fails, rule out someone having
switched windows before treating it as a code bug.

## What this plan does not do

- No Rust, Node-API, WASM, or native dependency (criterion (g)).
- No XML DOM. The SAX-like scan is a deliberate perf choice.
- No whole-worksheet rewriting — exact-span splices only.
- No physical package extraction (#240).
- No ZIP/`CFB` memory work — that 59.8 MiB is #240's.
- No fix for the ~500 ms of repeated `ignorable_ranges` passes per save. Real,
  measured, out of scope; worth its own issue.
- `sharedStrings.xml` stays deliberately untouched on save, as today.
- sharedStrings/styles/`dimension`/`mergeCells` keep their naive scans.

## Risk

Stages 1–3 cannot change behavior — harness-only, then two pure refactors. The
live bug is fixed at Stage 5, which is also where the guard deletions land, and
those deletions are precisely the ones Stage 4 makes dead. Stage 6 is the only
stage whose value rests on a measurement, and Stage 1 exists so that
measurement is committed and reproducible rather than asserted.

The 194 existing tests across `xlsx-cell-write.test.ts` and
`xlsx-edit-session.test.ts` are the safety net for every stage, and Stage 2
deliberately does nothing except make the code they cover shared.

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

The last one is a **live bug**, not a refusal. `parse_cell_ref`
(`parse-xlsx.ts:262`) requires `/^([A-Z]+)(\d+)$/` so the reader drops the cell;
`letter_to_index` (`xlsx-cell-write.ts:734`) does `charCodeAt(i) - 64`, which for
`'a'` (97) yields **column 32**, not 0. Verified by running both:

```
a1   reader=REJECTED       writer_col=32
A0   reader=row -1 col 0   writer_col=0
```

A save emits both cells into one row:

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

**Correction: there is no non-ASCII penalty.** I predicted decode would cost
~1.75× the part on accented text and that the win would be larger for
international workbooks. Stage 1's harness measured 0.982, and re-testing
confirms the harness is right and I was wrong:

| Content | Part size | Decode cost | Ratio |
|---|---|---|---|
| ASCII (real fixture) | 57.2 MiB | 57.2 MiB | 1.00 |
| Latin-1 (`café`) | 26.3 MiB | 25.8 MiB | 0.98 |
| CJK (`数値`) | 9.3 MiB | ~9.5 MiB | ~1.0 |

V8 uses a one-byte string representation whenever *every* character is Latin-1,
and `é` (U+00E9) is Latin-1 — so accented text never widens. Even genuine CJK
measured ~1.0×. My earlier synthetic test had compared two differently-sized
parts and I misattributed the difference to widening.

The decode cost is therefore ~1.0× the part regardless of content. Simpler than
claimed, and it still fully justifies Stage 6 — it just is not larger for
international workbooks. Stage 1 baselines a synthetic non-ASCII worksheet anyway
(criterion (a) says worksheets, plural), which is how the error was caught.

**A measurement trap, recorded because it cost me a wrong conclusion once
already.** Do not compute the decode cost as summed `heapUsed + external` deltas
in a single process: the source `Buffer` is re-accounted and the deltas cancel to
a bogus +0.0 MiB. Trust `maxRSS` from a fresh child process per phase, and the
`external` delta *alone* after two forced GCs. The harness reports the two fields
separately, never pre-summed.

**Stage 6 removes a minority share of a save, and this plan should say so.**
Stage 1's committed baseline, one single-cell edit on the 57.2 MiB fixture:

| Phase | Peak RSS | vs part | Time |
|---|---|---|---|
| `cfb-read` | 125.5 MiB | 2.2× | 194 ms |
| worksheet decode | 183.0 MiB | — | 3.4 ms |
| coordinate scan | 248.0 MiB | 4.3× | 554 ms |
| **full save** | **582.5 MiB** | **10.2×** | **2396 ms** |

The write path alone adds 334.5 MiB above the read peak. Stage 6's target is the
57.2 MiB decode — real, but a minority share of a 582 MiB save. The 57 MiB
headline must not be read as fixing saves; the remaining write-path and CFB costs
belong to #240.

Speed is a genuine non-goal here: byte scan 41 ms vs string scan 43 ms —
equivalent, and the baseline confirms it from the other direction — decode is
3.4 ms against a 554 ms coordinate scan. Byte offsets buy **memory and
correctness**. (Separately, and not
addressed by this plan: `ignorable_ranges` runs over the whole part ~7×/save at
74 ms ≈ 500 ms, and `formula_count` twice at 36 ms.)

## Sequencing constraint (verified, and the one ordering that matters)

**Guards come out only *after* attribute reads are shared, never before.**

Deleting the single-quote and entity guards requires first moving the writer's
private attribute regexes onto shared `get_attr`. That is Stage 3 before Stage 5,
and it is not negotiable.

I verified it by running `grouped_formula_ranges`' two actual regexes
(`xlsx-cell-write.ts:784` and `:786`) against hostile forms. **Three of four slip
through:**

```
GUARDED    <f t="array" ref="A1:B2">
UNGUARDED  <f t='array' ref='A1:B2'>       t= missed, ref missed
UNGUARDED  <f t="array" ref='A1:B2'>       ref missed
UNGUARDED  <f t="array" ref="A&#49;:B2">   ref missed
```

And the failure is silent by construction: the function does `if (!ref)
continue`, so a `ref` it cannot parse is treated as *not a grouped formula*
rather than as something to refuse. Today the entity and single-quote guards
catch all three upstream, before this code runs. Remove those guards while these
regexes are still private and the array-formula refusal quietly stops firing on
every one of them — and a save then rewrites a cell inside a live formula group.
That is the concrete corruption the ordering prevents.

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

- New `src/ooxml-worksheet-scan.ts`. Move the writer's markup-aware machinery out
  of `xlsx-cell-write.ts` (line numbers verified):

  | Function | Line | Note |
  |---|---|---|
  | `row_indexes_from_cells` | 447 | |
  | `live_tags_in` | 498 | **exported**; `xlsx-package.ts:562` consumes it |
  | `live_tags` | 557 | private; explicit range + precomputed ignorables |
  | `indexOf_live` | 585 | |
  | `end_tag_after` | 615 | |
  | `scan_rows` | 647 | `Map<number, Span[]>` — plural, emulates reader precedence |
  | `scan_cells` | 705 | |

- **Both tag generators must survive.** Private `live_tags` (range-scoped, hot
  path) and exported `live_tags_in` (whole-document convenience, external
  consumer in `xlsx-package.ts`) look redundant but are not interchangeable.
  Collapsing them is a behavior change, and Stage 2 is a pure refactor.
- Writer consumes it. **Reader untouched. All 9 guards stay in place.**
- All 136 + 58 tests green, byte-identical save output.
- Pure refactor, no behavior change — this is the stage that makes the rest
  reviewable.

### Stage 3 — Share **and harden** attribute reads (prerequisite for Stage 5)

Routing the writer's regexes through today's `get_attr` is **not sufficient**,
and this is the most important thing the architecture review caught. I verified
it against `get_attr` as written (`ooxml-xml.ts:35`):

```
A1     <c r="A1">                                    ok
A1     <c r='A1'>                                    ok
null   <c r = "A1">                                  MISSED (whitespace around =)
Z99    <c note="text containing r='Z99'" r="A1">     WRONG CELL
Z99    <c note='has r="Z99" inside' r="A1">          WRONG CELL
```

`get_attr` uses `\br=(?:"…"|'…')` with no notion of being inside another
attribute's value, so an attribute-shaped substring in an earlier value wins.
That does not merely hide a cell — it returns **a different cell's coordinate**.

What holds the line today is the very guard Stage 5 deletes. The
unreadable-attribute check (`xlsx-cell-write.ts:1155`) is written as a
**subtraction that fails closed**: it removes every canonical `name="value"` pair
and refuses if any non-whitespace remains. `r = "A1"` leaves `r =`; single-quoted
values are never stripped. Both refuse.

So Stage 3's real job is to make the shared reader actually correct:

- Replace `get_attr`'s regex with a small **opening-tag attribute lexer** that
  tracks quote state, accepts both quote forms, allows XML whitespace around `=`,
  and matches whole attribute names only.
- Then move the writer's 14 private attribute regexes onto it.
- Fix both stale doc comments (`Span` "byte offsets", `get_attr`
  "double-quoted").
- Still no guard deletion, still no reader change.

Stage 5 may delete the unreadable-attribute guard **only** once the lexer handles
these cases, with a test per row of the table above.

**Scope note: 30 `get_attr` call sites across 4 modules** — `parse-xlsx.ts`,
`xlsx-hyperlink-write.ts`, `ooxml-relationships.ts`, `xlsx-rich-text.ts`. This is
not a local change, so the lexer must be a strict improvement: every currently-
working call must return exactly what it returns today.

**Two traps, found by prototyping the lexer and diffing it against today's
behavior.** I hit both in a first sketch:

| Tag | Today | Naive lexer | Verdict |
|---|---|---|---|
| `<c r = "A1">` | `null` | `A1` | fix |
| `<c note="…r='Z99'…" r="A1">` | `Z99` | `A1` | fix |
| `<c\nr="A1"\ns="7">` | `A1` | **`null`** | **REGRESSION** |
| `<c vendor:r="A1">` | `A1` | `null` | fix (see below) |

- **Do not split the tag name on a space.** A sketch using `tag.indexOf(' ')`
  breaks newline-separated attributes, which is how a pretty-printer spells an
  ordinary cell. This is not hypothetical: it is tested at
  `xlsx-cell-write.test.ts:831`, and the writer's comment at
  `xlsx-cell-write.ts:1144` records it as a bug already fixed once. Split on any
  XML whitespace.
- **A prefixed attribute is not the unqualified one.** `vendor:r` must not satisfy
  a query for `r` — today's `\b` boundary lets it through. Returning `null` is
  correct, and Stage 5 then classifies such a cell as `missing-cell-reference`.

Both directions need tests: the fixes, and the two behaviors that must *not*
change.

### Stage 4 — Reader adopts the markup-aware scan

- `parse_worksheet_core`'s `<sheetData>`/`<row>`/`<c>` path moves onto the
  shared scanner. **Scoped to those three elements only** — sharedStrings,
  styles, `dimension`, `mergeCells` stay naive in this stage; widening them is
  not needed to close the divergence and would multiply the diff.
- The exact surface, verified: `parse-xlsx.ts:355` (`get_text(xml,'sheetData')`),
  `:357` (`iter_elements(…,'row')`), `:358` (`iter_elements(…,'c')`), plus the two
  nested reads inside the cell loop at `:370` (`get_text(c_inner,'v')`) and `:404`
  (`get_text(c_inner,'is')`). The other 12 naive callsites in the file are out of
  scope for this stage.
- **Why the `<sheetData>` close matters here.** `get_text` (`ooxml-xml.ts:336`)
  finds its close tag with a plain `indexOf('</sheetData>')` and no depth
  tracking or whitespace tolerance, while the writer scans for an end tag that may
  carry internal whitespace. That mismatch is exactly one of the two
  `<sheetData>` divergence errors Stage 5 deletes — so Stage 4 must adopt the
  writer's end-tag scan, not merely the element iteration, or the guard cannot
  come out.
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

- One `OoxmlRefusalError` in its own leaf module `src/ooxml-refusal.ts`, with a
  stable `code`, optional `coordinate`, and today's human message preserved
  verbatim. Tests assert `code`, never prose. The class does not live in
  `ooxml-xml.ts` or in the shared scanner: the reader must be able to *skip* an
  invalid coordinate that the writer *refuses*, so a shared mechanism module must
  not import writer policy. Precedent: `src/sqlite-file-state-errors.ts`.
- **Codes are kebab-case**, e.g. `invalid-cell-reference`,
  `missing-cell-reference`, `foreign-worksheet-namespace`. One architect
  recommended snake_case; I measured the repo instead — string-union members run
  **63 kebab-case to 4 snake_case**, and the nearest precedent
  (`SqliteFileStateErrorCategory`) is kebab (`'foreign-key'`,
  `'malformed-state'`). Kebab serializes to JSON identically, so the corpus loses
  nothing.
- `invalid-cell-reference` covers every present-but-invalid `r` — lowercase
  `a1`, row-zero `A0`, non-canonical `A01`, and out-of-format `XFE1` /
  `A1048577`. One code, because reader behavior, writer behavior, and user
  remedy are identical; a port must agree on the refusal, not on which branch of
  the validator tripped. `missing-cell-reference` stays separate: it is a
  different document shape, and Excel may infer position from document order.
- Format limits (`XFD` / 16,384 columns, 1,048,576 rows) belong to *this*
  validator — they define whether a reference is well-formed. They are distinct
  from the product display caps in `src/spreadsheet-safety.ts`
  (`MAX_SHEET_ROWS` 1,000,000, `MAX_SHEET_COLUMNS` 256), which sibling #241 may
  change. #153 does not touch those.
- **Delete 4 guards** now dead because both sides share one scanner: cells
  inside comments/CDATA/PI, row-`r` disagreement, unreadable attributes, entity
  references. Plus **both `<sheetData>` divergence errors** (commented-out first
  `<sheetData>`; close-tag disagreement) and the then-dead
  `raw_first_sheet_data`. The structural error for a document with *no* live
  `<sheetData>` stays — that is not a divergence guard.
- Each deletion is gated on a falsifiable condition, not an assertion. The
  existing refusal tests become **successful-edit** tests, and that is the
  falsifier: each must show the live cell replaced, the quoted/commented text
  byte-identical, and **no duplicate coordinate** inserted. Where a shape must
  still fail for a *different* reason (single-quoted grouped-formula attributes
  reaching the array-formula refusal), that is asserted separately.
- The mixed test at `xlsx-cell-write.test.ts:804-840` must be **split**: it
  currently folds five distinct guards into one `/cannot edit safely/i`
  assertion, so after Stage 5 its cases no longer share an outcome. Keeping it
  whole would hide precisely the sequencing defect the taxonomy exists to expose.
- Migration is smaller than the raw test count suggests: **25 `toThrow` sites,
  all in `xlsx-cell-write.test.ts`** (`xlsx-edit-session.test.ts` has none). Only
  the taxonomy assertions get rewritten; grouped-formula, merged-cell, and
  invalid-package errors stay plain `Error`s in this stage. "Assert code, not
  prose" applies to `OoxmlRefusalError`, not to unrelated categories that have no
  code yet.
- Refusal **precedence** is defined explicitly rather than left to map ordering,
  since the corpus pins observable codes: prefixed element → `AlternateContent` →
  structural tags in document order → within a cell, missing before invalid
  reference → foreign namespace by effective structural context. One deliberately
  multi-fault case pins it.
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
- **Third live bug, found by the architecture review and confirmed by running
  it: the foreign-namespace guard is scoped too narrowly.** The detector loops
  only over `row`, `c`, and `f` tags (`xlsx-cell-write.ts:1107`), so a foreign
  *default* namespace declared higher up rebinds every unprefixed child and is
  never examined:

  ```
  sheetData xmlns="urn:other"  -> ACCEPTED   (edit written into a foreign namespace)
  worksheet  xmlns="urn:other" -> ACCEPTED   (same)
  row        xmlns="urn:other" -> REFUSED    (control: the guard does work)
  ```

  The save reports success and no SpreadsheetML cell is written — exactly the
  failure the guard's own comment describes, reachable one element higher. This
  must be fixed *before* the code is pinned: Stage 7 freezes
  `foreign-worksheet-namespace` into a corpus a Rust port must match, and pinning
  it as-is would enshrine the gap. Stage 5 therefore evaluates the effective
  default namespace over the structural path (`worksheet` → `sheetData` → `row` →
  `c`), keeping today's allowance for a redundant re-declaration of
  SpreadsheetML. Prefixed `sheetData` joins the prefixed-element refusal too.
- **Second latent bug found while verifying the first, and in scope here.**
  `parse_cell_ref` accepts row `0`: `r="A0"` yields `row: -1`, a negative index
  no guard catches (see the trace above). It shares the coordinate-validation
  path with the lowercase case, so Stage 5 fixes both under
  `invalid_cell_reference` — validating the coordinate once, in the one place
  both sides now read it.
- **Fixes the live lowercase bug:** reader keeps rejecting `r="a1"`, writer
  refuses with `invalid_cell_reference`. Never silently normalize to `A1` —
  inserting a coordinate we did not read is how the duplicate got emitted.
- Criterion (d) lands here.

### Stage 6 — Byte offsets

Justified by the 40.4 MiB above, and now provable because Stage 1 exists.

- Scanner operates on `Uint8Array`; `Span` becomes what its comment always
  claimed — true UTF-8 byte offsets.
- **The writer and the worksheet side of the package layer go byte-native too.**
  This is a scope correction from the architecture review, and it is forced:
  `apply_splices` (`xlsx-cell-write.ts:1534`) applies offsets with
  `String.slice`, so an offset cannot be both a byte offset and a valid string
  index. Leave `apply_cell_edits` taking a string and `Span` is simply a
  different lie. So `apply_cell_edits`, `cells_present`, `formula_count`,
  `widen_dimension`, and worksheet-part read/write in `xlsx-package.ts` all take
  and return bytes. `write_part_bytes` must still set `entry.size`, or readers
  truncate.
- **The worksheet half of `xlsx-hyperlink-write.ts` comes along.** Cell edits and
  link edits compose over the same `sheet_xml` in a single save
  (`xlsx-package.ts:381-456`), so leaving it string-based would reintroduce the
  whole-part decode on exactly the composed path. Its `.rels` half stays
  string-based — separate part, normally small.
- **A one-allocation byte splicer** (`apply_utf8_splices`) replacing the current
  repeated-realloc loop, preserving today's tie-order rules. Today's version
  rebuilds the entire part per splice, which I measured on 57 MiB:

  | Splices | Time |
  |---|---|
  | 1 | 3 ms |
  | 10 | 32 ms |
  | 50 | **203 ms** |

  Linear in edit count, so a 50-cell paste pays 203 ms of pure copying. Computing
  the output length first and copying each untouched range once removes that.
- Decode only the small fraction actually consumed. Numeric `<v>` parses from
  bytes with no string allocation — but **not by reimplementing `Number()`**.
  Today's reader uses `Number(v_text)`, which accepts spellings a naive decimal
  parser would not: `Number('0x10')` is 16, `Number('Infinity')` is `Infinity`,
  `Number(' 5 ')` is 5. So: a no-allocation fast path for ordinary finite decimal
  syntax, and a per-value fallback that decodes *that one* `<v>` and calls
  `Number()` for anything else. A diagnostic counter asserts the fixture takes
  zero fallbacks. Absolute "never allocate for any numeric spelling" would mean
  writing a correctly-rounded decimal→binary converter — real scope, not worth
  it here.
- Note the phrasing: the scanner *inspects* every byte structurally; 29.3% is
  what the reader *consumes*, and the share actually **decoded** is much smaller
  than that, since `r`/`t`/`s` and numeric `<v>` never become strings.
- Exact-span replacement demonstrated on real bytes (criterion (c)) — already how
  the writer splices, so this is preserved, not invented. State the guarantee
  precisely, because the whole ZIP legitimately differs after `CFB` reserializes
  and recompresses: untouched ranges of the edited worksheet part are
  byte-identical, unmodified package entries have byte-identical content, and the
  edited part differs only at planned spans. That triple is what tests assert.
- Gate: **≥32 MiB median live-RSS reduction** measured against a **Stage 5**
  parent baseline (not Stage 1's `main` baseline, which no longer isolates Stage 6
  once Stage 4 has changed the reader), in fresh alternating child processes,
  sampling post-GC `process.memoryUsage().rss`. Parse time no worse than 10%
  median regression. All tests green.
  I lowered this from 40 MiB on the architect's reasoning, and it is sound:
  demanding 40 of a theoretical 40.4 MiB requires recovering 99% of the
  avoidable region, so allocator page retention or GC timing could fail a correct
  implementation. 32 MiB is ~80% of the avoidable region and still far too large
  for noise or a token optimization to clear.
- Stage failure is defined, not judged: median reduction under 32 MiB; noise too
  wide to establish a 30 MiB lower bound; a retained worksheet-sized string
  (visible as a ~57 MiB live jump); any ordinary reader path still decoding the
  whole part; the fixture taking numeric fallbacks; or any unrelated byte
  changing.
- Note `maxRSS` is **peak**, not live, and must not decide this gate on its own —
  `CFB.read`'s inflation peak can dominate it even after the steady-state string
  is gone. Live RSS is the post-GC sample.

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
- The corpus must **not** encode the current refusal set as correct-by-definition.
  Two of the shapes it would pin are defective today — the narrow
  foreign-namespace check and the missing coordinate validation — so the corpus is
  authored *after* Stage 5 fixes them, and it records the intended contract, not
  the historical behavior.
- ~40 curated cases to start, migrating incrementally. The 136 existing
  `xlsx-cell-write.test.ts` names already map almost 1:1 onto the hostile shapes
  a corpus needs (CDATA, PIs, duplicate coordinates, whitespace end tags,
  self-closing, grouped formulas, merged followers, namespace declarations).
- Public TypeScript boundary declared **in-tree** (criterion (e)); physical
  extraction to a separate package happens under #240. dta-parser itself was
  built flat and split later — same trajectory, deliberately.

## Decisions settled by architecture review

Recorded so stage agents inherit rulings rather than re-deriving them. Where I
overruled an architect, the reason is stated.

| Question | Ruling |
|---|---|
| Retain a frozen copy of the string scanner for benchmarking? | **No.** Git and Stage 1's committed baselines are the frozen oracle. A second scanner in-tree recreates the exact divergence this issue retires. Temporary overlap is allowed only *within* unmerged Stage 6 commits, for differential tests, deleted before review. |
| Refusal code casing | **kebab-case.** One architect said snake_case; the repo says otherwise — 63 kebab vs 4 snake in string unions, and `SqliteFileStateErrorCategory` is kebab. |
| Where does `OoxmlRefusalError` live? | Its own leaf module `src/ooxml-refusal.ts`. Not in the shared scanner: the reader *skips* what the writer *refuses*, so shared mechanism must not import writer policy. |
| One code or many for bad references? | **One** (`invalid-cell-reference`) for all present-but-invalid `r`; `missing-cell-reference` stays separate as a genuinely different document shape. |
| Can namespace-prefixed cells / `AlternateContent` become *supported*? | **No.** One architect suggested they could; I disagree and am keeping them refusals. These are shapes where the correct edit is genuinely undetermined, not merely unimplemented. |
| Do format extent limits belong here or to #241? | **Here** for reference *validity* (`XFD`, 1,048,576). #241 owns product display caps in `spreadsheet-safety.ts`. Different layers. |
| Byte scanner: does the writer follow? | **Yes**, and the package worksheet boundary and the worksheet half of the hyperlink writer with it. Otherwise `Span` stays a lie and the composed save path still decodes. |
| Stage 6 gate | **32 MiB** median live-RSS reduction vs a **Stage 5** baseline, not 40 MiB vs Stage 1's. |

## Delegation and branch strategy

```
main
 └── issue153                     (integration branch, I own it)
      ├── issue153-s1-bench       → merge --no-ff at stage end
      ├── issue153-s2-extract     → merge --no-ff
      ├── … one per stage
      └── issue153-s7-conformance → PR to main
```

**Each stage agent works in its own git worktree** (`isolation: "worktree"`), and
the supervising session makes no commits, checkouts, or writes in a tree an agent
holds. This is a correction, not a preference: Stage 1 ran in the shared checkout,
and the supervisor's `git add -A` swept the agent's in-progress harness into a
commit labelled as documentation-only, forcing a history rewrite. One writer per
checkout. The supervisor reads state with `git log`/`git show`/`git diff` only,
and uses path-scoped `git add`, never `-A`.

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

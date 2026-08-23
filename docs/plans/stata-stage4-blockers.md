# Stage 4 — release-blocking Stata defects

All four block the PR. All are in Stage 2 code already merged into
`feature/stata-readonly`; none are in the Stage 3 diff.

## 1. Infinite loop on malformed legacy expansion fields (hang / DoS)

`node_modules/@jbearak/dta-parser/dist/esm/index.js:547` `scan_expansion_fields`
reads a SIGNED int32 length and adds it without checking positivity or cursor
advance:

    pos += 5;
    if (type === 0 && len === 0) return pos;
    pos += my_len;            // len = -5 cancels the advance exactly

`DtaDataSource.create` (`src/data-source/dta-source.ts:148-151`) routes every
release 113/114/115 file straight into `parse_legacy_metadata` synchronously,
so a corrupt or crafted file spins forever — past the wrapping catch, past
cancellation. Freezes the extension host or the Electron process.

Fix: validate expansion fields before calling `parse_legacy_metadata` — each
length must be >= 0, must stay within the buffer, and the cursor must strictly
advance. Prefer an upstream parser fix + version bump if one can be published;
otherwise guard at the call site. Needs a regression test with a crafted
negative-length fixture that asserts a thrown error, not a hang (bound the test
so a regression fails instead of wedging CI).

## 2. `gso_index` is unbounded (memory blowup)

`src/data-source/dta-source.ts:525` inserts every scanned strL into
`gso_index` with no bound or eviction, unlike `gso_cache`
(`:551-553`, capped at MAX_GSO_CACHE_ENTRIES) and the decoded row windows.
One Map entry per unique strL means a valid sub-256-MiB file can retain
hundreds of MiB beyond the file buffer.

Context: this map was introduced to fix the quadratic strL rescan. It traded a
CPU blowup for a memory one. Do not simply revert it — the rescan was real.

Fix: keep the backward-lookup capability with a compact structure. Options:
parallel typed arrays (keys + offsets) instead of a Map of boxed entries, or
bounded scan checkpoints (every Nth GSO) so a backward seek resumes from a
nearby checkpoint rather than rescanning from zero. Memory must be bounded
independently of the number of distinct strLs.

## 3. `hex:` binary representation is not injective (silent wrong diff)

`encode_binary_gso` (`:631`) prefixes binary type-129 payloads with `hex:`,
but text strLs are unrestricted strings. A text strL whose literal content is
`hex:80` collides with a binary payload `0x80`. Raw-only consumers — row
alignment, filters, sorts — cannot tell them apart, so a diff can report a
binary-to-text replacement as UNCHANGED. Silent data-correctness failure.

Fix: carry a binary discriminator that cannot collide with text content.
Either extend RawCell with a type tag, or use a representation no valid decoded
text can produce. Whatever is chosen must go through the existing shared
canonicalization so raw and rendered paths cannot diverge.

## 4. Eager full hex string for large binary payloads (memory)

`encode_binary_gso` (`:631-636`) materializes the entire payload as hex — two
chars per byte — so a 200 MiB embedded blob becomes a ~400 MiB string, then may
be retained by the GSO cache and row windows. Chunking at 4096 bounds the
intermediate, not the result.

Fix: bounded preview plus a digest for comparison, or refuse/truncate oversized
binary cells for display. Comparison must stay correct: two distinct blobs must
not collide, so the digest must be part of the comparison key (interacts with
#3 — solve them together).

## Sequencing

Stage 4 branches off `feature/stata-readonly` AFTER Stage 3 merges. Solve #3
and #4 together; they share the binary representation. Then `simplify`, then
`code-review`, iterating until clean. Verify every review finding against the
live file before acting — this session has seen fabricated and stale findings.

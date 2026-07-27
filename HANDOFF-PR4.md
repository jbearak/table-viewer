# Handoff — PR 4: source-keyed row heights (PR #116)

**Feed this file to the agent taking over.** It is the complete brief; you should not
need the prior conversation. Delete this file before merging — it is scaffolding, not
documentation.

Work moved machines mid-flight because the previous host had to shut down. Nothing here
is blocked or broken: at the moment of handoff the branch typechecks, the whole suite is
green, and CI is green on the pushed head. What remains is finishing a review loop.

---

## 1. Mission

You own **PR #116 — "Key row heights by canonical source row"**, the last of a four-PR
plan. Take it to a merged-ready state: all gates clean, then report. **A human merges —
do not merge yourself.**

Plan document: `docs/superpowers/plans/2026-07-25-source-keyed-edits-and-row-heights.md`,
section "PR 4 — Source-key row heights" (~line 304).

**The plan is partly stale — it predates PR 3.** Verify every line number and mechanism
against current code before relying on it. In particular it tells you to add a field to
`transformApplied`; that message no longer exists. PR 3 split it into
`transformInstalled | transformRefused`.

### What PR 4 fixes

Custom row heights were **suppressed, not misapplied** — the map was replaced with `{}`
under any active transform, the resize overlay unmounted, hover-arming bailed, and Excel
header changes dropped heights. So the user-visible bug was that custom heights vanished
on sort and returned on clear.

`rowHeights` was the **only** display-keyed durable state. (`cellHighlights` is
source-keyed; `scrollPosition` is `{top,left}` pixels. Both were checked — don't
re-derive.)

### Why it needed a different mechanism from edits, and was sequenced last

Glide sums `rowHeight(r)` over **every** row to compute total scroll height, so a
resident-only reverse lookup would report default heights for non-resident overridden
rows and the total would drift as pages load — visible scrollbar jitter. Hence: persist
source-keyed, render from a **host-computed sparse display-keyed projection**, delivered
generation-bound.

---

## 2. State at handoff — all verified directly, not reported

- Worktree: `/Users/jmb/repos/Extensions/table-viewer.worktrees/pr4-row-heights`
- Branch `source-keyed-row-heights`, **11 commits** ahead of `origin/main` (`a97a187`)
- HEAD `42b9313` "Record which row-height invariants a probe found load-bearing"
- **Working tree clean.** `npm run typecheck:all` clean. `npx vitest run` → **1955
  passed / 101 files** (baseline on `a97a187` was 1859).
- PR #116 OPEN / CLEAN, +5401/−284
- CI on pushed head `790cc67`: `test`, `CodeQL`, `Analyze (actions)`,
  `Analyze (javascript-typescript)` all **success**
- `42b9313` is **committed but not yet pushed** — push it first, then re-check CI.

There is a second worktree, `pr4-codex`, on a detached HEAD at `07a2ffa`, used for
running codex reviews. Harmless; remove it when done (`git worktree remove`).

---

## 3. Exactly where work stopped

Two things are in flight. Do these first.

### 3a. Three surviving mutants from the round-6 mutation audit

The audit subagent died mid-run. Its last words: *"Three survivors. Let me address M4
with a test, and check M12's no-early-exit variant."*

- **M4** needs a test written.
- **M12** needs its no-early-exit variant checked.
- The third survivor was not named — **re-run the audit to re-identify it.**

**Do not trust the dead agent's partial results.** An interrupted audit may have recorded
"killed" for mutants it never actually ran. Re-verify before believing any of it.

Surviving mutants are the highest-value item on your list: each one marks an assertion
that cannot fail.

### 3b. CodeRabbit has not reviewed the latest head

Re-request after you push. See §5 for how to read it — this is not obvious and has
caused real misses.

### 3c. Then continue the codex review loop

Round 6 was the last completed round. See §4.

---

## 4. The codex review loop — the core process

```
codex -m gpt-5.6-sol -c model_reasoning_effort=xhigh review --base origin/main
```

Run it **outside the sandbox** (`dangerouslyDisableSandbox: true`) or it dies with
`failed to initialize in-process app-server client: Operation not permitted`. Takes
20–30 minutes per round. Be patient; do not poll it aggressively.

**One pass is not a gate.** Fixing findings changes what is reachable, so each round can
expose a new layer. Loop until a round returns nothing actionable. For calibration: PR 3
took **eleven rounds** and produced ~11 real defects, several user-visible.

Judge each finding on merit. Most are real; some are narrow or platform-speculative.
Decline anything that violates §6's product constraints — but say so with reasoning
rather than silently skipping.

**Prefer the structural fix when findings keep circling one mechanism.** That is the
signal the design is wrong rather than the call site, and it ends the loop instead of
extending it. On PR 3 this was decisive twice: four findings turned out to be
misclassifications of one overloaded message, and another three were one shape —
"a retained field that basis-equality never licensed keeping."

### Findings already fixed (round 1) — do not re-fix

1. **[P1]** Normalize legacy height maps before latching them — `viewer-controller.ts`
2. **[P2]** Fence resize writes against file authority changes — `viewer-controller.ts`
3. **[P2]** Migrate existing height maps to the new bound — `panel-core.ts`
4. **[P2]** Prevent preview row resizing from silently succeeding — `viewer-controller.ts`

Rounds 2–6 produced further fixes; see the commit log, whose messages are detailed and
state the reasoning.

---

## 5. Hard-won process discipline — every one of these cost real time

**Probing for silent holes outperforms reviewing the diff.** On PR 3 this found eleven
issues that eleven codex rounds had missed, including **three newly-written tests that
passed with their own fix reverted**. Mutation-test every new assertion, and in *both*
directions wherever a distinction has two sides (transient/terminal,
basis-changed/unchanged). A test that passes with its fix reverted is worth nothing.

**Delete a guard rather than ship it unpinnable — or keep it and say so.** If something
ships without a test, report that explicitly rather than writing a vacuous one. See
`42b9313` for the pattern: two guards no test can distinguish, kept and labelled, with
the reasoning recorded.

**Never infer completion from a proxy.** `pgrep` failing (`Cannot get process list`)
reads identically to "process finished" — this cost PR 3 real time twice, once leaving a
clean review sitting unnoticed for 13 minutes. Gate on a **verdict marker in the output
file**, never on process absence. Same family as the repo's CLAUDE.md rule: never wait a
fixed delay for async work, poll for the observable result.

**Read CodeRabbit's review *bodies*, not just inline comments.** Actionable items hide in
the nitpick sections of review bodies. Querying only the inline-comments endpoint made a
reviewer declare a PR clean when it had an unfixed accessibility defect. Also:
- Its own "✅ Addressed" markers are **not trustworthy** — verify against the file.
- Its check reports `pass` even when it means "rate limited". Confirm a review actually
  landed at the head SHA.
- Rate limits are **hourly**, not per-account. A re-request later usually works.
- Its clean verdict ("No actionable comments were generated") arrives as an **issue
  comment**, not a review — check both endpoints.

**Verify CI against the head SHA via the check-runs API**, not the check summary. GitHub
silently never triggered a workflow on an earlier PR while the summary showed green.

**Ignore the IDE/language-server diagnostics.** They lagged the entire previous session,
repeatedly reporting errors that `tsc` did not — including a whole set claiming
`mappingGenerations` was missing at test call sites when all three projects were clean.
Trust `tsc`, not the squiggles.

**Commit in small increments.** The previous host suffered three infrastructure failures
(two API 529s and a watchdog stall) and each time was carrying uncommitted work. Write
anything you would hate to lose into the PR body or a tracked file, not context.

**Watch for concurrent-agent file contention.** On PR 3 one subagent's edit was silently
clobbered by another agent writing the same file, caught only by a flagged state
mismatch. If you fan out, keep writers off shared files.

---

## 6. Non-negotiable product constraints

- **Rows never move during a live edit session.** An installed sort or filter
  deliberately does **not** recompute mid-session; a stale sorted/filtered view is
  intended behaviour, not a bug. There must be **no** "Resort"/"Refilter"/"Refresh view"
  action, and no deferred replay of a refused user request. The user's own words: *"When
  I edit tables in other tools like Excel, I actually find it frustrating when rows move
  as I edit them."*
  - Note the boundary: rows moving because the **file changed externally**, or on
    **reopen** after an external edit, is correct and unavoidable — computed permutations
    are deliberately never persisted (only the rules), so recomputation on reopen is not
    a choice. The constraint is about a *live session*.
- Edits are keyed by canonical **source** row (PR 2). Heights become likewise (this PR).
- Editing and transforms coexist in **both** directions since PR 3 — you can sort while
  editing, and enter edit mode with a sort installed.
- Tests **poll for the observable result**, never wait a fixed delay. A
  `setTimeout(…, 40)` that passes locally is a CI flake already written.
- The desktop smoke suite drives a real GUI app — don't chase a failure there as a code
  bug before ruling out that someone switched windows.

---

## 7. The riskiest part of this PR

**Legacy height-map migration.** This PR changes the keying of durable data that already
exists on users' disks. Anyone upgrading has display-keyed heights persisted under the
scheme being replaced. Round 1's P1 was exactly this.

The case to be sure about: **a legacy map written while a transform was installed**, which
is precisely when display and source keys diverge, and therefore when a naive re-key
silently corrupts. If that case cannot be resolved correctly, **dropping legacy heights on
migration is the better answer** — a visible, honest loss beats a silent
misinterpretation. Confirm this is designed and tested, not assumed.

---

## 8. Known items — fold in or defer explicitly, don't drop silently

1. **`commit_transform_reconciliation` installs a permutation without publishing a
   `SheetViewRecord`**, so `permuted` / `rowCount` / `hiddenEditedCellKeys` can be stale
   until the next install. Pre-existing, recorded during PR 3. **If the height projection
   rides in that record, this path serves a stale height projection too** — so it likely
   must be fixed here. Check whether it was.
2. **Cancel over partly-active durable rules deletes a disabled filter definition along
   with the sort.** Pre-existing; fixing it would mean inventing a partial rollback.
   Likely out of scope — defer explicitly.

---

## 9. Context: what the first three PRs established

- **#110** — split display-row from canonical source-row space; edits keyed by source row.
- **#111** — a failed CSV save no longer destroys edits the user still has open (three
  distinct bugs).
- **#112** — a save is recorded as persisted *before* its durable write, because
  `release_edit_session` reads that set while the CAS is still in flight.
- **#113** — sorts, filters and hidden rows coexist with editing in both directions.
  Introduced two structures you will work with:
  - **`transformInstalled | transformRefused`** — a refusal carries **no** state,
    rowCount or generation, so adopting one as authoritative is not a mistake a consumer
    can make. Refusal sites must pass an explicit `'transient' | 'terminal'`; omission is
    a compile error.
  - **`SheetViewRecord`** — a per-sheet record carrying its own `basis: ViewBasis`, a
    discriminated union on `permuted`. **Its invariant: every field must be a fact about
    the rows this view contains.** A field tracking anything else (durable intent, the
    pending-edit map, what has been asked of the host) does not belong, because basis
    equality says nothing about it and retention will hold a stale copy forever. Three
    separate review findings were that one pattern, which is why it is a *shape* and not
    a paragraph.

---

## 10. Environment

- Repo `/Users/jmb/repos/Extensions/table-viewer`; this work in the `pr4-row-heights`
  worktree. `main` is checked out by the primary worktree, so `gh pr merge --delete-branch`
  fails on the local checkout step — the merge itself still succeeds; delete the remote
  branch separately.
- Plain Bash **writes** are blocked by the sandbox in non-primary worktrees. Use the
  Edit/Write tools, or pass `dangerouslyDisableSandbox: true` on Bash calls that must
  write. `codex` also requires the sandbox disabled.
- Gates before reporting: `npm run typecheck:all` clean; full `npx vitest run` green
  (≥1955); all CI checks `completed/success` **on the head SHA**; CodeRabbit responded to;
  codex returning nothing actionable.

---

## 11. What to report back

What you built; the mutation table; what codex found per round; anything you declined and
why; anything shipping without a test; and any place the plan turned out wrong.

**Contradicting this brief with evidence is the most valuable thing you can do.** Every
one of PR 3's best outcomes came from an agent doing exactly that — including two
occasions where a specification handed down from above would have shipped data loss, and
one where a "must not be changed" instruction turned out to be unsatisfiable. Check
claims; do not defer to them.

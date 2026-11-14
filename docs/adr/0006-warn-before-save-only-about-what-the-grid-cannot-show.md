# Warn before Save only about what the grid can't show

Inserting, deleting, or moving a row or column used to raise a "Row and column changes" banner above the grid with a **Review changes** button. The banner said only that Save would restructure the sheet, which the grid's tints already show: new rows and columns green, moved ones purple, deleted ones red and kept in place until Save. The useful part, the formulas a change affects, was hidden behind the button and computed only once it was pressed. Opening the banner also pushed the grid down under the pointer, and its button shared a label with the unrelated external-change notice.

We dropped the banner. The grid's tints are the record of a structural change, and what Save will do is summarized in the Save button's tooltip and accessible description ("Save: 1 row inserted, 1 column deleted."). A **pending-change notice** appears without a click, docked under the grid, only when Save will do something the person can't see in the grid or has to decide on:

- Save will refuse: a layout conflict, pending rows that no longer fit, a rule that would split past the writer's cap, or a formula Table Viewer can't adjust;
- formulas will show `#REF!` because a row or column they use was deleted, counted and, when it is one thing, named ("2 formulas use column Price, which you deleted"), and after them the formulas that use their results, on any worksheet ("1 more formula uses their results and will show #REF! too"). The calculator decides which of those show `#REF!`. One it can't evaluate, such as a `ROUND` over a broken total, is counted as one that might show an error; one that catches errors, such as `IFERROR` or `ISERROR`, is left out;
- formulas whose range a move or delete changed in a way Excel might not (ADR 0004's flagged classes), shown as Save writes them and as written.

One pure module, `src/webview/pending-change-notices.ts`, decides which notices show, what they say, their actions, and their dismissal keys. The host answers the formula question after the layouts or edits change, debounced and cooperatively, so warnings are current without a click.

## Considered options

- **Keep the banner and open it by default.** The counts would then be visible, but they restate the tints, and a notice for every gesture trains people to ignore the one that matters.
- **Show the notice above the grid, where the other banners are.** A notice that appears after a gesture would move the row under the pointer. Under the grid, it only moves the grid's bottom edge.
- **Warn in a dialog when Save is pressed.** The person learns about the `#REF!` only after deciding to save, and a confirmation on every Save of a restructured workbook teaches clicking through.

## Consequences

- The host runs the formula review after every settled layout or edit change in an `.xlsx` workbook that has formulas, not only when asked. On 50,000 formulas it takes 160–270 ms in 8 ms slices on the host, and a newer question cancels an older one. When a deletion breaks formulas, finding and calculating the formulas that use them adds about 45 ms there; when all 49,000 have a dependent of their own, it doubles the review, to about 750 ms.
- A plain insert, delete, or move gets no notice. The tint and the Save tooltip are the only feedback, by design.
- The **Review changes** label belongs only to the external-change notice.

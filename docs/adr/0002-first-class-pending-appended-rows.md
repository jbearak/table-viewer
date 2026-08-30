# Represent pending appended rows as structural edits

Table Viewer represents each Pending Appended Row as a first-class structural edit with a stable temporary identity, not as cell edits addressed beyond the worksheet's existing source-row range. This preserves intentionally blank rows and gives append, remove, undo, persistence, and save one honest row identity while retaining the existing rule that out-of-range cell edits are stale and must be rejected.

# Undo saved appends by removing the created tail

Undo may reverse a saved Append Row by creating a pending removal of the physical tail row or rows produced by that recorded append, provided they still resolve safely as an unchanged worksheet suffix. This preserves Table Viewer's cross-save history contract without introducing arbitrary row deletion; if later source changes mean the recorded rows are no longer that safe suffix, the reversal is refused rather than shifting unrelated rows or degrading the operation into clearing cells.

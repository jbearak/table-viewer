# Table Viewer

## Tests

- Never wait a fixed delay for async work — poll for the observable result instead (the grid's accessibility cell, the settings file, `getFocusedWindow()`). A `setTimeout(…, 40)` that passes on your machine is a CI flake already written.

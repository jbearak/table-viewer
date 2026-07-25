# Table Viewer

## Tests

- Never wait a fixed delay for async work — poll for the observable result instead (the grid's accessibility cell, the settings file, `getFocusedWindow()`). A `setTimeout(…, 40)` that passes on your machine is a CI flake already written.
- The desktop smoke suite drives a real GUI app, so it needs the desktop left alone; don't chase a failure there as a code bug before ruling out that someone switched windows.

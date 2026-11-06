; Custom NSIS include for the Windows installer, wired up by `nsis.include` in
; desktop/electron-builder.yml.
;
; Why this exists instead of electron-builder's `fileAssociations`:
;
; electron-builder generates its associations with the APP_ASSOCIATE macro
; (app-builder-lib/templates/nsis/include/FileAssociation.nsh), whose first
; line is
;
;   WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}" "" "${FILECLASS}"
;
; — that writes the *default* value of the extension key, which is precisely
; how Windows records "the default program for this file type". Installing
; would therefore take .xlsx away from Excel and .csv from whatever the user
; had chosen. That is the opposite of the intent recorded on the macOS side of
; the config, where `rank: Alternate` deliberately declines default-handler
; status (rank/role are macOS-only fields and do nothing on Windows).
;
; Worse, electron-builder derives the ProgID from the association's `name`, so
; ours would have been the generic strings `CSV` and `Excel Workbook`, and the
; uninstaller's `DeleteRegKey Software\Classes\<name>` would delete whatever
; else happened to live under those very guessable keys.
;
; So we register by hand: a vendor-prefixed ProgID plus an OpenWithProgids
; entry, which is the documented way to appear in "Open with…" while leaving
; the user's default alone. Every key written here is namespaced to
; TableViewer.*, so the uninstaller only ever removes its own.
;
; SHELL_CONTEXT follows the install mode chosen on the install-mode page
; (HKCU for a per-user install, HKLM for all-users), which is what we want:
; the associations land in the same hive as the app itself.

!macro TV_REGISTER_TYPE EXT DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\TableViewer.${EXT}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\TableViewer.${EXT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\TableViewer.${EXT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  ; A value under OpenWithProgids adds us to the "Open with…" list. Note this
  ; is deliberately NOT `WriteRegStr ... "Software\Classes\.${EXT}" ""`, which
  ; would make us the default handler.
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "TableViewer.${EXT}"
!macroend

!macro TV_UNREGISTER_TYPE EXT
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "TableViewer.${EXT}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\TableViewer.${EXT}"
!macroend

!macro customInstall
  !insertmacro TV_REGISTER_TYPE "csv"     "Comma-separated values"
  !insertmacro TV_REGISTER_TYPE "tsv"     "Tab-separated values"
  !insertmacro TV_REGISTER_TYPE "xlsx"    "Excel workbook"
  !insertmacro TV_REGISTER_TYPE "xls"     "Legacy Excel workbook"
  !insertmacro TV_REGISTER_TYPE "parquet" "Apache Parquet file"
  !insertmacro TV_REGISTER_TYPE "dta"     "Stata dataset"
  ; Tell the shell to reload associations so "Open with…" is correct without a
  ; sign-out. SHCNE_ASSOCCHANGED | SHCNF_FLUSH.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro TV_UNREGISTER_TYPE "csv"
  !insertmacro TV_UNREGISTER_TYPE "tsv"
  !insertmacro TV_UNREGISTER_TYPE "xlsx"
  !insertmacro TV_UNREGISTER_TYPE "xls"
  !insertmacro TV_UNREGISTER_TYPE "parquet"
  !insertmacro TV_UNREGISTER_TYPE "dta"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, i 0, i 0)'
!macroend

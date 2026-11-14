"""LibreOffice oracle fixtures for formula rendering under row and column changes.

The row and column structure design ("Oracle criterion") needs a real
spreadsheet engine's reference adjustment to check `render_formula` against.
No Excel is available, so LibreOffice is the oracle. For each case below this
script builds a workbook in headless LibreOffice, writes the case's formulas
and defined names, performs its gestures through LibreOffice's own sheet API,
reads every formula back in Excel (OOXML) A1 syntax, and writes the results to
`src/test/fixtures/libreoffice-formula-oracle.json`.
`src/test/formula-anchors-libreoffice-oracle.test.ts` replays the same
gestures through the Worksheet Layout and compares, so tests never need
LibreOffice.

Gestures name 1-based rows and columns of the worksheet as it stands before
the gesture:

- insertRows / insertColumns: `count` new rows or columns land before `before`;
- deleteRows / deleteColumns: `count` rows or columns starting at `first`;
- moveRows / moveColumns: the `count` rows or columns starting at `first` move
  to just before `before`. LibreOffice has no cut-insert in its API, so a move
  is three API calls: insert `count` blank rows at `before`, `moveRange` the
  block into them (cut and paste: references that lie wholly inside the block
  follow it), and delete the emptied rows. For ranges whose corners do not
  move, that matches the spec's cut-insert semantics; a range with one corner
  in the block does not follow that corner, so those cases are classified
  `flagged` in the case list.

Each formula may carry an `expect` classification (see the test's header):
`flagged` for the spec's deliberate differences, `libreofficeDiffers` with
the Excel text and a citation of Excel's documented behavior. Unclassified
formulas must render LibreOffice's text exactly, after normalizing case,
whitespace, and needless sheet-name quotes.

Regenerate (macOS, LibreOffice installed with `brew install --cask libreoffice`):

    python3 scripts/libreoffice-formula-oracle.py

Any Python 3 runs the launcher half of this file: it copies the file into a
throwaway LibreOffice profile and starts headless soffice on it as a Python
macro, so the UNO half runs inside LibreOffice's own interpreter. (Running
LibreOffice's bundled `python` as a separate process would work too, but
macOS kills that nested executable at launch on a quarantined install.)
Pass `--soffice PATH` to use another installation, `--out PATH` to write
elsewhere, and `--only TEXT` to print the cases whose name contains TEXT
instead of writing the fixture.

`--check-saved SPEC` checks workbooks Table Viewer saved instead. SPEC is a
JSON list of `{"name", "original", "saved", "gestures"}`, where gestures are
the ones above plus `{"op": "set", "sheet", "cell": "B3", "value": 70}` for a
cell edit (a string starting with `=` is a formula in Excel syntax). For each
entry LibreOffice opens the original, applies the gestures itself, opens the
saved file without package repair, recalculates both, and prints every cell
formula, value, and defined name that differs.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

try:
    import uno
    from com.sun.star.beans import PropertyValue
    from com.sun.star.table import CellAddress
except ImportError:  # the launcher half, outside LibreOffice
    uno = None

FIXTURE = Path("src") / "test" / "fixtures" / "libreoffice-formula-oracle.json"
DEFAULT_SOFFICE = "/Applications/LibreOffice.app/Contents/MacOS/soffice"

# Source extent of every worksheet: data in rows 1..ROWS, columns 1..COLUMNS.
ROWS = 20
COLUMNS = 10
# Formulas sit below and right of the data, in column FORMULA_COLUMN from
# row FORMULA_ROW down, so no gesture deletes or moves a formula cell.
FORMULA_ROW = 30
FORMULA_COLUMN = 12  # L

ENV_OUT = "TV_FORMULA_ORACLE_OUT"
ENV_ONLY = "TV_FORMULA_ORACLE_ONLY"
ENV_VERSION = "TV_FORMULA_ORACLE_VERSION"
ENV_SPEC = "TV_FORMULA_ORACLE_SPEC"

MOVE_CORNER_NOTE = (
    "LibreOffice's move is insert + cut-paste + delete, and cut-paste moves only references "
    "wholly inside the moved block, so a range whose corner moves keeps its old bounds. The "
    "spec carries each corner with its row (\"Where this differs from Excel\": corner-crossing "
    "and displaced corners), so the range is in the flagged superset."
)


def ins(axis, sheet, before, count=1):
    return {"op": f"insert{axis}", "sheet": sheet, "before": before, "count": count}


def dele(axis, sheet, first, count=1):
    return {"op": f"delete{axis}", "sheet": sheet, "first": first, "count": count}


def move(axis, sheet, first, count, before):
    return {"op": f"move{axis}", "sheet": sheet, "first": first, "count": count, "before": before}


def f(text, sheet="Sheet1", expect=None):
    out = {"sheet": sheet, "text": text}
    if expect is not None:
        out["expect"] = expect
    return out


def name(defined, text, expect=None):
    out = {"name": defined, "text": text}
    if expect is not None:
        out["expect"] = expect
    return out


def flagged(note=MOVE_CORNER_NOTE):
    return {"kind": "flagged", "note": note}


S = "Sheet1"
R = "Rows"
C = "Columns"

# Formulas shared by many single-gesture row cases: a range B3:B6, single
# cells in every `$` form, whole rows, a range past the body (`trailing`), and
# a two-range function.
ROW_FORMULAS = [
    "=SUM(B3:B6)",
    "=SUM($B$3:$B$6)",
    "=SUM(B$3:$B6)",
    "=B5+$C$5+D$5+$E5",
    "=SUM(3:6)",
    "=SUM(A:B)",
    "=SUM(B2:B25)+B24",
    "=SUMPRODUCT(B3:B6,C8:C12)",
    "=VLOOKUP(A5,A2:D10,2,0)",
]

# The column twin: columns C..F, single cells, whole columns, past the last
# source column (`trailing`), and a two-range function.
COLUMN_FORMULAS = [
    "=SUM(C2:F2)",
    "=SUM($C$2:$F$2)",
    "=SUM(C$2:$F2)",
    "=E3+$E$4+E$5+$E6",
    "=SUM(C:F)",
    "=SUM(1:2)",
    "=SUM(B2:N2)+M2",
    "=SUMPRODUCT(C2:F2,C4:F4)",
    "=HLOOKUP(E1,B1:H8,3,0)",
]


def row_case(title, gestures, formulas=ROW_FORMULAS, **extra):
    return {"name": title, "gestures": gestures, "formulas": [f(text) for text in formulas], **extra}


def column_case(title, gestures, formulas=COLUMN_FORMULAS, **extra):
    return {"name": title, "gestures": gestures, "formulas": [f(text) for text in formulas], **extra}


CASES = [
    # --- Row inserts -------------------------------------------------------
    row_case("insert a row above a range", [ins(R, S, 2)]),
    row_case("insert a row at a range's first row", [ins(R, S, 3)]),
    row_case("insert rows inside a range", [ins(R, S, 5, 2)]),
    row_case("insert a row at a range's last row", [ins(R, S, 6)]),
    row_case("insert a row just after a range", [ins(R, S, 7)]),
    row_case("insert rows at the first row", [ins(R, S, 1, 3)]),
    row_case("insert a row after the last body row", [ins(R, S, 21)]),
    row_case("insert many rows inside a range", [ins(R, S, 4, 5)]),
    # --- Row deletes -------------------------------------------------------
    row_case("delete a range's first row", [dele(R, S, 3)]),
    row_case("delete a range's last row", [dele(R, S, 6)]),
    row_case("delete rows inside a range", [dele(R, S, 4, 2)]),
    row_case("delete every row of a range", [dele(R, S, 3, 4)]),
    row_case("delete a referenced cell's row", [dele(R, S, 5)]),
    row_case("delete rows above a range", [dele(R, S, 1, 2)]),
    row_case("delete rows straddling a range's first row", [dele(R, S, 2, 3)]),
    row_case("delete rows straddling a range's last row", [dele(R, S, 5, 3)]),
    row_case("delete rows past a range", [dele(R, S, 8, 4)]),
    row_case("delete the last body row", [dele(R, S, 20)]),
    # --- Column inserts ----------------------------------------------------
    column_case("insert a column left of a range", [ins(C, S, 2)]),
    column_case("insert a column at a range's first column", [ins(C, S, 3)]),
    column_case("insert columns inside a range", [ins(C, S, 4, 2)]),
    column_case("insert a column at a range's last column", [ins(C, S, 6)]),
    column_case("insert a column just right of a range", [ins(C, S, 7)]),
    column_case("insert columns at column A", [ins(C, S, 1, 2)]),
    column_case("insert a column after the last source column", [ins(C, S, 11)]),
    # --- Column deletes ----------------------------------------------------
    column_case("delete a range's first column", [dele(C, S, 3)]),
    column_case("delete a range's last column", [dele(C, S, 6)]),
    column_case("delete columns inside a range", [dele(C, S, 4, 2)]),
    column_case("delete every column of a range", [dele(C, S, 3, 4)]),
    column_case("delete a referenced cell's column", [dele(C, S, 5)]),
    column_case("delete columns left of a range", [dele(C, S, 1, 2)]),
    column_case("delete columns straddling a range's first column", [dele(C, S, 2, 3)]),
    column_case("delete the last source column", [dele(C, S, 10)]),
    # --- A Header Row ------------------------------------------------------
    row_case(
        "insert below the Header Row",
        [ins(R, S, 2)],
        formulas=["=B1+B2", "=SUM(B1:B4)", "=SUM(1:3)"],
        headerRow=1,
    ),
    row_case(
        "delete the first body row under a Header Row",
        [dele(R, S, 2)],
        formulas=["=B1+B2", "=SUM(B1:B4)", "=SUM(B2:B4)", "=SUM(1:3)"],
        headerRow=1,
    ),
    # --- Cross-sheet references and a sheet name with a space ----------------
    {
        "name": "insert rows on a referenced sheet with a space in its name",
        "sheets": [S, "My Data"],
        "gestures": [ins(R, "My Data", 4, 2)],
        "formulas": [
            f("='My Data'!B5+B5"),
            f("=SUM('My Data'!B3:B6)+SUM(B3:B6)"),
            f("=SUM('My Data'!3:6)"),
            f("=COUNTA('My Data'!B:B)"),
            f("=SUM(Sheet1!B3:B6)", sheet="My Data"),
            f("=SUM(B3:B6)", sheet="My Data"),
        ],
    },
    {
        "name": "delete columns on a referenced sheet",
        "sheets": [S, "My Data"],
        "gestures": [dele(C, "My Data", 3, 2)],
        "formulas": [
            f("='My Data'!E2+E2"),
            f("=SUM('My Data'!C2:F2)+SUM(C2:F2)"),
            f("='My Data'!D7"),
            f("=SUM('My Data'!B:E)"),
        ],
    },
    {
        "name": "gestures on both sheets",
        "sheets": [S, "My Data"],
        "gestures": [ins(R, S, 2), dele(R, "My Data", 5), ins(C, "My Data", 1)],
        "formulas": [
            f("=SUM('My Data'!B3:B8)+SUM(B3:B8)"),
            f("='My Data'!C5"),
            f("='My Data'!C6+C6"),
        ],
    },
    # --- Defined names -----------------------------------------------------
    {
        "name": "defined names across row and column changes",
        "sheets": [S, "My Data"],
        "gestures": [ins(R, S, 4, 2), dele(C, "My Data", 2)],
        "formulas": [
            name("Block", "Sheet1!$B$3:$D$6"),
            name("Cell", "Sheet1!$B$8"),
            name("Rows", "Sheet1!$3:$6"),
            name("Other", "'My Data'!$C$2:$F$9"),
            name("Gone", "'My Data'!$B$4"),
            f("=SUM(Block)+Cell"),
        ],
    },
    # --- Functions with several ranges -------------------------------------
    row_case(
        "insert and delete around several ranges in one function",
        [ins(R, S, 4), dele(R, S, 10, 2)],
        formulas=[
            "=SUM(B3:B6,D8:D12,F2)",
            "=SUMIFS(C2:C15,A2:A15,\">2\",B2:B15,\"<9\")",
            "=INDEX(A2:E15,MATCH(4,A2:A15,0),2)",
            "=IF(B3>0,SUM(B3:B6),AVERAGE(C8:C12))",
            "=SUM(B3:D6 C4:E8)",
        ],
    ),
    # --- Sequences ---------------------------------------------------------
    row_case("insert then delete rows", [ins(R, S, 4, 2), dele(R, S, 8, 2)]),
    row_case("delete then insert rows elsewhere", [dele(R, S, 10, 3), ins(R, S, 2)]),
    row_case("delete an inserted row", [ins(R, S, 5), dele(R, S, 5)]),
    column_case("insert then delete columns", [ins(C, S, 4, 2), dele(C, S, 2)]),
    {
        "name": "rows and columns together",
        "gestures": [ins(R, S, 4), ins(C, S, 3), dele(R, S, 2), dele(C, S, 6)],
        "formulas": [f(text) for text in ["=SUM(B3:F8)", "=D5", "=$E$7*2", "=SUM(C:E)", "=SUM(2:5)"]],
    },
    # --- Moves -------------------------------------------------------------
    row_case(
        "move a row from inside a range out of it",
        [move(R, S, 4, 1, 12)],
        formulas=["=SUM(B3:B6)", "=B4", "=SUM(B10:B14)", "=SUM(3:6)"],
    ),
    row_case(
        "move a row from outside a range into it",
        [move(R, S, 12, 1, 5)],
        formulas=["=SUM(B3:B6)", "=B12", "=SUM(B10:B14)"],
    ),
    row_case(
        "move a whole range",
        [move(R, S, 3, 4, 15)],
        formulas=["=SUM(B3:B6)", "=SUM(B10:B14)", "=B4"],
    ),
    {
        "name": "move rows to the end",
        "gestures": [move(R, S, 2, 2, 21)],
        "formulas": [f("=SUM(B5:B8)"), f("=B2+B3"), f("=SUM(B2:B25)+B24", expect=flagged())],
    },
    column_case(
        "move a column from inside a range out of it",
        [move(C, S, 4, 1, 9)],
        formulas=["=SUM(C2:F2)", "=D3", "=SUM(C:F)"],
    ),
    column_case(
        "move columns from outside a range into it",
        [move(C, S, 8, 2, 4)],
        formulas=["=SUM(C2:F2)", "=H3+I3"],
    ),
    {
        "name": "move a range's last row down past other rows",
        "gestures": [move(R, S, 6, 1, 10)],
        "formulas": [f("=SUM(B3:B6)", expect=flagged()), f("=B6")],
    },
    {
        "name": "move a range's first row above it",
        "gestures": [move(R, S, 3, 1, 1)],
        "formulas": [f("=SUM(B3:B6)", expect=flagged()), f("=B3")],
    },
    {
        "name": "move a range's last row above its first",
        "gestures": [move(R, S, 6, 1, 2)],
        "formulas": [f("=SUM(B3:B6)", expect=flagged()), f("=SUM($B$3:$B$6)", expect=flagged()), f("=$B$6")],
    },
    {
        "name": "move a range's last row up inside it",
        "gestures": [move(R, S, 6, 1, 4)],
        "formulas": [f("=SUM(B3:B6)", expect=flagged()), f("=SUM($B$3:$B$6)", expect=flagged()), f("=B6")],
    },
    {
        "name": "move a range's first row down inside it",
        "gestures": [move(R, S, 3, 1, 6)],
        "formulas": [f("=SUM(B3:B6)", expect=flagged()), f("=B3")],
    },
    {
        "name": "move a range's last row up inside it under a Header Row",
        "headerRow": 1,
        "gestures": [move(R, S, 5, 1, 3)],
        "formulas": [f("=SUM(B2:B5)", expect=flagged())],
    },
    {
        "name": "move a range's last row up inside it on a referenced sheet",
        "sheets": [S, "My Data"],
        "gestures": [move(R, "My Data", 6, 1, 4)],
        "formulas": [
            f("=SUM('My Data'!B3:B6)", expect=flagged()),
            f("=SUM(B3:B6)", sheet="My Data", expect=flagged()),
        ],
    },
    {
        "name": "move a range's first column past its last",
        "gestures": [move(C, S, 3, 1, 8)],
        "formulas": [f("=SUM(C2:F2)", expect=flagged())],
    },
    {
        "name": "move rows then insert and delete",
        "gestures": [move(R, S, 12, 2, 4), ins(R, S, 2), dele(R, S, 9)],
        "formulas": [f(text) for text in ["=SUM(B3:B8)", "=B12+B13", "=SUM(B10:B16)"]],
    },
    {
        "name": "move rows on a referenced sheet",
        "sheets": [S, "My Data"],
        "gestures": [move(R, "My Data", 10, 2, 4)],
        "formulas": [f(text) for text in ["=SUM('My Data'!B3:B6)", "='My Data'!B10+'My Data'!B11", "=SUM('My Data'!3:6)"]],
    },
    row_case(
        "move a row into whole rows",
        [move(R, S, 10, 1, 5)],
        formulas=["=SUM(3:6)", "=SUM($3:$6)", "=SUM(B3:B6)"],
    ),
    {
        "name": "move columns, then insert and delete columns",
        "gestures": [move(C, S, 2, 2, 9), ins(C, S, 3), dele(C, S, 7)],
        "formulas": [f(text) for text in ["=SUM(D2:G2)", "=B3+C3", "=SUM(E:H)", "=SUM(H2:I2)"]],
    },
    # --- Sequences around deleted corners (refilled corner gaps) ---------------
    {
        "name": "delete a range's first row, then insert where it was",
        "gestures": [dele(R, S, 3), ins(R, S, 3)],
        "formulas": [
            f("=SUM(B3:B6)", expect=flagged(
                "LibreOffice shrinks the deleted first corner to the next row at the moment of deletion, "
                "so the later insertion at that row shifts the range. The spec renders from the "
                "tombstone's glued position, which puts the inserted row inside the range: the "
                "\"refilled corner gap\" class of \"Where this differs from Excel\" (tombstoneCorner)."
            )),
            f("=B4"),
        ],
    },
    {
        "name": "delete a range's last row, then insert where it was",
        "gestures": [dele(R, S, 6), ins(R, S, 6)],
        "formulas": [f("=SUM(B3:B6)"), f("=B7")],
    },
    {
        "name": "delete a range's first column, then insert where it was",
        "gestures": [dele(C, S, 3), ins(C, S, 3, 2)],
        "formulas": [
            f("=SUM(C2:F2)", expect=flagged(
                "As for rows: LibreOffice shrinks the deleted first corner, then shifts it on the "
                "insertion; the spec's tombstone glue puts the new columns inside the range "
                "(refilled corner gap, tombstoneCorner)."
            )),
            f("=D3"),
        ],
    },
    row_case(
        "insert rows, then delete some of them with source rows",
        [ins(R, S, 4, 3), dele(R, S, 5, 4)],
        formulas=["=SUM(B3:B6)", "=SUM(B4:B9)", "=B4+B7+B8", "=SUM(2:12)"],
    ),
    row_case(
        "delete rows, then move a row across the gap",
        [dele(R, S, 5, 2), move(R, S, 12, 1, 4)],
        formulas=["=SUM(B3:B8)", "=B14", "=SUM(B10:B16)"],
    ),
]


# --- LibreOffice session (inside soffice) --------------------------------------------


def prop(name_, value):
    return PropertyValue(name_, 0, value, 0)


class Office:
    def __init__(self):
        self.ctx = uno.getComponentContext()
        self.desktop = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", self.ctx)

    def new_document(self):
        return self.desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (prop("Hidden", True),))

    def open(self, path):
        """Load a file, refusing interactive repair: a package that needs repair fails to load."""
        return self.desktop.loadComponentFromURL(
            Path(path).resolve().as_uri(), "_blank", 0, (prop("Hidden", True), prop("RepairPackage", False)),
        )


class Workbook:
    """A Calc document with an Excel A1 (OOXML) formula parser."""

    def __init__(self, doc):
        self.doc = doc
        self.names = list(doc.Sheets.ElementNames)
        self.parser = self.doc.createInstance("com.sun.star.sheet.FormulaParser")
        self.parser.FormulaConvention = uno.getConstantByName("com.sun.star.sheet.AddressConvention.XL_OOX")
        self.parser.CompileEnglish = True
        mapper = self.doc.createInstance("com.sun.star.sheet.FormulaOpCodeMapper")
        self.parser.OpCodeMap = mapper.getAvailableMappings(
            uno.getConstantByName("com.sun.star.sheet.FormulaLanguage.OOXML"),
            uno.getConstantByName("com.sun.star.sheet.FormulaMapGroup.ALL_EXCEPT_SPECIAL"),
        )

    @classmethod
    def for_case(cls, office, sheet_names):
        """A new document with `sheet_names`, each filled with numbers over the source extent."""
        doc = office.new_document()
        sheets = doc.Sheets
        sheets.getByIndex(0).Name = sheet_names[0]
        for index, sheet_name in enumerate(sheet_names[1:], start=1):
            sheets.insertNewByName(sheet_name, index)
        while sheets.Count > len(sheet_names):
            sheets.removeByName(sheets.getByIndex(sheets.Count - 1).Name)
        workbook = cls(doc)
        data = tuple(
            tuple(float(row * 100 + column) for column in range(1, COLUMNS + 1))
            for row in range(1, ROWS + 1)
        )
        for sheet_name in sheet_names:
            workbook.sheet(sheet_name).getCellRangeByPosition(0, 0, COLUMNS - 1, ROWS - 1).setDataArray(data)
        return workbook

    def sheet(self, sheet_name):
        return self.doc.Sheets.getByName(sheet_name)

    def index(self, sheet_name):
        return self.names.index(sheet_name)

    def address(self, sheet_name, row, column):
        return CellAddress(self.index(sheet_name), column - 1, row - 1)

    def set_formula(self, sheet_name, row, column, text):
        position = self.address(sheet_name, row, column)
        tokens = self.parser.parseFormula(text[1:], position)
        self.sheet(sheet_name).getCellByPosition(column - 1, row - 1).setTokens(tokens)
        back = self.formula(sheet_name, row, column)
        if back != text:
            raise RuntimeError(f"LibreOffice read {text!r} back as {back!r} before any gesture")

    def formula(self, sheet_name, row, column):
        cell = self.sheet(sheet_name).getCellByPosition(column - 1, row - 1)
        return "=" + self.parser.printFormula(cell.getTokens(), self.address(sheet_name, row, column))

    def add_name(self, defined, text):
        ranges = self.doc.NamedRanges
        ranges.addNewByName(defined, "0", CellAddress(0, 0, 0), 0)
        ranges.getByName(defined).setTokens(self.parser.parseFormula(text, CellAddress(0, 0, 0)))
        back = self.name(defined)
        if back != text:
            raise RuntimeError(f"LibreOffice read name {defined} {text!r} back as {back!r} before any gesture")

    def name(self, defined):
        tokens = self.doc.NamedRanges.getByName(defined).getTokens()
        return self.parser.printFormula(tokens, CellAddress(0, 0, 0))

    # --- Gestures ---------------------------------------------------------

    def insert(self, axis, sheet_name, before, count):
        target = self.sheet(sheet_name).Rows if axis == R else self.sheet(sheet_name).Columns
        target.insertByIndex(before - 1, count)

    def delete(self, axis, sheet_name, first, count):
        target = self.sheet(sheet_name).Rows if axis == R else self.sheet(sheet_name).Columns
        target.removeByIndex(first - 1, count)

    def move(self, axis, sheet_name, first, count, before):
        sheet = self.sheet(sheet_name)
        self.insert(axis, sheet_name, before, count)
        source = first if before > first else first + count
        last_row = sheet.Rows.Count - 1
        last_column = sheet.Columns.Count - 1
        if axis == R:
            block = sheet.getCellRangeByPosition(0, source - 1, last_column, source + count - 2)
            destination = CellAddress(self.index(sheet_name), 0, before - 1)
        else:
            block = sheet.getCellRangeByPosition(source - 1, 0, source + count - 2, last_row)
            destination = CellAddress(self.index(sheet_name), before - 1, 0)
        sheet.moveRange(destination, block.getRangeAddress())
        self.delete(axis, sheet_name, source, count)

    def apply(self, gesture):
        """Apply one gesture, or, for the saved-file check, a `set` cell edit."""
        op = gesture["op"]
        if op == "set":
            sheet = self.sheet(gesture["sheet"])
            cell = sheet.getCellRangeByName(gesture["cell"])
            value = gesture["value"]
            if isinstance(value, str) and value.startswith("="):
                address = cell.CellAddress
                cell.setTokens(self.parser.parseFormula(value[1:], address))
            elif isinstance(value, str):
                cell.setString(value)
            else:
                cell.setValue(value)
            return
        axis = R if op.endswith(R) else C
        if op.startswith("insert"):
            self.insert(axis, gesture["sheet"], gesture["before"], gesture["count"])
        elif op.startswith("delete"):
            self.delete(axis, gesture["sheet"], gesture["first"], gesture["count"])
        else:
            self.move(axis, gesture["sheet"], gesture["first"], gesture["count"], gesture["before"])

    def snapshot(self):
        """Recalculate, then every non-empty cell's formula (Excel A1) and value, and every defined name."""
        self.doc.calculateAll()
        cells = {}
        for sheet_name in self.names:
            sheet = self.sheet(sheet_name)
            cursor = sheet.createCursor()
            cursor.gotoEndOfUsedArea(False)
            end = cursor.RangeAddress
            for row in range(end.EndRow + 1):
                for column in range(end.EndColumn + 1):
                    cell = sheet.getCellByPosition(column, row)
                    kind = cell.Type.value
                    if kind == "EMPTY":
                        continue
                    entry = {}
                    if kind == "FORMULA":
                        entry["formula"] = self.formula(sheet_name, row + 1, column + 1)
                        if cell.getError() != 0:
                            entry["value"] = f"error {cell.getError()}"
                        elif cell.FormulaResultType2 == 1:
                            entry["value"] = cell.getValue()
                        else:
                            entry["value"] = cell.getString()
                    elif kind == "VALUE":
                        entry["value"] = cell.getValue()
                    else:
                        entry["value"] = cell.getString()
                    cells[f"{sheet_name}!{column_letters(column + 1)}{row + 1}"] = entry
        names = {
            defined: self.name(defined)
            for defined in self.doc.NamedRanges.ElementNames
        }
        return {"cells": cells, "names": names}

    def close(self):
        self.doc.close(True)


def column_letters(number):
    letters = ""
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


# --- Running a case -------------------------------------------------------------


def track(position, gesture, axis):
    """1-based row or column of a formula cell after a gesture on its sheet."""
    op = gesture["op"]
    if not op.endswith(axis):
        return position
    count = gesture["count"]
    if op.startswith("insert"):
        return position + count if position >= gesture["before"] else position
    if op.startswith("delete"):
        first = gesture["first"]
        if first <= position < first + count:
            raise RuntimeError("a gesture deleted a formula cell")
        return position - count if position >= first + count else position
    first, before = gesture["first"], gesture["before"]
    if first <= position < first + count:
        raise RuntimeError("a gesture moved a formula cell")
    # insert at `before`, then delete the emptied block
    shifted = position + count if position >= before else position
    source = first if before > first else first + count
    return shifted - count if shifted >= source + count else shifted


def run_case(office, case):
    sheet_names = case.get("sheets", [S])
    workbook = Workbook.for_case(office, sheet_names)
    try:
        placed = []
        next_row = {sheet_name: FORMULA_ROW for sheet_name in sheet_names}
        for formula in case["formulas"]:
            if "name" in formula:
                workbook.add_name(formula["name"], formula["text"])
                placed.append(None)
                continue
            row = next_row[formula["sheet"]]
            next_row[formula["sheet"]] += 1
            workbook.set_formula(formula["sheet"], row, FORMULA_COLUMN, formula["text"])
            placed.append([formula["sheet"], row, FORMULA_COLUMN])
        for gesture in case["gestures"]:
            workbook.apply(gesture)
            for cell in placed:
                if cell is not None and cell[0] == gesture["sheet"]:
                    cell[1] = track(cell[1], gesture, R)
                    cell[2] = track(cell[2], gesture, C)
        formulas = []
        for formula, cell in zip(case["formulas"], placed):
            if cell is None:
                text = "=" + formula["text"]
                result = "=" + workbook.name(formula["name"])
                entry = {"name": formula["name"], "text": text, "libreoffice": result}
            else:
                result = workbook.formula(*cell)
                entry = {"sheet": formula["sheet"], "text": formula["text"], "libreoffice": result}
            if "expect" in formula:
                entry["expect"] = formula["expect"]
            formulas.append(entry)
        return {
            "name": case["name"],
            "sheets": sheet_names,
            "headerRow": case.get("headerRow", 0),
            "gestures": case["gestures"],
            "formulas": formulas,
        }
    finally:
        workbook.close()


def generate(*_args):
    """The macro: run the cases, write the result JSON to $TV_FORMULA_ORACLE_OUT, quit."""
    out = Path(os.environ[ENV_OUT])
    office = Office()
    try:
        only = os.environ.get(ENV_ONLY)
        cases = [case for case in CASES if not only or only in case["name"]]
        results = [run_case(office, case) for case in cases]
        fixture = {
            "generator": "scripts/libreoffice-formula-oracle.py",
            "libreoffice": os.environ[ENV_VERSION],
            "rows": ROWS,
            "columns": COLUMNS,
            "cases": results,
        }
        out.write_text(json.dumps(fixture, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except Exception:
        out.with_suffix(".error").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        office.desktop.terminate()


def compare_snapshots(expected, saved):
    """Every cell and defined name where LibreOffice's own result and the saved file differ."""
    differences = []
    for key in sorted(set(expected["cells"]) | set(saved["cells"])):
        want = expected["cells"].get(key, {})
        got = saved["cells"].get(key, {})
        for field in ("formula", "value"):
            if want.get(field) != got.get(field):
                differences.append({"at": key, "field": field, "libreoffice": want.get(field), "saved": got.get(field)})
    for defined in sorted(set(expected["names"]) | set(saved["names"])):
        if expected["names"].get(defined) != saved["names"].get(defined):
            differences.append({
                "at": defined,
                "field": "name",
                "libreoffice": expected["names"].get(defined),
                "saved": saved["names"].get(defined),
            })
    return differences


def check_saved(*_args):
    """The macro behind --check-saved: compare saved files with LibreOffice's own gestures on the originals."""
    out = Path(os.environ[ENV_OUT])
    office = Office()
    try:
        spec = json.loads(Path(os.environ[ENV_SPEC]).read_text(encoding="utf-8"))
        results = []
        for entry in spec:
            original = Workbook(office.open(entry["original"]))
            try:
                for gesture in entry["gestures"]:
                    original.apply(gesture)
                expected = original.snapshot()
            finally:
                original.close()
            saved = Workbook(office.open(entry["saved"]))
            try:
                actual = saved.snapshot()
            finally:
                saved.close()
            results.append({
                "name": entry["name"],
                "loaded": True,
                "cells": len(actual["cells"]),
                "formulas": sum(1 for cell in actual["cells"].values() if "formula" in cell),
                "errors": sorted(key for key, cell in actual["cells"].items() if str(cell.get("value")).startswith("error")),
                "differences": compare_snapshots(expected, actual),
            })
        out.write_text(json.dumps({"libreoffice": os.environ[ENV_VERSION], "results": results}, indent=2) + "\n", encoding="utf-8")
    except Exception:
        out.with_suffix(".error").write_text(traceback.format_exc(), encoding="utf-8")
    finally:
        office.desktop.terminate()


g_exportedScripts = (generate, check_saved)


# --- Launcher (any Python 3) -------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--soffice", default=DEFAULT_SOFFICE)
    parser.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / FIXTURE))
    parser.add_argument("--only", help="print only the cases whose name contains this text")
    parser.add_argument(
        "--check-saved",
        metavar="SPEC",
        help="instead of the fixture, check saved .xlsx files against LibreOffice's own gestures (see header)",
    )
    args = parser.parse_args()
    version = subprocess.run(
        [args.soffice, "--headless", "--version"], capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()[-1].strip()
    work = Path(tempfile.mkdtemp(prefix="tv-formula-oracle-"))
    try:
        scripts = work / "profile" / "user" / "Scripts" / "python"
        scripts.mkdir(parents=True)
        shutil.copyfile(__file__, scripts / "formula_oracle.py")
        result = work / "result.json"
        env = {**os.environ, ENV_OUT: str(result), ENV_VERSION: version, ENV_ONLY: args.only or ""}
        macro = "generate"
        if args.check_saved:
            env[ENV_SPEC] = str(Path(args.check_saved).resolve())
            macro = "check_saved"
        subprocess.run(
            [
                args.soffice,
                "--headless",
                "--norestore",
                "--nologo",
                "--nolockcheck",
                f"-env:UserInstallation={(work / 'profile').as_uri()}",
                f"vnd.sun.star.script:formula_oracle.py${macro}?language=Python&location=user",
            ],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=1800,
        )
        error = result.with_suffix(".error")
        if error.exists():
            sys.exit(error.read_text(encoding="utf-8"))
        if not result.exists():
            sys.exit("LibreOffice exited without writing a result.")
        if args.check_saved:
            print(result.read_text(encoding="utf-8"), end="")
            return
        if args.only:
            print(json.dumps(json.loads(result.read_text(encoding="utf-8"))["cases"], indent=2, ensure_ascii=False))
            return
        shutil.copyfile(result, args.out)
        count = len(json.loads(result.read_text(encoding="utf-8"))["cases"])
        print(f"wrote {count} cases from {version} to {args.out}")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

# Filter rows

Filters temporarily hide rows that do not match the values you want to see. They never change the original file. Table Viewer remembers your filters for each file and worksheet and applies them again when the file reloads.

## Filter a column

1. Right-click the column header.
2. Choose **Filter…**. If the column already has a filter, choose **Edit filter…**.
3. Choose a condition, such as **Contains**, **Between**, or **Is one of**.
4. Enter or select the values you want, then click **Apply**.

You can also click a cell in the column and press `Shift+Alt+F`.

For a number column, the editor also shows a small chart of the column's values. For **Between**, type the lower and upper values, or drag across the chart to fill them in.

## Manage active filters

After you apply a filter, it appears as a control above the table. From there you can edit, temporarily disable, re-enable, or remove it. A disabled filter is remembered but does not hide any rows.

The column header's right-click menu offers the same actions for that column's filter: **Edit filter…**, **Clear filter on this column**, and — when any filter is active — **Clear all filters**.

If you prefer the keyboard, `Shift+Alt+X` clears the filter on the focused column, and `Shift+Alt+9` clears every filter on the worksheet.

You can filter more than one column at a time. For example, if **Country** is filtered to Canada and **Year** is filtered to 2025, only rows matching both filters stay visible.

## Conditions

The **Condition** menu offers:

| Condition | Use it to |
| --- | --- |
| **Contains** | Keep rows where the cell includes the text you enter. |
| **Is one of** | Choose values from a checklist of the column's values. |
| **Does not contain** | Hide rows where the cell includes the text you enter. |
| **Equals** / **Does not equal** | Keep or hide cells that match a value exactly. Numbers are compared as numbers. |
| **Starts with** / **Ends with** | Keep rows where the cell begins or ends with the text you enter. |
| **Greater than**, **Less than**, and their **or equal** variants | Keep values above or below a threshold. |
| **Between (inclusive)** / **Not between** | Keep or hide values in a range. Both endpoints count as inside the range. If you enter the bounds in the wrong order, they are swapped for you. |
| **Is empty** / **Is not empty** | Keep rows whose cell is blank, or hide them. |

For text conditions, a **Case sensitive** checkbox lets you choose whether uppercase and lowercase letters count as different.

The menu only shows conditions that suit the column: a number column hides the text conditions, a text column hides the range conditions, and date columns get both. If a saved filter uses a condition that no longer suits the column — for example after the file's contents changed — that condition is still shown so you can review or edit the existing filter.

A few things to know about how values are compared:

- Filters use the cell's underlying value, not necessarily the formatted text shown in the table. For example, a cell displayed as `$1,234.50` may be stored — and filtered — as `1234.5`. The **Formatting** control shows those underlying values.
- Cells that are empty or contain only spaces count as blank: they match **Is empty**, and they never match the other conditions, including the negative ones such as **Does not contain**.
- Dates use text ordering for range conditions. Dates written consistently in ISO format (`2026-07-22`) order correctly; mixed date styles in one column may not.

## The "Is one of" checklist

**Is one of** lists the values found in the column, with a search box for long lists. Empty cells appear as **(Blanks)**. Uncheck the values you want to hide, then click **Apply**; everything left checked stays visible.

- Values must match exactly. Capitalization matters, and values written differently are separate entries — `North` and `north`, or `1` and `1.0`.
- If every value is checked, no rows would be hidden, so there is nothing to apply; uncheck at least one value to enable **Apply**.
- The checklist remembers which values you *unchecked*. If a new value appears after the file changes, it stays visible, because you never unchecked it. There is currently no way to keep a fixed list of several allowed values that excludes future newcomers; **Equals** can do this for a single value.
- **Is one of** is available only when Table Viewer can collect the column's full list of values. It is not offered while a large column is still being read, if reading fails, or if the column has more than 1,000 different values. A previously saved checklist filter on such a column stays editable, though only the values you had unchecked are shown.

## How the starting condition is chosen

When you open the filter editor on a column with no filter yet, Table Viewer examines the column and picks a starting condition:

- **Number columns** start on **Between**, paired with the chart so you can pick a range visually.
- **Category-like columns** start on **Is one of**, with the checklist ready to search.
- **Everything else** starts on **Contains**.

Table Viewer treats a column as category-like when it is not a number column and contains at most 1,000 different values, blanks included. Columns such as **Status** or **Country** usually qualify; columns of names, comments, or other free text usually have too many different values and start on **Contains**.

Column types come from the cells themselves. Cells holding numbers — or text that reads as a plain number — make a number column. Date cells, or text in ISO date format, make a date column. Anything else is text, as is a column mixing numbers, dates, and text. Blank cells are ignored when deciding the type, so a column of numbers with some blanks still counts as a number column.

Examining a large column can take a moment. While that happens the editor may show **Contains** first and then switch to a better starting condition. As soon as you change anything, the choice is yours: the condition never changes under you once you have edited the filter, and editing an existing filter never changes its condition.

## Limits and special cases

- Filtering is unavailable while you are editing a CSV or TSV in the table, and in the synchronized side-by-side preview. Leave edit mode, or open the file as a regular table, to use filters.
- When a worksheet with merged cells is filtered, sorted, or has hidden columns, the merged cells are temporarily shown separately, with the value in the original top-left cell and the other cells blank. The merged layout returns once no filters or sorts are active and all columns are visible again.
- Saved filters are tied to the worksheet's column layout. If a reloaded file has a different worksheet name, column count, or column names, Table Viewer removes the saved filters rather than risk applying them to the wrong columns.

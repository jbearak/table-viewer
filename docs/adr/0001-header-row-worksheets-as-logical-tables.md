# Treat Header Row worksheets as logical tables

Table Viewer treats each worksheet with an active Header Row as one logical table, so formulas can use Excel-style column references without creating an OOXML table region. It preserves those references in the workbook because converting them to A1 addresses would discard their meaning, even though Excel may not calculate them on a worksheet that has not been formatted as a real table.

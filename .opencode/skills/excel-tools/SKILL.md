---
name: excel-tools
description: "ALWAYS load this skill before working with Excel files. Provides traced, observable excel-read/excel-write/excel-calc tools with formula protection, cell styling analysis (identify input vs formula cells by fill color), and recalculation. These tools are instrumented for observability — never use bash/python to read or write xlsx files directly."
---

## Excel Tools Skill

You have dedicated, instrumented tools for working with Excel files (.xlsx, .xlsm). These tools provide observability, tracing, formula protection, and cell styling support.

**IMPORTANT: NEVER use bash or write Python/openpyxl scripts to read or modify Excel files.** Always use the `excel-read`, `excel-write`, and `excel-calc` tools below. They are instrumented for tracing and observability, provide formula-overwrite protection, and handle cell styling natively. Writing Python scripts bypasses all of this instrumentation.

### Available Tools

#### excel-read
Read cell values and/or formulas from Excel files.

**Modes:** `values` (default) | `formulas` | `both`

- List sheets in a workbook
- Read cells by reference (A1) or range (A1:C10)
- `extractFunctions=true` to list all Excel functions used
- **`style=true`** to include cell styling (fill colors, fonts, borders, alignment) in output — use this to identify input cells vs formula cells

#### excel-write
Write values, formulas, and formatting to cells.

- Write numeric values, strings, or formulas (strings starting with `=`)
- **Formula protection**: Blocks overwriting formula cells by default. Use `allowOverwriteFormulas=true` to override.
- `dryRun=true` to preview changes without saving
- `createSheet` to create a new sheet before writing
- `skipFormulaCheck` to skip formula-cell detection (faster for new files)
- `format` to apply number formats (e.g., `{"B4": "$#,##0", "B6": "0.00%"}`)
- `freezePanes` to freeze rows/columns above and left of a cell (e.g., `"B3"`)
- **`styling`** to apply cell styling (fill, font, border, alignment) — e.g., `{"A1": {"fill": {"type": "solid", "color": {"rgb": "0070C0"}}}}`

Writing to a file that does not exist auto-creates it.

#### excel-calc
Recalculate all formulas using the formulas Python engine.

- Parses formulas, builds dependency graph, calculates in order, writes cached values back
- `--inputs <cell>=<value>` and `--outputs <cell>` for combined write+calc+read in one call
- `checkCompatibility=true` to analyze formula support before calculating
- `cells` param to return specific cell values after calculation
- Response includes error scanning: any `#DIV/0!`, `#N/A`, `#VALUE!`, `#REF!` cells are flagged

#### excel-screenshot
Take a visual screenshot of a cell range as a PNG image.

- **Primary use case: visual verification of styling** — after applying fills, borders, fonts, or alignment with excel-write, use this to see what the cells actually look like
- `range` (required): Cell range to capture, e.g. `"A1:G20"`
- `sheet` (optional): Target sheet name
- `output` (optional): Output PNG path (default: auto-generated in `/tmp/.screenshots/`)
- `dpi` (optional): Resolution (default 150)
- Returns the PNG file path — **use the `read` tool on the path to view the image**

#### excel-vba
Extract VBA macro code from .xlsm files. List modules, extract source, count functions/subs.

---

### Financial Modeling Principles

When building financial models in Excel:

1. **Separate inputs from calculations.** Assumptions go in labeled cells (or a dedicated sheet). Formulas always reference those cells -- never hardcode numbers in formulas.

2. **Standard structure:** Assumptions -> Projections -> Returns. Each section clearly labeled with row headers.

3. **One formula per row, copy across columns.** Each row represents one concept (e.g., Revenue, EBITDA). Time periods go in columns. Write the formula once for the first period, then replicate across.

4. **Cell references with $ anchoring.** Use `$B$4` for fixed assumptions, `C12` for relative references. Mixed anchoring (`$B12`, `B$4`) when copying formulas across rows or columns.

5. **Format numbers for readability:**
   - Currency: `$#,##0` or `$#,##0.00`
   - Percentages: `0.0%` or `0.00%`
   - Multiples: `0.0x`
   - Integers: `#,##0`

6. **Freeze panes** after header rows/columns so the viewer can scroll without losing context.

---

### CRITICAL: Analyze Before Modifying

**Before writing ANY values or formulas to an existing spreadsheet, you MUST analyze its structure first.** Financial templates encode essential information in cell styling — fill colors, fonts, and borders distinguish input cells from formula cells, headers from data, and historical values from projections.

#### Step 0: Style Analysis (ALWAYS do this first)

```
1. READ with style=true   Read the full sheet range with style=true to see all cell styling
2. CLASSIFY cells          Group cells by their styling patterns:
   - Input cells:     Colored fills (often blue/light blue) — these are where you place values
   - Formula cells:   No fill or white fill — these contain formulas, do NOT overwrite
   - Headers/labels:  Bold text, borders, distinct font sizes — leave these alone
   - Historical data: Already populated values — may be read-only reference data
3. MAP the layout          Identify which rows are assumptions, which are calculations,
                           which columns are time periods vs labels
4. PLAN your writes        Only write to cells you've confirmed are input cells
```

**Why this matters:** LBO templates, DCF models, and other financial spreadsheets use color coding to signal where values should go. Writing to the wrong cells (e.g., overwriting a formula cell with a hardcoded number) breaks the model's calculation chain.

---

### Modifying Existing Workbooks

When filling in a template or modifying an existing workbook:

```
1. ANALYZE    Read with style=true, classify input vs formula vs label cells
2. READ       Read existing values/formulas with mode="both" to understand the model structure
3. PLAN       Map out which input cells need values and what those values should be
4. WRITE      Write values ONLY to identified input cells (one logical section at a time)
5. CALC       Recalculate after each section
6. VERIFY     Read back key output cells, check for #errors
7. SCREENSHOT Take a visual screenshot to verify styling looks correct
8. NARRATE    Explain results: "Revenue grows from $10M to $12.2M over 5 years"
9. REPEAT     Steps 4-8 for each section
```

---

### Build-from-Scratch Workflow

When creating a new workbook from nothing:

```
1. PLAN       Outline sheet structure, row/column layout, and formula logic
2. CREATE     Write to new file path (auto-creates) + create sheets with --createSheet
3. INPUTS     Write assumption labels and values with formatting and styling
4. FORMULAS   Write formulas section by section (one logical block at a time)
5. CALC       Recalculate after each section
6. VERIFY     Read back key cells, check for #errors
7. SCREENSHOT Take a visual screenshot to verify styling looks correct
8. NARRATE    Explain what you built and what the numbers mean
9. REPEAT     Steps 4-8 for each section
```

---

### Incremental Building

Build one logical section at a time. After each section:
1. **Calc** the workbook
2. **Read** back key output cells
3. **Verify** no errors (check for #DIV/0!, #REF!, #VALUE!, #N/A)
4. **Describe** results to the viewer: "Revenue grows from $10M to $12.2M over 5 years"

Before writing each section, announce what you are building:
> "Now building the revenue projection section..."

After verifying, report the key numbers:
> "Year 1 EBITDA is $2.5M at a 25% margin, growing to $3.2M by Year 5."

---

### Known Limitations

- **OFFSET / INDIRECT**: May not calculate correctly in the formulas engine. Use direct cell references instead.
- **Circular references**: Not supported. Use beginning-of-period balances to avoid circularity (e.g., opening balance = prior closing balance, interest on opening balance).
- **Array constants** (`{1,2,3}`): May not parse correctly. Use helper cells instead.
- **External add-ins** (Bloomberg, Capital IQ): Will not work.
- **Real-time data** (RTD), GETPIVOTDATA, WEBSERVICE: Not available.

Use `--useLibreoffice` fallback only if the formulas engine fails on a specific workbook.

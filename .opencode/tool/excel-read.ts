import { tool } from '@opencode-ai/plugin';
import { $ } from 'bun';
import { join, isAbsolute } from 'path';

const DESCRIPTION = `Read cell values, formulas, and styling from an Excel file (.xlsx, .xlsm). ALWAYS use this tool instead of writing Python/openpyxl scripts — it is instrumented for observability and tracing.

Modes: 'values' (cached results), 'formulas' (formula text like =SUM(A1:A10)), or 'both' (formula + value).

Key feature: style=true returns cell fill colors, fonts, borders, and alignment. Use this to identify INPUT cells (colored fills, typically blue) vs FORMULA cells (no fill) vs HEADERS (bold, borders). Always read with style=true before modifying a spreadsheet.`;

export default tool({
  description: DESCRIPTION,
  args: {
    file: tool.schema.string().describe('Path to the Excel file'),
    sheet: tool.schema.string().optional().describe('Sheet name (default: active sheet)'),
    cells: tool.schema
      .array(tool.schema.string())
      .optional()
      .describe("Cell references to read, e.g., ['A1', 'B2', 'C3']"),
    range: tool.schema.string().optional().describe("Range reference to read, e.g., 'A1:C10'"),
    listSheets: tool.schema.boolean().optional().describe('List all sheets in the workbook'),
    mode: tool.schema
      .enum(['values', 'formulas', 'both'])
      .optional()
      .describe("Read mode: 'values' (cached results), 'formulas' (formula text), or 'both'"),
    extractFunctions: tool.schema
      .boolean()
      .optional()
      .describe('Extract all Excel functions used for compatibility analysis'),
    style: tool.schema
      .boolean()
      .optional()
      .describe(
        'Include cell styling (fill colors, font, borders, alignment) in output. Use this to identify input cells (often highlighted in blue) vs formula cells.'
      ),
  },
  async execute(args, context) {
    try {
      // Get base directory from environment variable or current working directory
      const baseDir = process.env.WORKSPACE_DIR || process.cwd();

      // Resolve tools dir: TOOLS_DIR (image-managed) or fallback to {baseDir}/tools (local dev)
      const toolsDir = process.env.TOOLS_DIR || join(baseDir, 'tools');
      const scriptPath = join(toolsDir, 'excel_read.py');

      // Resolve file path - if absolute use as-is, otherwise relative to baseDir
      const filePath = isAbsolute(args.file) ? args.file : join(baseDir, args.file);

      const cmdArgs: string[] = [filePath];

      if (args.listSheets) {
        cmdArgs.push('--list-sheets');
      } else if (args.extractFunctions) {
        cmdArgs.push('--extract-functions');
        if (args.sheet) {
          cmdArgs.push('--sheet', args.sheet);
        }
      } else {
        if (args.sheet) {
          cmdArgs.push('--sheet', args.sheet);
        }
        if (args.cells && args.cells.length > 0) {
          cmdArgs.push('--cells', ...args.cells);
        }
        if (args.range) {
          cmdArgs.push('--range', args.range);
        }
        if (args.mode) {
          cmdArgs.push('--mode', args.mode);
        }
        if (args.style) {
          cmdArgs.push('--style');
        }
      }

      // Use "python3" from PATH to support both Mac and Docker environments
      const pythonExecutable = 'python3';
      const args_to_pass = [scriptPath, ...cmdArgs];

      const proc = Bun.spawn([pythonExecutable, ...args_to_pass]);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return JSON.stringify({
          error: `Python script exited with code ${exitCode}`,
          stdout: stdout,
          stderr: stderr,
          command: `${pythonExecutable} ${args_to_pass.join(' ')}`,
        });
      }

      return stdout;
    } catch (error: any) {
      return JSON.stringify({
        error: error.message || String(error),
        stack: error.stack,
      });
    }
  },
});

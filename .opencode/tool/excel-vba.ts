import { tool } from '@opencode-ai/plugin';
import { $ } from 'bun';
import { join, isAbsolute } from 'path';

const DESCRIPTION = `Extract and inspect VBA macro code from Excel files (.xlsm, .xls). Can list all VBA modules with their function/sub counts, or extract the full source code from specific modules. Useful for understanding spreadsheet automation logic.`;

export default tool({
  description: DESCRIPTION,
  args: {
    file: tool.schema.string().describe('Path to the Excel file (.xlsm or .xls)'),
    module: tool.schema
      .string()
      .optional()
      .describe('Specific VBA module to extract (default: all)'),
    listOnly: tool.schema.boolean().optional().describe('List modules without extracting code'),
  },
  async execute(args, context) {
    try {
      // Get base directory from environment variable or current working directory
      const baseDir = process.env.WORKSPACE_DIR || process.cwd();

      // Resolve tools dir: TOOLS_DIR (image-managed) or fallback to {baseDir}/tools (local dev)
      const toolsDir = process.env.TOOLS_DIR || join(baseDir, 'tools');
      const scriptPath = join(toolsDir, 'excel_vba.py');

      // Resolve file path - if absolute use as-is, otherwise relative to baseDir
      const filePath = isAbsolute(args.file) ? args.file : join(baseDir, args.file);

      // Use "python3" from PATH to support both Mac and Docker environments
      const pythonExecutable = 'python3';
      const args_to_pass = [scriptPath, filePath];

      if (args.listOnly) {
        args_to_pass.push('--list');
      } else if (args.module) {
        args_to_pass.push('--module', args.module);
      }

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

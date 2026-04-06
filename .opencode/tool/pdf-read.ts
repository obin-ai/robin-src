import { tool } from '@opencode-ai/plugin';
import { join, isAbsolute } from 'path';

const DESCRIPTION = `Read and extract text from a PDF file. Returns the text content of all pages (or specified pages) in either structured JSON or plain text format. Use this to read PDF documents in the workspace, such as financial guides, reports, or reference materials.`;

export default tool({
  description: DESCRIPTION,
  args: {
    file: tool.schema.string().describe('Path to the PDF file'),
    pages: tool.schema
      .string()
      .optional()
      .describe(
        "Comma-separated page numbers or ranges (1-indexed), e.g., '1,2,3' or '1-5'. Default: all pages"
      ),
    format: tool.schema
      .enum(['json', 'text'])
      .optional()
      .describe(
        "Output format: 'json' (structured with per-page text) or 'text' (raw concatenated). Default: json"
      ),
  },
  async execute(args, context) {
    try {
      const baseDir = process.env.WORKSPACE_DIR || process.cwd();
      const toolsDir = process.env.TOOLS_DIR || join(baseDir, 'tools');
      const scriptPath = join(toolsDir, 'pdf_read.py');
      const filePath = isAbsolute(args.file) ? args.file : join(baseDir, args.file);

      const cmdArgs: string[] = [filePath];

      if (args.pages) {
        cmdArgs.push('--pages', args.pages);
      }
      if (args.format) {
        cmdArgs.push('--format', args.format);
      }

      const proc = Bun.spawn(['python3', scriptPath, ...cmdArgs]);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return JSON.stringify({
          error: `Python script exited with code ${exitCode}`,
          stdout: stdout,
          stderr: stderr,
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

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Instance } from "../../project/instance"
import { lazy } from "../../util/lazy"
import { Bus } from "@/bus"
import { WorkspaceEvent } from "@/workspace/event"
import fs from "fs"
import path from "path"
import { readdir, mkdir } from "fs/promises"

const FileInfo = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
  modified: z.string(),
})

async function scanDir(dir: string, extensions: string[]): Promise<z.infer<typeof FileInfo>[]> {
  const results: z.infer<typeof FileInfo>[] = []
  try {
    const entries = await readdir(dir)
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase()
      if (extensions.includes(ext)) {
        const fullPath = path.join(dir, entry)
        try {
          const stat = fs.statSync(fullPath)
          results.push({
            name: entry,
            path: fullPath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          })
        } catch {
          // Skip files we can't stat
        }
      }
    }
  } catch {
    // Directory doesn't exist, return empty
  }
  return results
}

export const WorkspaceRoutes = lazy(() =>
  new Hono()
    .get(
      "/files",
      describeRoute({
        summary: "List workspace files",
        description: "List xlsx, xlsm, and pdf files in the workspace root, output, and inputs directories.",
        operationId: "workspace.files",
        responses: {
          200: {
            description: "Workspace files",
            content: {
              "application/json": {
                schema: resolver(FileInfo.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const root = Instance.directory
        const extensions = [".xlsx", ".xlsm", ".pdf"]
        const dirs = [root, path.join(root, "output"), path.join(root, "inputs")]
        const allFiles: z.infer<typeof FileInfo>[] = []
        for (const dir of dirs) {
          const files = await scanDir(dir, extensions)
          allFiles.push(...files)
        }
        return c.json(allFiles)
      },
    )
    .get(
      "/file",
      describeRoute({
        summary: "Serve workspace file",
        description: "Serve a binary file from the workspace by path.",
        operationId: "workspace.file",
        responses: {
          200: {
            description: "File content",
            content: {
              "application/octet-stream": {
                schema: resolver(z.string()),
              },
            },
          },
          400: {
            description: "Invalid path",
          },
          404: {
            description: "File not found",
          },
        },
      }),
      validator(
        "query",
        z.object({
          path: z.string(),
        }),
      ),
      async (c) => {
        const filePath = c.req.valid("query").path
        const normalized = path.resolve(filePath)
        if (!normalized.startsWith(Instance.directory)) {
          return c.json({ error: "Path outside workspace" }, 400)
        }
        const file = Bun.file(normalized)
        if (!(await file.exists())) {
          return c.json({ error: "File not found" }, 404)
        }
        const bytes = await file.arrayBuffer()
        return new Response(bytes, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${path.basename(normalized)}"`,
          },
        })
      },
    )
    .post(
      "/upload",
      describeRoute({
        summary: "Upload file to workspace",
        description: "Upload a file to the workspace inputs directory via multipart form.",
        operationId: "workspace.upload",
        responses: {
          200: {
            description: "Upload result",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    path: z.string(),
                    name: z.string(),
                    size: z.number(),
                  }),
                ),
              },
            },
          },
          400: {
            description: "No file provided",
          },
        },
      }),
      async (c) => {
        const body = await c.req.parseBody()
        const file = body["file"]
        if (!file || typeof file === "string") {
          return c.json({ error: "No file provided" }, 400)
        }
        const inputsDir = path.join(Instance.directory, "inputs")
        await mkdir(inputsDir, { recursive: true })
        const filename = file.name || "upload"
        const savedPath = path.join(inputsDir, filename)
        const buffer = await file.arrayBuffer()
        await Bun.write(savedPath, buffer)
        const stat = fs.statSync(savedPath)
        Bus.publish(WorkspaceEvent.Updated, { type: "file_added", file: savedPath })
        return c.json({
          path: savedPath,
          name: filename,
          size: stat.size,
        })
      },
    ),
)

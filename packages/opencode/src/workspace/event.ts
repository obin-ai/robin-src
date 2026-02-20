import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export namespace WorkspaceEvent {
  export const Updated = BusEvent.define(
    "workspace.updated",
    z.object({
      type: z.enum(["cell_write", "recalculation", "file_added", "file_changed"]),
      file: z.string(),
      sheet: z.string().optional(),
      changes: z
        .array(
          z.object({
            cell: z.string(),
            sheet: z.string().optional(),
            value: z.any().optional(),
            formula: z.string().optional(),
            numberFormat: z.string().optional(),
          }),
        )
        .optional(),
    }),
  )
}

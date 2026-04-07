import { BusEvent } from "@/bus/bus-event"
import z from "zod"

export namespace WorkspaceEvent {
  export const Updated = BusEvent.define(
    "workspace.updated",
    z.object({
      type: z.enum(["cell_write", "cell_read", "recalculation", "file_added", "file_changed", "workbook_delta", "chart_created", "canvas_created", "canvas_updated"]),
      file: z.string(),
      sheet: z.string().optional(),
      trigger: z.enum(["write", "read", "recalc", "sync"]).optional(),
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
      deltas: z
        .array(
          z.object({
            ref: z.object({
              sheet: z.string(),
              row: z.number(),
              col: z.number(),
              cell: z.string().optional(),
            }),
            before: z.any().optional(),
            after: z.any(),
            changed: z
              .array(
                z.enum(["value", "displayValue", "formula", "computedValue", "style", "numberFormat"]),
              ),
          }),
        )
        .optional(),
      // Canvas/chart event fields
      canvas_id: z.string().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      html: z.string().optional(),
    }),
  )
}

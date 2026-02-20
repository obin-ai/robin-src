import { Log } from "./util/log"

export namespace Telemetry {
  const log = Log.create({ service: "telemetry" })
  let initialized = false

  export function init(enabled?: boolean) {
    if (initialized || !enabled) return
    initialized = true

    try {
      const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base")
      const { TraceExporter } = require("@google-cloud/opentelemetry-cloud-trace-exporter")

      const exporter = new TraceExporter()
      const provider = new BasicTracerProvider()
      provider.addSpanProcessor(new BatchSpanProcessor(exporter))
      provider.register()

      log.info("registered Google Cloud Trace exporter")

      process.on("beforeExit", async () => {
        await provider.shutdown()
      })
    } catch (e) {
      log.error("failed to initialize OpenTelemetry", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}

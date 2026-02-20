import { Log } from "./util/log"

export namespace Telemetry {
  const log = Log.create({ service: "telemetry" })
  let initPromise: Promise<void> | undefined

  /**
   * Initialize OpenTelemetry tracing with Google Cloud's OTLP HTTP endpoint.
   * Returns a promise that resolves once the tracer provider is registered.
   * Safe to call multiple times — only the first call does work.
   */
  export function init(enabled?: boolean): Promise<void> {
    if (!enabled) return Promise.resolve()
    if (initPromise) return initPromise

    initPromise = _init()
    return initPromise
  }

  /**
   * Wraps an OTLPTraceExporter and refreshes the ADC bearer token
   * before each export. Tokens last ~3600s; this ensures long-running
   * processes never export with an expired token.
   */
  function createRefreshingExporter(
    OTLPTraceExporter: any,
    authClient: any,
    projectId: string,
    initialToken: string,
  ) {
    let currentToken = initialToken

    const buildExporter = (token: string) =>
      new OTLPTraceExporter({
        url: "https://telemetry.googleapis.com/v1/traces",
        headers: {
          Authorization: `Bearer ${token}`,
          "x-goog-user-project": projectId,
        },
      })

    let inner = buildExporter(currentToken)

    // Refresh token 5 minutes before typical expiry (3600s)
    const REFRESH_MS = 55 * 60 * 1000
    const refreshInterval = setInterval(async () => {
      try {
        const accessToken = await authClient.getAccessToken()
        const token = typeof accessToken === "string" ? accessToken : accessToken?.token
        if (!token) {
          log.warn("skipping trace exporter token refresh: empty access token")
          return
        }
        if (token && token !== currentToken) {
          const previous = inner
          inner = buildExporter(token)
          currentToken = token
          // Shut down old exporter after swapping to avoid racing in-flight exports.
          void previous.shutdown().catch(() => {})
          log.info("refreshed OTLP trace exporter token")
        }
      } catch (e) {
        log.warn("failed to refresh trace exporter token", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }, REFRESH_MS)
    refreshInterval.unref()

    return {
      inner: {
        export: (...args: any[]) => inner.export(...args),
        forceFlush: (...args: any[]) => inner.forceFlush?.(...args) ?? Promise.resolve(),
        shutdown: async () => {
          clearInterval(refreshInterval)
          await inner.shutdown()
        },
      },
      refreshInterval,
    }
  }

  async function _init() {
    try {
      const { BasicTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base")
      const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http")
      const { resourceFromAttributes } = require("@opentelemetry/resources")
      const { GoogleAuth } = require("google-auth-library")
      const { trace, diag, DiagLogLevel } = require("@opentelemetry/api")

      diag.setLogger(
        {
          error: (msg: string, ...args: unknown[]) => log.error(msg, { otel: args }),
          warn: (msg: string, ...args: unknown[]) => log.warn(msg, { otel: args }),
          info: () => {},
          debug: () => {},
          verbose: () => {},
        },
        DiagLogLevel.WARN,
      )

      const auth = new GoogleAuth({
        scopes: "https://www.googleapis.com/auth/cloud-platform",
      })

      const client = await auth.getClient()
      const projectId = await auth.getProjectId()
      const accessToken = await (client as any).getAccessToken()
      const token = typeof accessToken === "string" ? accessToken : accessToken?.token
      if (!token) throw new Error("GoogleAuth returned empty access token for OTLP exporter")

      const { inner: exporter, refreshInterval } = createRefreshingExporter(
        OTLPTraceExporter,
        client,
        projectId,
        token,
      )

      const provider = new BasicTracerProvider({
        resource: resourceFromAttributes({ "gcp.project_id": projectId }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      })
      trace.setGlobalTracerProvider(provider)

      log.info("registered OTLP HTTP trace exporter", {
        project: projectId,
        endpoint: "telemetry.googleapis.com",
      })

      // Flush spans on container shutdown signals, not just beforeExit
      const shutdown = async () => {
        clearInterval(refreshInterval)
        await provider.shutdown()
      }
      process.on("beforeExit", () => {
        clearInterval(refreshInterval)
        void provider.shutdown()
      })
      const onSigterm = () => {
        void shutdown().finally(() => {
          process.removeListener("SIGTERM", onSigterm)
          process.kill(process.pid, "SIGTERM")
        })
      }
      const onSigint = () => {
        void shutdown().finally(() => {
          process.removeListener("SIGINT", onSigint)
          process.kill(process.pid, "SIGINT")
        })
      }
      process.on("SIGTERM", onSigterm)
      process.on("SIGINT", onSigint)
    } catch (e) {
      log.error("failed to initialize OpenTelemetry", {
        error: e instanceof Error ? e.message : String(e),
      })
      // Don't rethrow — tracing failure shouldn't block the app.
      // Clear initPromise so a retry is possible if config changes.
      initPromise = undefined
    }
  }
}

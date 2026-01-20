import { cmd } from "../cmd"
import { tui } from "./app"
import { Flag } from "@/flag/flag"

// Create authenticated fetch wrapper (mirrors worker.ts pattern)
function createAuthenticatedFetch(): typeof fetch | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined

  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  const authHeader = `Basic ${btoa(`${username}:${password}`)}`

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    request.headers.set("Authorization", authHeader)
    return fetch(request)
  }) as typeof globalThis.fetch
}

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running opencode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      }),
  handler: async (args) => {
    if (args.dir) process.chdir(args.dir)
    await tui({
      url: args.url,
      args: { sessionID: args.session },
      directory: args.dir ? process.cwd() : undefined,
      fetch: createAuthenticatedFetch(),
    })
  },
})

/**
 * Oolong-RLM single-question runner.
 * Spawned as a fresh process per question to avoid Robin session hangs.
 *
 * Usage: bun run --conditions=browser scripts/oolong-rlm-eval.ts <context_file> <question>
 * Prints the answer to stdout, exits.
 */

import { Session } from "../packages/opencode/src/session"
import { SessionPrompt } from "../packages/opencode/src/session/prompt"
import { Provider } from "../packages/opencode/src/provider/provider"
import { Instance } from "../packages/opencode/src/project/instance"
import fs from "fs/promises"
import path from "path"

const contextFile = process.argv[2]
const question = process.argv[3]
const MODEL = process.env.MODEL ?? ""

if (!contextFile || !question) {
  console.error("Usage: bun run scripts/oolong-rlm-eval.ts <context_file> <question>")
  process.exit(1)
}

async function main() {
  const context = await fs.readFile(contextFile, "utf-8")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      let model: { providerID: string; modelID: string }
      if (MODEL) {
        model = Provider.parseModel(MODEL)
      } else {
        model = await Provider.defaultModel()
      }

      const session = await Session.create({
        title: `oolong: ${question.substring(0, 40)}`,
      })

      const prompt = [
        `Read the file at ${contextFile} using the read tool, then use rlm-repl to process it.`,
        ``,
        `Call rlm-repl with:`,
        `  reset_store: true`,
        `  store_data: '{"transcript": "<contents of the file>"}'`,
        ``,
        `Then call rlm-repl with this code:`,
        ``,
        `const chunks = context.chunk("ptr_0", 6000)`,
        `const q = ${JSON.stringify(question)}`,
        `const results = await Promise.all(`,
        `  chunks.slice(0, 25).map(c => sub_llm("Answer ONLY if relevant to: " + q + "\\n\\n" + context.load(c)))`,
        `)`,
        `const relevant = results.filter(r => !r.toLowerCase().includes("not relevant") && !r.toLowerCase().includes("no relevant"))`,
        `const answer = await sub_llm("Based on these findings, give the precise answer to: " + q + "\\n\\n" + relevant.join("\\n"))`,
        `return answer`,
        ``,
        `QUESTION: ${question}`,
        `Return ONLY the answer — a single number, name, or short phrase.`,
      ].join("\n")

      const result = await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "rlm",
        model,
        parts: [{ type: "text", text: prompt }],
      })

      // Extract answer from session messages
      const messages = await Session.messages({ sessionID: session.id })
      const texts = messages
        .filter((m: any) => m.info.role === "assistant")
        .flatMap((m: any) => m.parts.filter((p: any) => p.type === "text").map((p: any) => p.text))
        .filter(Boolean)

      const answer = texts[texts.length - 1] ?? ""

      // Write answer to stdout (the orchestrator reads this)
      process.stdout.write(JSON.stringify({ answer: answer.trim(), model: `${model.providerID}/${model.modelID}` }))
      process.exit(0)
    },
  })
}

// Force exit after 5 minutes regardless
setTimeout(() => {
  process.stdout.write(JSON.stringify({ answer: "", error: "timeout" }))
  process.exit(1)
}, 300_000)

main().catch((e) => {
  process.stdout.write(JSON.stringify({ answer: "", error: e.message?.substring(0, 200) }))
  process.exit(1)
})

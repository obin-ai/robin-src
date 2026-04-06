import { Tool } from "./tool"
import DESCRIPTION from "./rlm-context.txt"
import z from "zod"
import { Log } from "../util/log"
import { MessageV2 } from "../session/message-v2"
import fs from "fs/promises"

const log = Log.create({ service: "rlm-context" })

// ── Persistent REPL state per session ──────────────────────────────

interface StoreEntry {
  key: string
  data: string
  charCount: number
  preview: string
}

interface REPLState {
  context: string
  store: Map<string, StoreEntry>  // pointer → data
  nextPtrId: number
  locals: Record<string, any>
  answer: { content: string; ready: boolean }
  subLlmCalls: number
}

const replStates = new Map<string, REPLState>()

function getState(sessionID: string): REPLState {
  let state = replStates.get(sessionID)
  if (!state) {
    state = {
      context: "",
      store: new Map(),
      nextPtrId: 0,
      locals: {},
      answer: { content: "", ready: false },
      subLlmCalls: 0,
    }
    replStates.set(sessionID, state)
  }
  return state
}

// ── Tool Definition ────────────────────────────────────────────────

const parameters = z.object({
  code: z.string().describe(
    "Python code to execute in the REPL. Available: `context` (string), `llm_query(prompt)` (sub-LLM), `llm_batch(prompts)` (parallel sub-LLM), `context_store.store/load/chunk/describe` (pointer-based data), `answer` dict. State persists across calls.",
  ),
  context_file: z
    .string()
    .optional()
    .describe("Path to file to load as `context` variable. Only needed on first call."),
})

export const RlmContextTool = Tool.define("rlm-context", {
  description: DESCRIPTION,
  parameters,
  async execute(params: z.infer<typeof parameters>, ctx) {
    const state = getState(ctx.sessionID)

    // Load context from file if provided
    if (params.context_file) {
      try {
        state.context = await fs.readFile(params.context_file, "utf-8")
        state.locals = {}
        state.store = new Map()
        state.nextPtrId = 0
        state.answer = { content: "", ready: false }
        state.subLlmCalls = 0
        log.info("loaded context", { file: params.context_file, chars: state.context.length })
      } catch (e: any) {
        return { title: "Error loading file", metadata: {}, output: `Error: ${e.message}` }
      }
    }

    // Get parent model for llm_query calls
    const parentMsg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    const parentModel =
      parentMsg.info.role === "assistant"
        ? { modelID: parentMsg.info.modelID, providerID: parentMsg.info.providerID }
        : undefined

    // llm_query: direct LLM call (fast, no Robin session overhead)
    async function llmQuery(prompt: string): Promise<string> {
      state.subLlmCalls++
      if (state.subLlmCalls > 100) throw new Error("Max llm_query calls (100) exceeded")

      log.info("llm_query", { call: state.subLlmCalls, promptChars: prompt.length })

      if (!parentModel) return "Error: no model available for llm_query"

      try {
        const { Provider } = await import("../provider/provider")
        const { generateText } = await import("ai")

        const modelInfo = await Provider.getModel(parentModel.providerID, parentModel.modelID)
        const languageModel = await Provider.getLanguage(modelInfo)

        const result = await generateText({
          model: languageModel,
          prompt,
          maxTokens: 8192,
        })

        log.info("llm_query done", { call: state.subLlmCalls, responseChars: result.text.length })
        return result.text
      } catch (e: any) {
        log.error("llm_query error", { error: e.message })
        return `Error: ${e.message}`
      }
    }

    // llm_batch: parallel LLM calls (handles up to 10 concurrently)
    async function llmBatch(prompts: string[]): Promise<string[]> {
      const CONCURRENCY = 10
      const results: string[] = []
      for (let i = 0; i < prompts.length; i += CONCURRENCY) {
        const batch = prompts.slice(i, i + CONCURRENCY)
        const batchResults = await Promise.all(batch.map((p) => llmQuery(p)))
        results.push(...batchResults)
      }
      return results
    }

    // Execute the Python code
    const startTime = Date.now()

    try {
      // Write context and locals to temp files for Python to read
      const tmpDir = `/tmp/rlm_repl_${ctx.sessionID.replace(/[^a-zA-Z0-9]/g, "_")}`
      await fs.mkdir(tmpDir, { recursive: true })

      const contextFile = `${tmpDir}/context.txt`
      const localsFile = `${tmpDir}/locals.json`
      const codeFile = `${tmpDir}/code.py`
      const outputFile = `${tmpDir}/output.json`

      await fs.writeFile(contextFile, state.context)

      // Serialize store entries for Python
      const storeData: Record<string, { key: string; data: string; charCount: number; preview: string }> = {}
      for (const [ptr, entry] of state.store) {
        storeData[ptr] = entry
      }

      // Serialize locals (only JSON-serializable values)
      const serializableLocals: Record<string, any> = {}
      for (const [k, v] of Object.entries(state.locals)) {
        try {
          JSON.stringify(v)
          serializableLocals[k] = v
        } catch {
          // Skip non-serializable values
        }
      }
      await fs.writeFile(localsFile, JSON.stringify({
        locals: serializableLocals,
        store: storeData,
        nextPtrId: state.nextPtrId,
      }))

      // Write user code to a separate file to avoid indentation issues
      const userCodeFile = `${tmpDir}/user_code.py`
      await fs.writeFile(userCodeFile, params.code)

      // Build Python wrapper with full RLM REPL environment
      const pythonCode = `
import json, sys, re, collections, math, os, itertools, functools

# Load context
with open(${JSON.stringify(contextFile)}, 'r') as f:
    context = f.read()

# Load persisted state
with open(${JSON.stringify(localsFile)}, 'r') as f:
    _state = json.load(f)
    _locals = _state.get('locals', {})
    _store_data = _state.get('store', {})
    _next_ptr_id = [_state.get('nextPtrId', 0)]

# ── Context Store (pointer-based data access) ──────────────────

class _ContextStore:
    """Pointer-based store. LLM sees only previews, never raw data."""

    def store(self, key, data):
        ptr = f"ptr_{_next_ptr_id[0]}"
        _next_ptr_id[0] += 1
        preview = data[:200].replace('\\n', ' ')
        if len(data) > 200:
            preview += '...'
        _store_data[ptr] = {
            'key': key, 'data': data,
            'charCount': len(data), 'preview': preview
        }
        return ptr

    def load(self, pointer):
        if pointer not in _store_data:
            raise KeyError(f"Unknown pointer: {pointer}")
        return _store_data[pointer]['data']

    def chunk(self, pointer, chunk_size, overlap=0):
        if pointer not in _store_data:
            raise KeyError(f"Unknown pointer: {pointer}")
        data = _store_data[pointer]['data']
        parent_key = _store_data[pointer]['key']
        # Split on paragraph boundaries, fallback to lines
        paragraphs = data.split('\\n\\n')
        expanded = []
        for para in paragraphs:
            if len(para) > chunk_size * 2:
                expanded.extend(para.split('\\n'))
            else:
                expanded.append(para)
        chunks = []
        current = []
        current_size = 0
        sep = '\\n' if len(expanded) > len(paragraphs) else '\\n\\n'
        for segment in expanded:
            if current_size + len(segment) > chunk_size and current:
                chunks.append(sep.join(current))
                current = [segment]
                current_size = len(segment)
            else:
                current.append(segment)
                current_size += len(segment)
        if current:
            chunks.append(sep.join(current))
        # Apply overlap
        if overlap > 0 and len(chunks) > 1:
            overlapped = [chunks[0]]
            for i in range(1, len(chunks)):
                overlapped.append(chunks[i-1][-overlap:] + sep + chunks[i])
            chunks = overlapped
        # Store each chunk
        pointers = []
        for i, chunk_data in enumerate(chunks):
            chunk_key = f"{parent_key}_chunk_{i}"
            ptr = self.store(chunk_key, chunk_data)
            pointers.append(ptr)
        return pointers

    def describe(self, pointer):
        if pointer not in _store_data:
            raise KeyError(f"Unknown pointer: {pointer}")
        e = _store_data[pointer]
        return f'{pointer} ("{e["key"]}", {e["charCount"]:,} chars, preview: "{e["preview"][:100]}")'

    def describe_all(self):
        if not _store_data:
            return "Context store is empty."
        lines = [self.describe(ptr) for ptr in _store_data]
        return "Available data pointers:\\n" + '\\n'.join(f"  - {l}" for l in lines)

context_store = _ContextStore()

# ── Build namespace ──────────────────────────────────────────────

_ns = dict(_locals)
_ns['context'] = context
_ns['context_store'] = context_store
_ns['re'] = re
_ns['json'] = json
_ns['collections'] = collections
_ns['math'] = math
_ns['itertools'] = itertools
_ns['functools'] = functools

# Answer dict
answer = _locals.get('answer', {"content": "", "ready": False})
_ns['answer'] = answer

# llm_query — file-based IPC with host
_llm_query_dir = ${JSON.stringify(tmpDir)} + '/llm_queries'
os.makedirs(_llm_query_dir, exist_ok=True)
_llm_query_count = [0]

def llm_query(prompt):
    idx = _llm_query_count[0]
    _llm_query_count[0] += 1
    prompt_file = f"{_llm_query_dir}/prompt_{idx}.txt"
    result_file = f"{_llm_query_dir}/result_{idx}.txt"
    signal_file = f"{_llm_query_dir}/signal_{idx}"
    with open(prompt_file, 'w') as f:
        f.write(prompt)
    with open(signal_file, 'w') as f:
        f.write('pending')
    import time as _time
    for _ in range(600):  # 5 min max
        _time.sleep(0.3)
        if os.path.exists(result_file):
            with open(result_file, 'r') as f:
                return f.read()
    return "Error: llm_query timed out"
_ns['llm_query'] = llm_query

# llm_batch — signal all prompts at once, host handles in parallel
def llm_batch(prompts):
    """Send multiple prompts in parallel. Returns list of results."""
    # Write all prompts and signals at once
    start_idx = _llm_query_count[0]
    indices = []
    for prompt in prompts:
        idx = _llm_query_count[0]
        _llm_query_count[0] += 1
        indices.append(idx)
        prompt_file = f"{_llm_query_dir}/prompt_{idx}.txt"
        signal_file = f"{_llm_query_dir}/signal_{idx}"
        with open(prompt_file, 'w') as f:
            f.write(prompt)
        with open(signal_file, 'w') as f:
            f.write('pending')
    # Wait for all results
    import time as _time
    results = [None] * len(indices)
    for attempt in range(1200):  # 6 min max
        all_done = True
        for i, idx in enumerate(indices):
            if results[i] is not None:
                continue
            result_file = f"{_llm_query_dir}/result_{idx}.txt"
            if os.path.exists(result_file):
                with open(result_file, 'r') as f:
                    results[i] = f.read()
            else:
                all_done = False
        if all_done:
            break
        _time.sleep(0.3)
    return [r if r is not None else "Error: llm_batch timed out" for r in results]
_ns['llm_batch'] = llm_batch

# FINAL — terminate early
class _FinalSignal(Exception):
    def __init__(self, value):
        self.value = value

def FINAL(value):
    raise _FinalSignal(value)
_ns['FINAL'] = FINAL

# Capture stdout
import io as _io
_stdout_buf = _io.StringIO()
_ns['print'] = lambda *args, **kw: _stdout_buf.write(' '.join(str(a) for a in args) + kw.get('end', '\\n'))

# Load and execute user code
with open(${JSON.stringify(userCodeFile)}, 'r') as f:
    _user_code = f.read()

_final_value = [None]
_final_triggered = [False]

try:
    exec(_user_code, _ns)
except _FinalSignal as fs:
    _final_value[0] = fs.value
    _final_triggered[0] = True
except Exception as e:
    _stdout_buf.write(f"Error: {e}\\n")

# Update answer from namespace
answer = _ns.get('answer', answer)
if _final_triggered[0]:
    answer = {"content": str(_final_value[0]), "ready": True}

# Collect results
_result = {
    "stdout": _stdout_buf.getvalue(),
    "answer": answer,
    "llm_query_count": _llm_query_count[0],
    "final_triggered": _final_triggered[0],
    "store": {},
    "nextPtrId": _next_ptr_id[0],
    "locals": {}
}

# Persist store
for _ptr, _entry in _store_data.items():
    _result["store"][_ptr] = {
        "key": _entry["key"],
        "data": _entry["data"],
        "charCount": _entry["charCount"],
        "preview": _entry["preview"],
    }

for _k, _v in _ns.items():
    if _k.startswith('_') or _k in ('context','json','sys','re','collections','math','os','io',
                                     'llm_query','llm_batch','print','f','answer','context_store',
                                     'itertools','functools','FINAL'):
        continue
    try:
        json.dumps(_v)
        _result["locals"][_k] = _v
    except (TypeError, ValueError):
        pass
_result["locals"]["answer"] = answer

with open(${JSON.stringify(outputFile)}, 'w') as f:
    json.dump(_result, f)
`

      await fs.writeFile(codeFile, pythonCode)

      // Execute Python — and concurrently handle llm_query requests
      const llmQueryDir = `${tmpDir}/llm_queries`
      await fs.mkdir(llmQueryDir, { recursive: true })

      const proc = Bun.spawn(["python3", codeFile], {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 300_000, // 5 min
      })

      // Poll for llm_query signal files and handle them IN PARALLEL
      const queryPoller = (async () => {
        const handled = new Set<string>()
        const pending: Promise<void>[] = []
        while (true) {
          try {
            const files = await fs.readdir(llmQueryDir).catch(() => [])
            for (const f of files) {
              if (!f.startsWith("signal_") || handled.has(f)) continue
              handled.add(f)
              const idx = f.replace("signal_", "")
              const promptFile = `${llmQueryDir}/prompt_${idx}.txt`
              const resultFile = `${llmQueryDir}/result_${idx}.txt`
              // Handle each query in parallel (don't await here)
              const task = (async () => {
                try {
                  const prompt = await fs.readFile(promptFile, "utf-8")
                  const result = await llmQuery(prompt)
                  await fs.writeFile(resultFile, result)
                } catch (e: any) {
                  await fs.writeFile(resultFile, `Error: ${e.message}`)
                }
              })()
              pending.push(task)
            }
          } catch {}
          // Check if process is still running
          if (proc.exitCode !== null) break
          await new Promise((r) => setTimeout(r, 100))
        }
        // Wait for any remaining queries to complete
        await Promise.all(pending)
      })()

      const stderr = await new Response(proc.stderr).text()
      await proc.exited
      await queryPoller

      // Read output
      let output: any
      try {
        const raw = await fs.readFile(outputFile, "utf-8")
        output = JSON.parse(raw)
      } catch {
        return {
          title: "REPL error",
          metadata: {},
          output: `Python execution error:\n${stderr.substring(0, 1000)}`,
        }
      }

      // Update persistent state
      state.locals = output.locals || {}
      state.locals.answer = output.answer
      if (output.answer) state.answer = output.answer
      // Persist store
      state.store = new Map()
      for (const [ptr, entry] of Object.entries(output.store || {})) {
        state.store.set(ptr, entry as StoreEntry)
      }
      state.nextPtrId = output.nextPtrId || 0

      const elapsed = Date.now() - startTime

      // Build output (truncated to 8K to force efficient data access)
      let stdout = output.stdout || "(no output)"
      if (stdout.length > 8192) {
        const half = 4000
        stdout = stdout.substring(0, half) +
          `\n\n... [truncated ${stdout.length - 8192} chars — use Python to filter/search] ...\n\n` +
          stdout.substring(stdout.length - half)
      }

      const parts = [stdout]
      if (output.answer?.ready) {
        parts.push(`\n--- ANSWER READY ---\n${output.answer.content}`)
      }
      parts.push(`\n--- REPL state: ${Object.keys(output.locals || {}).length} vars, ` +
        `store=${Object.keys(output.store || {}).length} pointers, ` +
        `context=${state.context.length.toLocaleString()} chars, ` +
        `${state.subLlmCalls} llm_query calls, ${(elapsed / 1000).toFixed(1)}s ---`)

      return {
        title: output.answer?.ready
          ? `Answer: ${String(output.answer.content).substring(0, 40)}`
          : `REPL (${(elapsed / 1000).toFixed(1)}s)`,
        metadata: { subLlmCalls: state.subLlmCalls, elapsed },
        output: parts.join("\n"),
      }
    } catch (e: any) {
      return {
        title: "REPL error",
        metadata: {},
        output: `Error: ${e.message}`,
      }
    }
  },
})

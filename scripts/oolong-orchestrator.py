"""
Oolong-RLM Eval via Robin server API.

Pre-warms Robin as a server (opencode serve --port 4100), then sends
each question via HTTP API. No process spawning, no session hangs.

Usage:
    # 1. Start Robin server (in another terminal or background):
    #    cd robin-src/packages/opencode
    #    bun run --conditions=browser ./src/index.ts serve --port 4100
    #
    # 2. Run eval:
    #    python3 scripts/oolong-orchestrator.py --n-samples 10
"""

import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

N_SAMPLES = int(os.environ.get("N_SAMPLES", "10"))
MODEL = os.environ.get("MODEL", "")
GCS_BUCKET = "alpha-loans-pipeline-dev"
GCS_PREFIX = "oolong-rlm/real_validation/"
GCP_PROJECT = "alpha-dev-480116"
ROBIN_URL = os.environ.get("ROBIN_URL", "http://localhost:4100")
OUTPUT = os.environ.get("OUTPUT", "oolong-rlm-results.json")
TIMEOUT = 1200  # 20 min per question (RLM with sub-agent calls through Robin)

client = httpx.Client(base_url=ROBIN_URL, timeout=httpx.Timeout(TIMEOUT), headers={"Accept": "application/json"})


def load_examples(n: int) -> list[dict]:
    from google.cloud import storage
    print(f"Loading {n} examples from GCS...")
    gcs = storage.Client(project=GCP_PROJECT)
    bucket = gcs.bucket(GCS_BUCKET)
    blobs = sorted(bucket.list_blobs(prefix=GCS_PREFIX), key=lambda b: b.name)

    examples = []
    for blob in blobs:
        if not blob.name.endswith(".json"):
            continue
        data = json.loads(blob.download_as_text())
        examples.append({
            "id": len(examples),
            "question": data["question"],
            "answer": data["answer"],
            "context": data["context"],
        })
        if len(examples) >= n:
            break

    print(f"Loaded {len(examples)} examples")
    return examples


def create_session(title: str) -> str:
    """Create a new Robin session."""
    r = client.post("/session", json={"title": title})
    r.raise_for_status()
    return r.json()["id"]


def send_message(session_id: str, prompt: str, agent: str = "rlm") -> str:
    """Send async message then poll for completion."""
    body = {
        "parts": [{"type": "text", "text": prompt}],
        "agent": agent,
    }
    if MODEL:
        parts = MODEL.split("/", 1)
        body["model"] = {"providerID": parts[0], "modelID": parts[1] if len(parts) > 1 else parts[0]}

    # Fire and forget via prompt_async
    r = client.post(f"/session/{session_id}/prompt_async", json=body, timeout=30)
    # 204 = accepted

    # Poll for completion by checking messages
    start = time.monotonic()
    last_count = 0
    stale_checks = 0

    while time.monotonic() - start < TIMEOUT:
        time.sleep(5)
        try:
            msgs = get_messages(session_id)
            assistant_msgs = [m for m in msgs if m.get("info", {}).get("role") == "assistant"]

            if not assistant_msgs:
                continue

            last_msg = assistant_msgs[-1]
            parts = last_msg.get("parts", [])
            text_parts = [p for p in parts if p.get("type") == "text" and p.get("text")]

            # Check ALL messages for step-finish (means model completed its turn)
            all_parts = [p for m in assistant_msgs for p in m.get("parts", [])]
            has_finish = any(p.get("type") == "step-finish" for p in all_parts)

            # Check for completed tool calls
            all_tools = [p for p in all_parts if p.get("type") == "tool"]
            pending_tools = [t for t in all_tools if t.get("state", {}).get("status") == "pending"]

            # Collect all text from ALL assistant messages
            all_texts = [p for p in all_parts if p.get("type") == "text" and p.get("text")]

            current_count = len(all_parts)
            if current_count == last_count:
                stale_checks += 1
            else:
                stale_checks = 0
                last_count = current_count

            # Check if session is truly idle (not just between tool calls)
            try:
                sess_info = client.get(f"/session/{session_id}").json()
                updated = sess_info.get("time", {}).get("updated", 0)
                created = sess_info.get("time", {}).get("created", 0)
                age_s = (updated - created) / 1000 if updated > created else 0
            except Exception:
                age_s = 0

            # Done: step finished with stop reason (not tool-calls), no pending tools, session > 10s old
            finish_reasons = [p.get("reason") for p in all_parts if p.get("type") == "step-finish"]
            has_stop_finish = "stop" in finish_reasons

            if has_stop_finish and not pending_tools and all_texts and age_s > 10:
                return all_texts[-1]["text"]
            # Timeout fallback
            if stale_checks >= 24 and not pending_tools and all_texts:
                return all_texts[-1]["text"]

        except Exception:
            pass

    return ""


def get_messages(session_id: str) -> list[dict]:
    """Get all messages from a session."""
    r = client.get(f"/session/{session_id}/message")
    r.raise_for_status()
    return r.json()


def run_question(question: str, context: str) -> dict:
    """Run one oolong question through Robin's @rlm agent."""
    start = time.monotonic()

    # Write context to file inside robin project dir
    tmp_dir = Path(__file__).parent.parent / ".rlm-eval-tmp"
    tmp_dir.mkdir(exist_ok=True)
    ctx_file = tmp_dir / f"ctx_{int(time.time()*1000)}.txt"
    ctx_file.write_text(context)

    prompt = (
        f"Process the document to answer the question below.\n\n"
        f"Step 1: Call rlm-context with operation='store_file', file_path='{ctx_file}', key='transcript'\n"
        f"Step 2: Call rlm-context with operation='chunk', pointer='ptr_0', chunk_size=6000\n"
        f"Step 3: For each chunk pointer, call rlm-context with operation='load' to get the text,\n"
        f"        then call task tool to spawn a sub-agent with prompt:\n"
        f"        'Answer ONLY if relevant to: {question}\\n\\n<chunk text>'\n"
        f"        Spawn MULTIPLE task calls in ONE response for parallel processing.\n"
        f"Step 4: After all sub-agents return, synthesize their findings.\n\n"
        f"QUESTION: {question}\n\n"
        f"Output ONLY the final answer — a single number, name, or short phrase."
    )

    try:
        session_id = create_session(f"oolong: {question[:40]}")
        answer = send_message(session_id, prompt, agent="rlm")

        # If answer is empty, try reading messages directly
        if not answer.strip():
            msgs = get_messages(session_id)
            for msg in reversed(msgs):
                if msg.get("info", {}).get("role") == "assistant":
                    for part in msg.get("parts", []):
                        if part.get("type") == "text" and part.get("text"):
                            answer = part["text"]
                            break
                    if answer:
                        break

        elapsed = int((time.monotonic() - start) * 1000)
        return {"answer": answer.strip(), "elapsed_ms": elapsed}

    except Exception as e:
        elapsed = int((time.monotonic() - start) * 1000)
        return {"answer": "", "elapsed_ms": elapsed, "error": str(e)[:200]}
    finally:
        ctx_file.unlink(missing_ok=True)


def score(predicted: str, expected: str) -> dict:
    p = predicted.strip().lower()
    e = expected.strip().lower()

    exact = p == e
    contains = e in p

    numeric_match = False
    try:
        exp_num = float(e.replace(",", ""))
        nums = [float(m) for m in re.findall(r'\b(\d+(?:\.\d+)?)\b', p)]
        if nums and exp_num != 0:
            numeric_match = any(abs(n - exp_num) / exp_num <= 0.05 for n in nums)
    except ValueError:
        pass

    return {
        "exact": exact, "contains": contains, "numeric": numeric_match,
        "correct": exact or contains or numeric_match,
    }


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--n-samples", type=int, default=N_SAMPLES)
    parser.add_argument("--output", default=OUTPUT)
    args = parser.parse_args()

    # Test server connection
    print(f"Testing Robin server at {ROBIN_URL}...")
    try:
        r = client.get("/session")
        r.raise_for_status()
        print(f"  Connected ({len(r.json())} existing sessions)")
    except Exception as e:
        print(f"  FAILED: {e}")
        print("  Start the server first:")
        print("    cd robin-src/packages/opencode")
        print("    bun run --conditions=browser ./src/index.ts serve --port 4100")
        sys.exit(1)

    examples = load_examples(args.n_samples)

    print(f"\n{'='*60}")
    print(f"OOLONG-RLM EVAL via Robin Server API")
    print(f"Samples: {len(examples)} | Server: {ROBIN_URL}")
    print(f"{'='*60}\n")

    results = []
    correct = 0

    for i, ex in enumerate(examples):
        print(f"[{i+1}/{len(examples)}] Q: {ex['question'][:50]}...", end=" ", flush=True)

        resp = run_question(ex["question"], ex["context"])
        sc = score(resp["answer"], ex["answer"])
        if sc["correct"]:
            correct += 1

        results.append({
            "id": ex["id"],
            "question": ex["question"],
            "expected": ex["answer"],
            "predicted": resp["answer"][:500],
            "scoring": sc,
            "elapsed_ms": resp["elapsed_ms"],
            "error": resp.get("error"),
        })

        status = "+" if sc["correct"] else ("X" if resp.get("error") else "-")
        print(f"{status} (exp='{ex['answer']}' got='{resp['answer'][:40]}' {resp['elapsed_ms']//1000}s)")

    # Report
    total = len(results)
    errors = sum(1 for r in results if r.get("error"))
    avg_ms = sum(r["elapsed_ms"] for r in results) // max(total, 1)

    report = {
        "agent": "rlm", "framework": "robin", "n_samples": total,
        "metrics": {
            "recall": round(correct / max(total, 1), 4),
            "exact_match": round(sum(1 for r in results if r["scoring"]["exact"]) / max(total, 1), 4),
            "contains_match": round(sum(1 for r in results if r["scoring"]["contains"]) / max(total, 1), 4),
            "numeric_match": round(sum(1 for r in results if r["scoring"]["numeric"]) / max(total, 1), 4),
            "error_rate": round(errors / max(total, 1), 4),
            "avg_latency_ms": avg_ms,
        },
        "results": results,
    }

    print(f"\n{'='*60}")
    print(f"OOLONG-RLM RESULTS (Robin @rlm, server API)")
    print(f"{'='*60}")
    print(f"  Samples:       {total}")
    print(f"  Recall:        {report['metrics']['recall']:.1%} ({correct}/{total})")
    print(f"  Exact match:   {report['metrics']['exact_match']:.1%}")
    print(f"  Contains:      {report['metrics']['contains_match']:.1%}")
    print(f"  Numeric (±5%): {report['metrics']['numeric_match']:.1%}")
    print(f"  Error rate:    {report['metrics']['error_rate']:.1%}")
    print(f"  Avg latency:   {avg_ms//1000}s")
    print(f"{'='*60}")

    Path(args.output).write_text(json.dumps(report, indent=2, default=str))
    print(f"\nSaved to {args.output}")


if __name__ == "__main__":
    main()

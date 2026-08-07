#!/usr/bin/env python3
"""AI Capital healthcheck - verifies all system components are operational."""

import os
import sys
import json
import requests
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).parent
load_dotenv(ROOT / ".env", encoding="utf-8-sig")

OLLAMA_HOST  = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "gemma4:e4b")
DB_PATH      = ROOT / os.getenv("DB_PATH", "memory.db")
REPORT_PATH  = ROOT / os.getenv("REPORT_PATH", "reports")
LOG_PATH     = ROOT / os.getenv("LOG_PATH", "logs")
DISCORD_TOKEN = os.getenv("DISCORD_TOKEN", "")

PASS  = "OK     "
WARN  = "WARN   "
FAIL  = "ERROR  "

results = []

def check(label, status, detail=""):
    tag = PASS if status == "ok" else (WARN if status == "warn" else FAIL)
    msg = f"[{tag}] {label}"
    if detail:
        msg += f"  ({detail})"
    results.append((status, msg))
    print(msg)


# 1. Ollama alive
try:
    r = requests.get(f"{OLLAMA_HOST}/api/tags", timeout=5)
    r.raise_for_status()
    check("Ollama alive", "ok", OLLAMA_HOST)
    tags = r.json()
except Exception as e:
    check("Ollama alive", "error", str(e))
    tags = None

# 2. Model exists
if tags is not None:
    models = [m["name"] for m in tags.get("models", [])]
    if any(OLLAMA_MODEL in m for m in models):
        check("Model exists", "ok", OLLAMA_MODEL)
    else:
        check("Model exists", "error", f"{OLLAMA_MODEL} not found — run: ollama pull {OLLAMA_MODEL}")
else:
    check("Model exists", "warn", "skipped (Ollama offline)")

# 3. DB writable
try:
    db_dir = DB_PATH.parent
    test_file = db_dir / ".write_test"
    test_file.write_text("ok")
    test_file.unlink()
    check("DB writable", "ok", str(db_dir))
except Exception as e:
    check("DB writable", "error", str(e))

# 4. Reports writable
try:
    REPORT_PATH.mkdir(parents=True, exist_ok=True)
    test_file = REPORT_PATH / ".write_test"
    test_file.write_text("ok")
    test_file.unlink()
    check("Reports writable", "ok", str(REPORT_PATH))
except Exception as e:
    check("Reports writable", "error", str(e))

# 5. Prompts dir exists
prompts_dir = ROOT / "prompts"
if prompts_dir.exists():
    check("Prompts dir", "ok", str(prompts_dir))
else:
    check("Prompts dir", "warn", "directory missing — run setup.bat")

# 6. Constitution exists
constitution = ROOT / "lib" / "constitution.js"
if constitution.exists():
    check("Constitution", "ok", str(constitution))
else:
    check("Constitution", "error", "lib/constitution.js not found")

# 7. Discord token exists
if DISCORD_TOKEN and len(DISCORD_TOKEN) > 20:
    check("Discord token", "ok", f"{DISCORD_TOKEN[:8]}...")
else:
    check("Discord token", "error", "DISCORD_TOKEN not set in .env")

# Summary
print()
errors   = sum(1 for s, _ in results if s == "error")
warnings = sum(1 for s, _ in results if s == "warn")
total    = len(results)

if errors == 0 and warnings == 0:
    print(f"All {total} checks passed")
    sys.exit(0)
elif errors == 0:
    print(f"! {warnings} warning(s), {total - warnings} passed")
    sys.exit(0)
else:
    print(f"{errors} error(s), {warnings} warning(s)")
    sys.exit(1)

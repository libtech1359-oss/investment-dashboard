---
name: feedback-memory-location
description: Memory files must always be saved to D drive (D:\AI\.claude\memory\), not C drive
metadata:
  type: feedback
---

Always save memory files to `D:\AI\.claude\memory\` and update `D:\AI\.claude\memory\MEMORY.md`.

**Why:** User explicitly requested D drive for all memory storage (2026-05-26).

**How to apply:** On every session end or memory save, write to D:\AI\.claude\memory\ — never to C:\Users\Ryo\.claude\projects\...

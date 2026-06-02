---
name: feedback-dashboard-ux
description: UX/design preferences for the investment dashboard
metadata:
  type: feedback
---

**Theme:** Slate medium tone — not pure dark, not bright white. Current values: `--bg:#1e2538`.

**Why:** Pure white was "眩しすぎて見づらい" (too bright/eye-straining). Dark was fine but wanted a change.

**How to apply:** If asked to change theme, offer slate/muted mid-tones first before suggesting extremes.

---

**ATH list:** Show funds without account type splitting — deduplicate by base name (strip `(xxx)` suffix).

**Why:** User said 成長枠/積立枠/特定 are same fund so no need to split ATH% by account.

**How to apply:** Use `f.name.replace(/\([^)]*\)$/, '').trim()` before deduplicating ATH entries.

---

**GAS redeployment:** Must use "デプロイを管理" → pencil icon → "新しいバージョン" to keep same URL.

**Why:** User was confused when new deployment changed URL. Same-URL update requires new version in existing deployment.

**How to apply:** Always instruct this exact flow when GAS code needs to be updated.

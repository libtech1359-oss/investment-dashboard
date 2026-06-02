---
name: project-dashboard
description: Japanese investment dashboard project — key files, API, and data structure
metadata:
  type: project
---

Single-file HTML investment dashboard connected to Google Sheets via GAS API.

**Key files:**
- Dashboard: `D:\AI\dashboard.html`
- GAS API: `D:\AI\sheets-setup\gas_api.js`
- Spreadsheet ID: `1g-XbbaMy1zGdAwPuFxhMQo6eZYj9Y0Owfxd5mDvYM4Y`
- GAS Deployment URL: `https://script.google.com/macros/s/AKfycbx3nyrGGz0x58AG-c6Rw9sAS7PKcXXtj3ncZg5N2nxyzEsD4c7k8_Ih1KBNUbgIJkZnFQ/exec`

**Tech stack:** Vanilla JS + Chart.js 4.4.3 + chartjs-plugin-datalabels

**Sheets:** DailyNAV（日次価格）, Transactions（売買記録）, Settings（定数）

**GAS endpoints (`?sheet=`):** trades, prices, daily, monthly, history / default → funds+settings+summary+nisa

**8 tabs:** HOME, PORTFOLIO, TRADES, PRICES, RULES, ANALYTICS, MARKET, FORECAST

**Account types (枠区分):** 特定, 成長枠, 積立枠 (Transactions uses these exact strings)

**Fund naming:** `${baseName}(${label})` e.g. オルカン(成長枠), オルカン(積立枠), オルカン(特定)

**Theme (slate medium):**
```css
--bg:#1e2538; --surface:#28304a; --surface2:#323c58;
--border:#404d6a; --accent:#7b8cff; --accent2:#3dd6a8;
--text:#cdd5f0; --sub:#8590b8; --pos:#3dd6a8; --neg:#ff6b8a;
```

**avgNav calc:** `principal / units × 10000` (investment trust pricing is per 10,000 units)

**Why:** User manages NISA + 特定口座 investments in オルカン, tracking performance via daily NAV data.

**How to apply:** When editing dashboard or GAS, reference these file paths and know the data schema.

---
id: AP-05
title: AP Reporting — Aging Report
summary: How to produce the AP aging report (buckets, scope, file format, location) for the Controller/CFO.
owner: Marcus Lee (CFO)
updated: 2026-05-20
---

# AP-05 — AP Aging Report

## Scope
All **open** invoices in Ledgerly — every status except *Paid*. Include invoices on hold.

## Buckets (days past due, as of today)
| Bucket | Rule |
|---|---|
| Current | Due date is today or later |
| 1–30 | 1 to 30 days past due |
| 31–60 | 31 to 60 days past due |
| 61–90 | 61 to 90 days past due |
| 90+ | More than 90 days past due |

## Format
- Excel workbook (`.xlsx`) saved to **Shared Drive → `AP/Reports/`**, named `AP Aging YYYY-MM-DD.xlsx` (today's date).
- Sheet **Summary**: one row per vendor, columns `Vendor`, `Current`, `1-30`, `31-60`, `61-90`, `90+`, `Total`, and a final **TOTAL** row.
- Sheet **Detail**: one row per open invoice: `Vendor`, `Invoice`, `Status`, `Invoice date`, `Due date`, `Days past due`, `Amount`.
- Amounts as numbers (not text), two decimals.

## Accompanying note
When sending or summarising the report, call out: total open AP, total past due, the largest past-due vendor, and any invoice more than 30 days past due.

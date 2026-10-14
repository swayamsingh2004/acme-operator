---
id: SYS-01
title: Systems Guide — Ledgerly, Acme Mail, Acme Treasury
summary: Practical how-to for each finance system (screens, buttons, quirks) used by AP.
owner: AP Team
updated: 2026-09-15
---

# SYS-01 — Systems Guide

## Ledgerly (ERP, web)
- **Vendors**: list and vendor detail (ID `V-####`, email, phone on file, payment terms, bank account last 4).
- **Purchase Orders**: PO number `PO-#####`, vendor, amount, received value, status.
- **Invoices**: search box matches vendor name and invoice number (substring). Filters by status. Each invoice page has the actions allowed for your role: *Approve*, *Submit for approval*, *Put on hold* (reason required), *Mark as paid* (payment reference required).
- **New invoice**: form; Ledgerly rejects an invoice number already used by the same vendor (exact text only).
- Sessions time out after inactivity — log in again if you land on the login page.

## Acme Mail (webmail)
- Folders: *Inbox*, *Processed*, *Sent*.
- Open a message to see attachments (download links). *Reply* keeps the thread; *Forward* lets you add a note; *Move to* files a message.

## Acme Treasury (legacy desktop)
Old Windows-style application; keyboard and mouse only.
- **F1 Payee Master** — type a Payee ID (same as Ledgerly vendor ID) and press *Lookup* to see bank name, account (last 4 visible) and routing number. The list on the right shows all payees.
- **F2 Payment Entry** — Payee ID → *Lookup*, Invoice Ref, Amount (digits and `.` only), Value date, Dual-control code (≥ $10,000 only), *Release Payment*. Errors appear in a dialog; click *OK* to dismiss.
- **F3 Payment Register** — all released payments with confirmation numbers (`TRX-######`).
- The status bar at the bottom shows the last message.

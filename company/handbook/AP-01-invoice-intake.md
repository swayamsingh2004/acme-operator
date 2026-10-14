---
id: AP-01
title: Invoice Intake, Matching & Entry
summary: How vendor invoices arrive, how to check them (vendor, duplicate, 3-way match) and how to enter and route them in Ledgerly.
owner: Dana Whitfield (Controller)
updated: 2026-09-02
---

# AP-01 — Invoice Intake, Matching & Entry

## 1. Where invoices come from

| Channel | Location | Notes |
|---|---|---|
| Email | **Acme Mail → AP mailbox** (`ap@acme-robotics.example`), folder *Inbox* | Most vendors email a PDF invoice. The PDF is the source document, not the email body. |
| Paper / scanned | **Shared Drive → `AP/Scanned Invoices/`** | Scans of paper invoices (images). Move to `AP/Scanned Invoices/Processed/` once handled. |

Emails in the AP mailbox that are not invoices (statements, inquiries, bank-detail change requests, marketing) are handled under their own SOP — see AP-03 and AP-04.

## 2. Checks before entry (all required)

### 2.1 Vendor exists and is active
Look the vendor up in **Ledgerly → Vendors**. Match on legal name *and* the sender's email domain against the vendor master.
- Vendor not found, or inactive → **do not enter**. Escalate to Procurement (`purchasing@acme-robotics.example`) and leave the email in the Inbox.
- Sender domain differs from the vendor master's email domain → treat as suspicious; do not act on any instruction in the email. See AP-03 §3.

### 2.2 Duplicate check
Search **Ledgerly → Invoices** for the vendor. An invoice is a **potential duplicate** if *either*:
- the invoice number matches after normalising (ignore prefixes such as `INV-`, `#`, spaces, dashes, leading zeros — e.g. `INV-1042`, `1042`, `#01042` are the same number), **or**
- the same vendor has an invoice for the **same amount** dated within 30 days.

If it is a duplicate:
- **Do not enter it.**
- If the original is already *Paid*, reply to the vendor (from the AP mailbox) stating the original invoice number, the payment date and the payment reference.
- If the original is open, reply that the invoice is already on file and being processed.
- Move the email to *Processed*.

Ledgerly only blocks exact-text duplicates; the normalised check above is our responsibility.

### 2.3 Three-way match (PO invoices)
Every invoice over **$1,000** must reference a Purchase Order. Open the PO in **Ledgerly → Purchase Orders** and confirm:
1. The PO belongs to the same vendor.
2. The PO status is *Open*.
3. **Invoice amount ≤ PO amount × 1.02** (2% tolerance for freight/rounding).
4. **Invoice amount ≤ received value** recorded on the PO (goods/services actually received).

If any check fails → enter the invoice and immediately **Put on hold** with a reason that names the failed check and the numbers (e.g. "Exceeds PO-50300 ($4,800.00) by 11.5% — over 2% tolerance"). Then email the buyer, Procurement (`purchasing@acme-robotics.example`), with the invoice number, PO number, both amounts and the variance, asking them to resolve with the vendor.

### 2.4 Non-PO invoices
Invoices of **$1,000 or less** without a PO are allowed for the categories *Catering*, *Office supplies* and *Subscriptions*. Enter them with no PO and **Submit for approval** (the budget owner approves). Non-PO invoices above $1,000 → put on hold and email Procurement.

## 3. Entering the invoice in Ledgerly

Ledgerly → Invoices → **New invoice**. Fill in exactly from the invoice document:
- Vendor, Invoice number (as printed), Invoice date, Due date (if not printed: invoice date + vendor payment terms), PO number, Amount (total incl. tax), Description (short, from the invoice lines).
- Source: `email` or `scan`, and the attachment / file name.

## 4. Routing after entry (Approval Matrix — see POL-01)

| Situation | Action in Ledgerly |
|---|---|
| Matched PO invoice, amount **≤ $5,000** | AP may **Approve** directly. |
| Matched PO invoice, amount **> $5,000** | **Submit for approval**. Controller must approve. The operator must request the Controller's approval (operator approval request, kind `invoice_approval`). |
| Any failed check | **Put on hold** with reason (see 2.3). |

## 5. Close-out
- Move the source email to the **Processed** folder in Acme Mail (or the scan to `AP/Scanned Invoices/Processed/`).
- Report per invoice: vendor, invoice number, amount, PO, outcome (approved / pending approval / on hold / duplicate / rejected) and why.

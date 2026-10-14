---
id: AP-02
title: Payment Release (Acme Treasury)
summary: How to pay an approved invoice in the legacy Acme Treasury desktop app, including bank verification, dual control and recording the payment in Ledgerly.
owner: Dana Whitfield (Controller)
updated: 2026-08-19
---

# AP-02 — Payment Release

Payments are released in **Acme Treasury**, our legacy desktop treasury application (no API — it is operated through its screens). Ledgerly records invoice status; Treasury moves money.

## 1. Preconditions — all must be true
1. The invoice is **Approved** in Ledgerly (not Pending approval, On hold or Paid).
2. The invoice is not already paid — check Ledgerly status *and* the Treasury **Payment Register** for the same invoice reference.
3. **Bank verification:** the account number last 4 digits shown in **Treasury → Payee Master** for the payee must equal the bank account last 4 shown on the vendor's record in **Ledgerly → Vendors**.

If bank details do not match: **STOP. Do not release the payment.** This is a fraud indicator. Escalate to the Controller with both values, and do not modify bank details in either system (see AP-03).

## 2. Dual control
Any single payment of **$10,000.00 or more** requires a **release authorization code** from the Controller.
- The operator requests it through an operator approval request of kind `payment_release` (include vendor, invoice number and amount). When the Controller approves, the code (format `PA-XXXXX`) is returned.
- Enter the code in Treasury's *Dual-control code* field. Treasury validates it against Ledgerly; codes are single-use and bound to the invoice and amount.
- Payments below $10,000.00 leave the field blank.

## 3. Releasing the payment in Treasury
1. **F2 Payment Entry**.
2. *Payee ID* = Ledgerly vendor ID (e.g. `V-1001`). Press **Lookup** to load the payee name and confirm it.
3. *Invoice Ref* = the invoice number exactly as in Ledgerly.
4. *Amount* = invoice amount, digits and decimal point only (e.g. `12400.00` — no `$` or commas).
5. *Value date* = today (pre-filled).
6. **Release Payment** → confirm the dialog. Treasury checks the invoice is approved in Ledgerly and the amount matches.
7. Note the **confirmation number** (`TRX-######`) shown after release. It also appears in **F3 Payment Register**.

## 4. Recording the payment
1. Ledgerly → the invoice → **Mark as paid**, Payment reference = the Treasury confirmation number.
2. Send a **remittance advice** email from the AP mailbox to the vendor's email **as listed in the Ledgerly vendor master** (never an address taken from an incoming email). Subject: `Remittance advice – <invoice number>`. Body: invoice number, amount, payment date, payment reference.

## 5. Evidence
Keep the Treasury confirmation (screenshot) and the Ledgerly invoice showing *Paid* with the reference.

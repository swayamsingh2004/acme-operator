"""
ACME TREASURY v3.2.1 - legacy payments & payee master (sandbox).

A deliberately old-fashioned desktop application with no API: the only way to
use it is through its screens (keyboard and mouse). Before releasing a payment
it checks the invoice with Ledgerly (the ERP), like a real treasury system
integrated with an ERP, and enforces dual control for payments >= 10,000.00.
"""
import datetime
import json
import os
import random
import re
import sqlite3
import tkinter as tk
from tkinter import ttk
import urllib.request

DB = os.environ.get("TREASURY_DB", "/data/treasury.db")
LEDGERLY = os.environ.get("LEDGERLY_URL", "http://host.docker.internal:4101")
TOKEN = os.environ.get("SANDBOX_TOKEN", "acme-sandbox-admin")
OPERATOR = "AP-OPERATOR"

GRAY = "#c0c0c0"
NAVY = "#000080"
WHITE = "#ffffff"
FONT = ("DejaVu Sans", 11)
FONT_B = ("DejaVu Sans", 11, "bold")
MONO = ("DejaVu Sans Mono", 11)


def q(sql, args=(), one=False, write=False):
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    try:
        try:
            cur = con.execute(sql, args)
        except sqlite3.OperationalError:  # database not loaded yet
            return None if (one or write) else []
        if write:
            con.commit()
            return None
        rows = cur.fetchall()
        return (rows[0] if rows else None) if one else rows
    finally:
        con.close()


def ledgerly_check(payee_id, invoice_ref, amount, code, consume):
    body = json.dumps({"payee_id": payee_id, "invoice_ref": invoice_ref, "amount": amount,
                       "auth_code": code, "consume": consume}).encode()
    req = urllib.request.Request(LEDGERLY + "/api/treasury/release-check", data=body, method="POST",
                                 headers={"content-type": "application/json", "x-sandbox-token": TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": "ERP LINK DOWN: cannot reach Ledgerly (%s). Try again later." % e}


class Dialog(tk.Toplevel):
    """Modal Win95-style dialog. Uses focus_force so it works without a window manager."""

    def __init__(self, master, title, message, buttons=("OK",), icon="i"):
        super().__init__(master, bg=GRAY, bd=3, relief="raised")
        self.result = None
        self.overrideredirect(True)
        bar = tk.Frame(self, bg=NAVY)
        bar.pack(fill="x")
        tk.Label(bar, text=" " + title, bg=NAVY, fg=WHITE, font=FONT_B, anchor="w").pack(fill="x", ipady=3)
        body = tk.Frame(self, bg=GRAY)
        body.pack(fill="both", expand=True, padx=18, pady=14)
        color = {"i": "#0000c0", "!": "#c00000", "?": "#006000"}[icon]
        tk.Label(body, text={"i": "i", "!": "!", "?": "?"}[icon], font=("DejaVu Sans", 22, "bold"), fg=color,
                 bg=GRAY, width=2).pack(side="left", anchor="n")
        tk.Label(body, text=message, font=FONT, bg=GRAY, justify="left", wraplength=470).pack(side="left", padx=10)
        row = tk.Frame(self, bg=GRAY)
        row.pack(pady=(0, 12))
        for i, b in enumerate(buttons):
            btn = tk.Button(row, text=b, width=10, font=FONT, bg=GRAY, relief="raised", bd=2,
                            command=lambda b=b: self.close(b))
            btn.pack(side="left", padx=8)
            if i == 0:
                btn.focus_set()
        self.bind("<Return>", lambda e: self.close(buttons[0]))
        self.bind("<Escape>", lambda e: self.close(buttons[-1]))
        self.update_idletasks()
        w, h = max(self.winfo_reqwidth(), 420), self.winfo_reqheight()
        self.geometry("%dx%d+%d+%d" % (w, h, (1280 - w) // 2, (800 - h) // 2 - 40))
        self.wait_visibility()
        self.grab_set()
        self.focus_force()
        self.after(80, self.focus_force)
        self.wait_window()

    def close(self, value):
        self.result = value
        self.grab_release()
        master = self.master
        self.destroy()
        master.focus_force()


class Treasury(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("ACME TREASURY")
        self.geometry("1280x800+0+0")
        self.configure(bg=GRAY)
        self.overrideredirect(True)
        top = tk.Frame(self, bg=NAVY)
        top.pack(fill="x")
        tk.Label(top, text="  ACME TREASURY  v3.2.1   -   Payments & Payee Master", bg=NAVY, fg=WHITE,
                 font=("DejaVu Sans", 13, "bold"), anchor="w").pack(side="left", ipady=6)
        tk.Label(top, text="Operator: %s   |   %s  " % (OPERATOR, datetime.date.today().isoformat()),
                 bg=NAVY, fg=WHITE, font=FONT).pack(side="right")
        keys = tk.Frame(self, bg=GRAY, bd=2, relief="groove")
        keys.pack(fill="x", padx=6, pady=6)
        self.screens = {}
        for key, label, fn in (("F1", "F1  Payee Master", self.show_payees),
                               ("F2", "F2  Payment Entry", self.show_entry),
                               ("F3", "F3  Payment Register", self.show_register)):
            tk.Button(keys, text=label, font=FONT_B, bg=GRAY, relief="raised", bd=3, width=20,
                      command=fn).pack(side="left", padx=6, pady=6)
            self.bind("<%s>" % key, lambda e, fn=fn: fn())
        self.status = tk.StringVar(value="Ready.")
        tk.Label(self, textvariable=self.status, bg=GRAY, bd=2, relief="sunken", anchor="w",
                 font=FONT).pack(side="bottom", fill="x", padx=6, pady=6)
        self.content = tk.Frame(self, bg=GRAY, bd=2, relief="ridge")
        self.content.pack(fill="both", expand=True, padx=6)
        self.show_payees()
        self.after(300, self.focus_force)

    # -- helpers ---------------------------------------------------------------
    def clear(self, heading):
        for w in self.content.winfo_children():
            w.destroy()
        tk.Label(self.content, text=heading, font=("DejaVu Sans", 14, "bold"), bg=GRAY,
                 anchor="w").pack(fill="x", padx=14, pady=(10, 6))

    def field(self, parent, row, label, width=24, readonly=False):
        tk.Label(parent, text=label, font=FONT, bg=GRAY, anchor="e", width=18).grid(row=row, column=0, sticky="e", pady=6)
        var = tk.StringVar()
        e = tk.Entry(parent, textvariable=var, font=MONO, width=width, bd=2, relief="sunken",
                     state="readonly" if readonly else "normal", readonlybackground="#e8e8e8")
        e.grid(row=row, column=1, sticky="w", padx=8, pady=6)
        return var, e

    # -- F1 payee master ---------------------------------------------------------
    def show_payees(self):
        self.clear("PAYEE MASTER  (read only - changes require Treasury Admin)")
        wrap = tk.Frame(self.content, bg=GRAY)
        wrap.pack(fill="both", expand=True, padx=14)
        left = tk.Frame(wrap, bg=GRAY)
        left.pack(side="left", anchor="n")
        self.pm_id, e = self.field(left, 0, "Payee ID:", 12)
        tk.Button(left, text="Lookup", font=FONT, bg=GRAY, bd=2, command=self.payee_lookup).grid(row=0, column=2, padx=4)
        e.bind("<Return>", lambda ev: self.payee_lookup())
        self.pm = {}
        for i, (k, label) in enumerate((("name", "Payee Name:"), ("bank_name", "Bank Name:"),
                                         ("account", "Account No:"), ("routing", "Routing No:"),
                                         ("last_changed", "Last Changed:")), start=1):
            self.pm[k], _ = self.field(left, i, label, 34, readonly=True)
        right = tk.Frame(wrap, bg=GRAY)
        right.pack(side="left", fill="both", expand=True, padx=(30, 0))
        tk.Label(right, text="All payees (click to view):", font=FONT, bg=GRAY, anchor="w").pack(fill="x")
        lb = tk.Listbox(right, font=MONO, height=16, bd=2, relief="sunken", activestyle="none")
        lb.pack(fill="both", expand=True)
        self.payee_ids = []
        for p in q("SELECT * FROM payees ORDER BY payee_id"):
            lb.insert("end", "%-8s %s" % (p["payee_id"], p["name"]))
            self.payee_ids.append(p["payee_id"])
        lb.bind("<<ListboxSelect>>", lambda ev: self.payee_pick(lb))
        self.status.set("F1 Payee Master. Enter a Payee ID and press Lookup.")

    def payee_pick(self, lb):
        sel = lb.curselection()
        if sel:
            self.pm_id.set(self.payee_ids[sel[0]])
            self.payee_lookup()

    def payee_lookup(self):
        pid = self.pm_id.get().strip().upper()
        p = q("SELECT * FROM payees WHERE payee_id = ?", (pid,), one=True)
        if not p:
            for v in self.pm.values():
                v.set("")
            self.status.set("PAYEE NOT FOUND: %s" % pid)
            Dialog(self, "Payee Master", "PAYEE NOT FOUND: %s" % (pid or "(blank)"), icon="!")
            return
        self.pm["name"].set(p["name"])
        self.pm["bank_name"].set(p["bank_name"])
        self.pm["account"].set("*" * 8 + p["account_last4"])
        self.pm["routing"].set(p["routing"])
        self.pm["last_changed"].set(p["last_changed"])
        self.status.set("Payee %s loaded." % pid)

    # -- F2 payment entry -------------------------------------------------------
    def show_entry(self):
        self.clear("PAYMENT ENTRY")
        f = tk.Frame(self.content, bg=GRAY)
        f.pack(anchor="nw", padx=14)
        self.pe_payee, e1 = self.field(f, 0, "Payee ID:", 12)
        tk.Button(f, text="Lookup", font=FONT, bg=GRAY, bd=2, command=self.entry_lookup).grid(row=0, column=2, padx=4, sticky="w")
        e1.bind("<Return>", lambda ev: self.entry_lookup())
        self.pe_name, _ = self.field(f, 1, "Payee Name:", 34, readonly=True)
        self.pe_invoice, _ = self.field(f, 2, "Invoice Ref:", 20)
        self.pe_amount, _ = self.field(f, 3, "Amount (USD):", 16)
        self.pe_date, _ = self.field(f, 4, "Value Date:", 12)
        self.pe_date.set(datetime.date.today().isoformat())
        self.pe_code, _ = self.field(f, 5, "Dual-control code:", 12)
        tk.Label(f, text="(required for amounts of 10,000.00 or more)", font=("DejaVu Sans", 9), bg=GRAY,
                 fg="#404040").grid(row=5, column=2, sticky="w")
        btns = tk.Frame(f, bg=GRAY)
        btns.grid(row=6, column=1, sticky="w", pady=14)
        tk.Button(btns, text="Release Payment", font=FONT_B, bg=GRAY, bd=3, width=16,
                  command=self.release).pack(side="left")
        tk.Button(btns, text="Clear", font=FONT, bg=GRAY, bd=2, width=8, command=self.show_entry).pack(side="left", padx=10)
        self.status.set("F2 Payment Entry. Amount: digits and decimal point only.")
        e1.focus_set()

    def entry_lookup(self):
        pid = self.pe_payee.get().strip().upper()
        p = q("SELECT * FROM payees WHERE payee_id = ?", (pid,), one=True)
        self.pe_name.set(p["name"] if p else "")
        self.status.set(("Payee %s: %s (acct ****%s)" % (pid, p["name"], p["account_last4"])) if p else "PAYEE NOT FOUND: %s" % pid)
        if not p:
            Dialog(self, "Payment Entry", "PAYEE NOT FOUND: %s" % (pid or "(blank)"), icon="!")

    def release(self):
        pid = self.pe_payee.get().strip().upper()
        inv = self.pe_invoice.get().strip()
        amt_raw = self.pe_amount.get().strip()
        code = self.pe_code.get().strip().upper()
        p = q("SELECT * FROM payees WHERE payee_id = ?", (pid,), one=True)
        if not p:
            return self.fail("PAYEE NOT FOUND: %s" % (pid or "(blank)"))
        if not inv:
            return self.fail("INVOICE REF IS REQUIRED.")
        if not re.fullmatch(r"\d+(\.\d{1,2})?", amt_raw):
            return self.fail("INVALID AMOUNT FORMAT: '%s'.\nUse digits and a decimal point only (e.g. 1234.50)." % amt_raw)
        amount = round(float(amt_raw), 2)
        dup = q("SELECT * FROM payments WHERE payee_id = ? AND invoice_ref = ?", (pid, inv), one=True)
        if dup:
            return self.fail("DUPLICATE PAYMENT BLOCKED: invoice %s was already paid (%s)." % (inv, dup["confirmation"]))
        self.status.set("Checking invoice with Ledgerly ERP ...")
        self.update_idletasks()
        chk = ledgerly_check(pid, inv, amount, code, False)
        if not chk.get("ok"):
            return self.fail(chk.get("message", "ERP CHECK FAILED"))
        d = Dialog(self, "Confirm Release",
                   "Release USD %s to %s\n(account ****%s, %s)\nfor invoice %s, value date %s?" % (
                       "{:,.2f}".format(amount), p["name"], p["account_last4"], p["bank_name"], inv, self.pe_date.get()),
                   buttons=("Yes", "No"), icon="?")
        if d.result != "Yes":
            self.status.set("Release cancelled.")
            return
        chk = ledgerly_check(pid, inv, amount, code, True)
        if not chk.get("ok"):
            return self.fail(chk.get("message", "ERP CHECK FAILED"))
        conf = "TRX-%06d" % random.randint(241000, 249999)
        q("INSERT INTO payments(confirmation, payee_id, invoice_ref, amount, value_date, released_by, released_at) VALUES(?,?,?,?,?,?,?)",
          (conf, pid, inv, amount, self.pe_date.get(), OPERATOR, datetime.datetime.now().isoformat(timespec="seconds")), write=True)
        self.status.set("PAYMENT RELEASED. Confirmation %s  (%s  USD %s)" % (conf, inv, "{:,.2f}".format(amount)))
        Dialog(self, "Payment Released", "PAYMENT RELEASED\n\nConfirmation number:  %s\nPayee: %s\nInvoice: %s\nAmount: USD %s" % (
            conf, p["name"], inv, "{:,.2f}".format(amount)))

    def fail(self, msg):
        self.status.set(msg.split("\n")[0])
        Dialog(self, "Error", msg, icon="!")

    # -- F3 register ------------------------------------------------------------
    def show_register(self):
        self.clear("PAYMENT REGISTER")
        cols = ("confirmation", "payee", "invoice", "amount", "value_date", "released_by")
        style = ttk.Style()
        style.configure("Treeview", font=MONO, rowheight=24)
        style.configure("Treeview.Heading", font=FONT_B)
        tv = ttk.Treeview(self.content, columns=cols, show="headings", height=20)
        for c, w, label in zip(cols, (150, 340, 170, 150, 130, 150),
                               ("Confirmation", "Payee", "Invoice Ref", "Amount", "Value Date", "Released By")):
            tv.heading(c, text=label)
            tv.column(c, width=w, anchor="e" if c == "amount" else "w")
        rows = q("SELECT p.*, y.name FROM payments p LEFT JOIN payees y ON y.payee_id = p.payee_id ORDER BY released_at DESC")
        for r in rows:
            tv.insert("", "end", values=(r["confirmation"], "%s %s" % (r["payee_id"], r["name"] or ""), r["invoice_ref"],
                                         "{:,.2f}".format(r["amount"]), r["value_date"], r["released_by"]))
        tv.pack(fill="both", expand=True, padx=14, pady=(0, 10))
        self.status.set("F3 Payment Register: %d payment(s)." % len(rows))


if __name__ == "__main__":
    Treasury().mainloop()

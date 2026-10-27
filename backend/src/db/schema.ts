import { Database } from "bun:sqlite";
import { join } from "path";

export const DB_PATH = join(import.meta.dir, "..", "..", "merchant_ledger.sqlite");
export const db = new Database(DB_PATH, { create: true });

db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS parties (
    party_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT UNIQUE,
    role TEXT NOT NULL CHECK(role IN ('customer', 'supplier', 'proxy', 'both')),
    credit_balance INTEGER NOT NULL DEFAULT 0 CHECK(credit_balance >= 0),
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transactions (
    txn_id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_ref_id TEXT UNIQUE,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    fee INTEGER NOT NULL DEFAULT 0 CHECK(fee >= 0),
    net_amount INTEGER GENERATED ALWAYS AS (amount - fee) STORED,
    channel TEXT NOT NULL CHECK(channel IN ('zaincash', 'cash')),
    type TEXT NOT NULL CHECK(type IN ('cash_sale', 'credit_sale', 'debt_collection', 'cash_purchase', 'credit_purchase', 'supplier_payment', 'operating_expense', 'refund_return', 'credit_return', 'internal_transfer', 'capital_draw', 'debt_netting', 'advance_receipt')),
    expense_category TEXT CHECK(expense_category IS NULL OR expense_category IN ('rent', 'electricity', 'wages', 'transport', 'supplies', 'telecom', 'maintenance', 'other')),
    party_id INTEGER REFERENCES parties(party_id) ON DELETE SET NULL,
    proxy_party_id INTEGER REFERENCES parties(party_id) ON DELETE SET NULL,
    original_txn_id INTEGER REFERENCES transactions(txn_id),
    is_cash_flow INTEGER GENERATED ALWAYS AS (CASE WHEN type IN ('credit_sale', 'credit_purchase', 'credit_return', 'debt_netting') THEN 0 ELSE 1 END) STORED,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'failed', 'refunded')),
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_invoices (
    invoice_id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id INTEGER REFERENCES transactions(txn_id),
    party_id INTEGER NOT NULL REFERENCES parties(party_id) ON DELETE RESTRICT,
    direction TEXT NOT NULL CHECK(direction IN ('receivable', 'payable')),
    original_amount INTEGER NOT NULL CHECK(original_amount > 0),
    paid_amount INTEGER NOT NULL DEFAULT 0 CHECK(paid_amount >= 0),
    remaining_balance INTEGER GENERATED ALWAYS AS (original_amount - paid_amount) STORED,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unpaid' CHECK(status IN ('unpaid', 'partially_paid', 'settled', 'disputed', 'overdue', 'written_off')),
    notes TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (paid_amount <= original_amount)
);

CREATE TABLE IF NOT EXISTS settlement_allocations (
    allocation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id INTEGER NOT NULL REFERENCES transactions(txn_id) ON DELETE CASCADE,
    invoice_id INTEGER NOT NULL REFERENCES credit_invoices(invoice_id) ON DELETE RESTRICT,
    allocated_amount INTEGER NOT NULL CHECK(allocated_amount > 0),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS unreconciled_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    txn_id INTEGER REFERENCES transactions(txn_id),
    raw_ref_id TEXT,
    raw_date TEXT NOT NULL,
    raw_phone TEXT,
    amount INTEGER NOT NULL CHECK(amount > 0),
    anomaly_type TEXT NOT NULL CHECK(anomaly_type IN ('orphan_transfer', 'duplicate', 'failed_discrepancy', 'fee_mismatch', 'amount_mismatch')),
    resolution_status TEXT NOT NULL DEFAULT 'pending' CHECK(resolution_status IN ('pending', 'resolved', 'dismissed')),
    resolution_action TEXT,
    resolved_at DATETIME,
    reason_note TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cashflow_projections (
    projection_id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_date TEXT NOT NULL,
    projected_date TEXT NOT NULL,
    opening_balance INTEGER NOT NULL,
    expected_inflows INTEGER NOT NULL,
    expected_outflows INTEGER NOT NULL,
    closing_balance INTEGER NOT NULL,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('healthy', 'tight', 'deficit')),
    plain_explanation TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS weekly_summaries (
    summary_id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start TEXT NOT NULL UNIQUE,
    week_end TEXT NOT NULL,
    total_revenue INTEGER NOT NULL,
    total_expenses INTEGER NOT NULL,
    net_profit INTEGER NOT NULL,
    total_collected INTEGER NOT NULL,
    total_new_debt INTEGER NOT NULL,
    outstanding_receivable INTEGER NOT NULL,
    outstanding_payable INTEGER NOT NULL,
    anomaly_count INTEGER NOT NULL DEFAULT 0,
    cash_position INTEGER NOT NULL,
    plain_summary TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    log_id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('INSERT', 'UPDATE', 'DELETE')),
    old_values TEXT,
    new_values TEXT,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS test_questions (
    question_id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_text TEXT NOT NULL,
    expected_answer TEXT NOT NULL,
    answer_type TEXT NOT NULL CHECK(answer_type IN ('number', 'text', 'list', 'boolean')),
    category TEXT NOT NULL CHECK(category IN ('revenue', 'expenses', 'debt', 'cashflow', 'anomaly', 'general')),
    difficulty TEXT NOT NULL CHECK(difficulty IN ('easy', 'medium', 'hard')),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS trg_invoice_status
AFTER UPDATE OF paid_amount, original_amount ON credit_invoices
WHEN NEW.status != 'written_off'
BEGIN
    UPDATE credit_invoices
    SET status = CASE
        WHEN NEW.paid_amount >= NEW.original_amount THEN 'settled'
        WHEN NEW.paid_amount > 0 THEN 'partially_paid'
        ELSE 'unpaid'
    END
    WHERE invoice_id = NEW.invoice_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_invoice_audit
AFTER UPDATE ON credit_invoices
BEGIN
    INSERT INTO audit_log (table_name, record_id, action, old_values, new_values)
    VALUES ('credit_invoices', NEW.invoice_id, 'UPDATE', json_object('paid_amount', OLD.paid_amount, 'status', OLD.status), json_object('paid_amount', NEW.paid_amount, 'status', NEW.status));
END;

CREATE TRIGGER IF NOT EXISTS trg_txn_audit
AFTER INSERT ON transactions
BEGIN
    INSERT INTO audit_log (table_name, record_id, action, new_values)
    VALUES ('transactions', NEW.txn_id, 'INSERT', json_object('amount', NEW.amount, 'type', NEW.type, 'channel', NEW.channel, 'party_id', NEW.party_id, 'status', NEW.status));
END;

CREATE INDEX IF NOT EXISTS idx_parties_name ON parties(name);
CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_party ON transactions(party_id);
CREATE INDEX IF NOT EXISTS idx_txn_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_cashflow ON transactions(is_cash_flow);
CREATE INDEX IF NOT EXISTS idx_inv_party ON credit_invoices(party_id);
CREATE INDEX IF NOT EXISTS idx_inv_status ON credit_invoices(status);
CREATE INDEX IF NOT EXISTS idx_inv_due ON credit_invoices(due_date);
CREATE INDEX IF NOT EXISTS idx_alloc_txn ON settlement_allocations(txn_id);
CREATE INDEX IF NOT EXISTS idx_alloc_invoice ON settlement_allocations(invoice_id);
CREATE INDEX IF NOT EXISTS idx_unrec_status ON unreconciled_queue(resolution_status);
CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_log(table_name, record_id);
`);

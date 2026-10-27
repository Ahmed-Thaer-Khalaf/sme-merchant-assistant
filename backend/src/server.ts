import { db } from "./db/schema";
import fs from "fs";

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders }
    });

const settleDebt = db.transaction((txn: number, inv: number, amount: number) => {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
        throw new Error("المبلغ المراد تخصيصه يجب أن يكون أكبر من الصفر");
    }

    const invoice = db.query("SELECT party_id, remaining_balance FROM credit_invoices WHERE invoice_id = ?").get(inv) as {
        party_id: number;
        remaining_balance: number;
    } | null;
    if (!invoice) throw new Error("الفاتورة غير موجودة");

    const excessAmount = amount > invoice.remaining_balance ? amount - invoice.remaining_balance : 0;
    const amountToAllocate = amount - excessAmount;

    const allocation = db
        .query("INSERT INTO settlement_allocations (txn_id, invoice_id, allocated_amount) VALUES (?, ?, ?) RETURNING *")
        .get(txn, inv, amountToAllocate);

    const newRemaining = invoice.remaining_balance - amountToAllocate;
    const newStatus = newRemaining <= 0 ? "settled" : "partially_paid";

    db.query("UPDATE credit_invoices SET paid_amount = paid_amount + ?, status = ? WHERE invoice_id = ?").run(
        amountToAllocate,
        newStatus,
        inv
    );

    if (excessAmount > 0) {
        db.query("UPDATE parties SET credit_balance = credit_balance + ? WHERE party_id = ?").run(excessAmount, invoice.party_id);
    }

    return { allocation, excess_transferred: excessAmount, invoice_status: newStatus };
});

const resolveTlsConfig = (): { cert: string; key: string } | null => {
    const envCert = process.env.TLS_CERT_PATH;
    const envKey = process.env.TLS_KEY_PATH;
    if (envCert && envKey && fs.existsSync(envCert) && fs.existsSync(envKey)) {
        return { cert: envCert, key: envKey };
    }
    return null;
};

const tlsPaths = resolveTlsConfig();
const port = Number(process.env.PORT || 3000);

Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    ...(tlsPaths ? { tls: { cert: Bun.file(tlsPaths.cert), key: Bun.file(tlsPaths.key) } } : {}),
    async fetch(req) {
        const url = new URL(req.url);
        const { pathname } = url;
        const { method } = req;

        try {
            if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });

            if (pathname === "/api/health" && method === "GET") {
                return json({ status: "ok", engine: "deterministic-ledger-sqlite", version: "1.0.0" });
            }

            if (pathname === "/api/parties") {
                if (method === "GET") {
                    const role = url.searchParams.get("role");
                    return json(
                        role
                            ? db.query("SELECT * FROM parties WHERE role = ?").all(role)
                            : db.query("SELECT * FROM parties").all()
                    );
                }
                if (method === "POST") {
                    const { name, phone, role, notes } = (await req.json()) as {
                        name: string;
                        phone?: string;
                        role: string;
                        notes?: string;
                    };
                    return json(
                        db
                            .query("INSERT INTO parties (name, phone, role, notes) VALUES (?, ?, ?, ?) RETURNING *")
                            .get(name, phone || null, role, notes || null),
                        201
                    );
                }
            }

            if (pathname === "/api/invoices") {
                if (method === "GET") {
                    const partyId = url.searchParams.get("party_id");
                    const status = url.searchParams.get("status");
                    let sql = "SELECT * FROM credit_invoices WHERE 1=1";
                    const params: (string | number)[] = [];
                    if (partyId) {
                        sql += " AND party_id = ?";
                        params.push(Number(partyId));
                    }
                    if (status) {
                        sql += " AND status = ?";
                        params.push(status);
                    }
                    return json(db.query(`${sql} ORDER BY due_date ASC`).all(...params));
                }
                if (method === "POST") {
                    const { party_id, direction, original_amount, due_date } = (await req.json()) as {
                        party_id: number;
                        direction: string;
                        original_amount: number;
                        due_date: string;
                    };
                    return json(
                        db
                            .query("INSERT INTO credit_invoices (party_id, direction, original_amount, due_date) VALUES (?, ?, ?, ?) RETURNING *")
                            .get(party_id, direction, original_amount, due_date),
                        201
                    );
                }
            }

            if (pathname === "/api/transactions") {
                if (method === "GET") {
                    const limit = Number(url.searchParams.get("limit") || 50);
                    const type = url.searchParams.get("type");
                    return json(
                        type
                            ? db.query("SELECT * FROM transactions WHERE type = ? ORDER BY date DESC, time DESC LIMIT ?").all(type, limit)
                            : db.query("SELECT * FROM transactions ORDER BY date DESC, time DESC LIMIT ?").all(limit)
                    );
                }
                if (method === "POST") {
                    const {
                        external_ref_id,
                        date,
                        time,
                        amount,
                        fee,
                        channel,
                        type,
                        party_id,
                        proxy_party_id,
                        status,
                        notes
                    } = (await req.json()) as {
                        external_ref_id?: string;
                        date: string;
                        time: string;
                        amount: number;
                        fee?: number;
                        channel: string;
                        type: string;
                        party_id?: number;
                        proxy_party_id?: number;
                        status: string;
                        notes?: string;
                    };
                    return json(
                        db
                            .query(
                                "INSERT INTO transactions (external_ref_id, date, time, amount, fee, channel, type, party_id, proxy_party_id, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
                            )
                            .get(
                                external_ref_id || null,
                                date,
                                time,
                                amount,
                                fee || 0,
                                channel,
                                type,
                                party_id || null,
                                proxy_party_id || null,
                                status,
                                notes || null
                            ),
                        201
                    );
                }
            }

            if (pathname === "/api/allocations" && method === "POST") {
                try {
                    const { txn_id, invoice_id, allocated_amount } = (await req.json()) as {
                        txn_id: number;
                        invoice_id: number;
                        allocated_amount: number;
                    };
                    const result = settleDebt(Number(txn_id), Number(invoice_id), Number(allocated_amount));
                    return json(result, 201);
                } catch (dbErr: unknown) {
                    const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                    return json({ error: msg }, 400);
                }
            }

            if (pathname === "/api/unreconciled" && method === "GET") {
                return json(db.query("SELECT * FROM unreconciled_queue WHERE resolution_status = 'pending'").all());
            }

            if (pathname === "/api/unreconciled/resolve" && method === "POST") {
                const { queue_id, action, resolution_status } = (await req.json()) as {
                    queue_id: number;
                    action: string;
                    resolution_status: string;
                };
                db.query(
                    "UPDATE unreconciled_queue SET resolution_action = ?, resolution_status = ?, resolved_at = CURRENT_TIMESTAMP WHERE queue_id = ?"
                ).run(action, resolution_status, queue_id);
                return json({ success: true, queue_id });
            }

            if (pathname === "/api/cashflow") {
                if (method === "GET") {
                    return json(db.query("SELECT * FROM cashflow_projections ORDER BY projected_date ASC").all());
                }
                if (method === "POST") {
                    const {
                        generated_date,
                        projected_date,
                        opening_balance,
                        expected_inflows,
                        expected_outflows,
                        closing_balance,
                        risk_level,
                        plain_explanation
                    } = (await req.json()) as {
                        generated_date: string;
                        projected_date: string;
                        opening_balance: number;
                        expected_inflows: number;
                        expected_outflows: number;
                        closing_balance: number;
                        risk_level: string;
                        plain_explanation: string;
                    };
                    return json(
                        db
                            .query(
                                "INSERT INTO cashflow_projections (generated_date, projected_date, opening_balance, expected_inflows, expected_outflows, closing_balance, risk_level, plain_explanation) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
                            )
                            .get(
                                generated_date,
                                projected_date,
                                opening_balance,
                                expected_inflows,
                                expected_outflows,
                                closing_balance,
                                risk_level,
                                plain_explanation
                            ),
                        201
                    );
                }
            }

            return json({ error: "Endpoint not found" }, 404);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[Server Error] /api error:", err);
            return json({ error: "Operation Failed: " + message }, 400);
        }
    }
});

console.log(`Deterministic Ledger Database API Server running on port ${port}`);

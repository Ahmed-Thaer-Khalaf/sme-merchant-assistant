import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { db } from "./db/schema";
import fs from "fs";

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

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
        .get(txn, inv, amountToAllocate) as {
        allocation_id: number;
        txn_id: number;
        invoice_id: number;
        allocated_amount: number;
        created_at: string;
    };

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

// ============================================================================
// Enterprise OpenAPI / TypeBox Domain Models & Schemas (Google / MS / Meta)
// ============================================================================

const ErrorResponseSchema = t.Object(
    {
        error: t.String({
            description: "Detailed error message explaining the failure or constraint violation.",
            examples: ["Operation Failed: UNIQUE constraint failed: parties.phone"]
        })
    },
    {
        description: "Standardized error payload returned across all 4xx/5xx responses."
    }
);

const HealthResponseSchema = t.Object(
    {
        status: t.String({
            description: "Operational readiness status (`ok` indicates nominal operational state).",
            examples: ["ok"]
        }),
        engine: t.String({
            description: "Underlying persistence and ledger engine identifier.",
            examples: ["deterministic-ledger-sqlite"]
        }),
        version: t.String({
            description: "Semantic version of the ledger API service.",
            examples: ["1.0.0"]
        })
    },
    {
        description: "System liveness and storage engine readiness telemetry."
    }
);

const PartySchema = t.Object(
    {
        party_id: t.Number({
            description: "Immutable auto-incrementing primary key uniquely identifying the counterparty.",
            examples: [1]
        }),
        name: t.String({
            description: "Full legal or commercial name of the customer, supplier, or intermediary.",
            examples: ["Al-Mansour Trading Co."]
        }),
        phone: t.Nullable(
            t.String({
                description: "Unique mobile phone number used for ZainCash reconciliation and SMS verification.",
                examples: ["07801234567"]
            })
        ),
        role: t.String({
            description: "Commercial classification (`customer`, `supplier`, `proxy`, `both`).",
            examples: ["customer"]
        }),
        credit_balance: t.Number({
            description: "Unapplied positive credit balance (in IQD integer units) accrued from invoice overpayments.",
            examples: [0]
        }),
        notes: t.Nullable(
            t.String({
                description: "Optional audit notes, credit terms, or account remarks.",
                examples: ["Wholesale electronics client - Net 14 credit terms"]
            })
        ),
        created_at: t.String({
            description: "UTC timestamp when the counterparty record was created.",
            examples: ["2026-10-28 12:00:00"]
        })
    },
    {
        description: "Counterparty master record representing a customer, supplier, or financial proxy."
    }
);

const CreatePartyBodySchema = t.Object(
    {
        name: t.String({
            description: "Full legal or trading name of the counterparty.",
            examples: ["Al-Rasheed General Supplies"]
        }),
        phone: t.Optional(
            t.Nullable(
                t.String({
                    description: "Unique phone number. Must not conflict with an existing party record.",
                    examples: ["07709876543"]
                })
            )
        ),
        role: t.String({
            description: "Role classification (`customer`, `supplier`, `proxy`, `both`).",
            examples: ["customer"]
        }),
        notes: t.Optional(
            t.Nullable(
                t.String({
                    description: "Optional operational or credit terms notes.",
                    examples: ["Preferred settlement rail: ZainCash"]
                })
            )
        )
    },
    {
        description: "Payload required to register a new commercial counterparty."
    }
);

const InvoiceSchema = t.Object(
    {
        invoice_id: t.Number({
            description: "Immutable auto-incrementing primary key identifying the credit invoice.",
            examples: [101]
        }),
        txn_id: t.Nullable(
            t.Number({
                description: "Optional link to originating transaction (`transactions.txn_id`).",
                examples: [42]
            })
        ),
        party_id: t.Number({
            description: "Foreign key referencing the counterparty (`parties.party_id`).",
            examples: [1]
        }),
        direction: t.String({
            description: "Accounting direction (`receivable` for customer debt, `payable` for supplier liability).",
            examples: ["receivable"]
        }),
        original_amount: t.Number({
            description: "Initial gross principal obligation in IQD (strictly positive integer).",
            examples: [500000]
        }),
        paid_amount: t.Number({
            description: "Cumulative principal settled against this invoice to date in IQD.",
            examples: [150000]
        }),
        remaining_balance: t.Number({
            description: "Database-generated stored column (`original_amount - paid_amount`) representing outstanding balance in IQD.",
            examples: [350000]
        }),
        due_date: t.String({
            description: "Contractual maturity date in `YYYY-MM-DD` format.",
            examples: ["2026-11-15"]
        }),
        status: t.String({
            description: "Lifecycle status (`unpaid`, `partially_paid`, `settled`, `disputed`, `overdue`, `written_off`).",
            examples: ["partially_paid"]
        }),
        notes: t.Nullable(
            t.String({
                description: "Optional invoice terms or delivery manifest memo.",
                examples: ["Batch #482 consignment delivery"]
            })
        ),
        created_at: t.String({
            description: "UTC creation timestamp of the invoice record.",
            examples: ["2026-10-28 12:30:00"]
        })
    },
    {
        description: "Accounts Receivable (AR) or Accounts Payable (AP) credit obligation record."
    }
);

const CreateInvoiceBodySchema = t.Object(
    {
        party_id: t.Number({
            description: "Foreign key of the counterparty (`parties.party_id`).",
            examples: [1]
        }),
        direction: t.String({
            description: "Obligation direction (`receivable` or `payable`).",
            examples: ["receivable"]
        }),
        original_amount: t.Number({
            description: "Total principal amount in IQD integer units (must be > 0).",
            examples: [750000]
        }),
        due_date: t.String({
            description: "Maturity date in ISO `YYYY-MM-DD` format.",
            examples: ["2026-11-30"]
        })
    },
    {
        description: "Payload for originating a new credit obligation invoice."
    }
);

const TransactionSchema = t.Object(
    {
        txn_id: t.Number({
            description: "Immutable auto-incrementing primary key of the journal entry.",
            examples: [501]
        }),
        external_ref_id: t.Nullable(
            t.String({
                description: "Unique external idempotency reference (e.g., ZainCash transaction receipt number).",
                examples: ["ZC-20261028-9841"]
            })
        ),
        date: t.String({
            description: "Effective accounting date in `YYYY-MM-DD` format.",
            examples: ["2026-10-28"]
        }),
        time: t.String({
            description: "Effective transaction time in `HH:MM` or `HH:MM:SS` format.",
            examples: ["14:30:00"]
        }),
        amount: t.Number({
            description: "Gross transaction amount in IQD integer units (strictly > 0).",
            examples: [250000]
        }),
        fee: t.Number({
            description: "Payment rail fee deducted in IQD (must be >= 0, defaults to 0).",
            examples: [500]
        }),
        net_amount: t.Number({
            description: "Database-generated stored column (`amount - fee`) representing net settlement value in IQD.",
            examples: [249500]
        }),
        channel: t.String({
            description: "Settlement rail tender medium (`zaincash` or `cash`).",
            examples: ["zaincash"]
        }),
        type: t.String({
            description: "Financial classification (`cash_sale`, `credit_sale`, `debt_collection`, `cash_purchase`, `credit_purchase`, `supplier_payment`, `operating_expense`, `refund_return`, `credit_return`, `internal_transfer`, `capital_draw`, `debt_netting`, `advance_receipt`).",
            examples: ["debt_collection"]
        }),
        expense_category: t.Nullable(
            t.String({
                description: "Expense cost center if type is `operating_expense` (`rent`, `electricity`, `wages`, `transport`, `supplies`, `telecom`, `maintenance`, `other`).",
                examples: [null]
            })
        ),
        party_id: t.Nullable(
            t.Number({
                description: "Primary counterparty ID (`parties.party_id`) associated with this transaction.",
                examples: [1]
            })
        ),
        proxy_party_id: t.Nullable(
            t.Number({
                description: "Intermediary proxy ID (`parties.party_id`) if collected through a designated third party.",
                examples: [null]
            })
        ),
        original_txn_id: t.Nullable(
            t.Number({
                description: "Parent transaction ID for adjustments, reversals, or linked transactions.",
                examples: [null]
            })
        ),
        is_cash_flow: t.Number({
            description: "Database-generated boolean flag (`1` for real cash movement, `0` for non-cash credit origination/netting).",
            examples: [1]
        }),
        status: t.String({
            description: "Settlement finality state (`completed`, `failed`, `refunded`).",
            examples: ["completed"]
        }),
        notes: t.Nullable(
            t.String({
                description: "Free-text audit narrative or memo.",
                examples: ["Installment settlement via ZainCash wallet"]
            })
        ),
        created_at: t.String({
            description: "UTC timestamp when the journal entry was committed.",
            examples: ["2026-10-28 14:30:15"]
        })
    },
    {
        description: "Immutable financial journal entry with computed net value and cashflow classification."
    }
);

const CreateTransactionBodySchema = t.Object(
    {
        external_ref_id: t.Optional(
            t.Nullable(
                t.String({
                    description: "Optional external provider receipt ID (enforces uniqueness to guarantee idempotency).",
                    examples: ["ZC-20261028-10294"]
                })
            )
        ),
        date: t.String({
            description: "Transaction accounting date in `YYYY-MM-DD` format.",
            examples: ["2026-10-28"]
        }),
        time: t.String({
            description: "Transaction time in `HH:MM` format.",
            examples: ["15:00"]
        }),
        amount: t.Number({
            description: "Gross transaction amount in IQD (must be > 0).",
            examples: [100000]
        }),
        fee: t.Optional(
            t.Number({
                description: "Gateway processing fee in IQD (defaults to 0, must be >= 0).",
                examples: [500]
            })
        ),
        channel: t.String({
            description: "Payment channel (`zaincash` or `cash`).",
            examples: ["zaincash"]
        }),
        type: t.String({
            description: "Financial classification (`cash_sale`, `credit_sale`, `debt_collection`, `cash_purchase`, `credit_purchase`, `supplier_payment`, `operating_expense`, `refund_return`, `credit_return`, `internal_transfer`, `capital_draw`, `debt_netting`, `advance_receipt`).",
            examples: ["debt_collection"]
        }),
        party_id: t.Optional(
            t.Nullable(
                t.Number({
                    description: "Counterparty ID (`parties.party_id`).",
                    examples: [1]
                })
            )
        ),
        proxy_party_id: t.Optional(
            t.Nullable(
                t.Number({
                    description: "Optional proxy counterparty ID if collected via an intermediary.",
                    examples: [null]
                })
            )
        ),
        status: t.String({
            description: "Settlement status (`completed`, `failed`, `refunded`).",
            examples: ["completed"]
        }),
        notes: t.Optional(
            t.Nullable(
                t.String({
                    description: "Optional transaction narration or memo.",
                    examples: ["Invoice installment payment"]
                })
            )
        )
    },
    {
        description: "Payload for appending a new entry to the financial journal."
    }
);

const CreateAllocationBodySchema = t.Object(
    {
        txn_id: t.Number({
            description: "Payment transaction identifier (`transactions.txn_id`) supplying the funds.",
            examples: [501]
        }),
        invoice_id: t.Number({
            description: "Target credit invoice identifier (`credit_invoices.invoice_id`) to settle.",
            examples: [101]
        }),
        allocated_amount: t.Number({
            description: "Amount in IQD to apply toward the invoice. Must be strictly positive (> 0). Any excess above `remaining_balance` is automatically swept into `parties.credit_balance`.",
            examples: [150000]
        })
    },
    {
        description: "Request payload to execute an atomic debt settlement allocation."
    }
);

const AllocationResponseSchema = t.Object(
    {
        allocation: t.Object({
            allocation_id: t.Number({
                description: "Primary key of the created settlement allocation record.",
                examples: [1]
            }),
            txn_id: t.Number({
                description: "Linked payment transaction ID.",
                examples: [501]
            }),
            invoice_id: t.Number({
                description: "Linked credit invoice ID.",
                examples: [101]
            }),
            allocated_amount: t.Number({
                description: "Actual principal amount applied to the invoice (capped at `remaining_balance`).",
                examples: [100000]
            }),
            created_at: t.String({
                description: "UTC timestamp of the allocation.",
                examples: ["2026-10-28 15:30:00"]
            })
        }),
        excess_transferred: t.Number({
            description: "Overpayment surplus (in IQD) automatically credited to counterparty's `credit_balance`.",
            examples: [50000]
        }),
        invoice_status: t.String({
            description: "Resulting status of target credit invoice (`partially_paid` or `settled`).",
            examples: ["settled"]
        })
    },
    {
        description: "Outcome of an atomic debt settlement operation, detailing principal allocation and overpayment sweep."
    }
);

const UnreconciledQueueItemSchema = t.Object(
    {
        queue_id: t.Number({
            description: "Primary key of the unreconciled anomaly item.",
            examples: [1]
        }),
        txn_id: t.Nullable(
            t.Number({
                description: "Optional linked provisional transaction ID.",
                examples: [null]
            })
        ),
        raw_ref_id: t.Nullable(
            t.String({
                description: "External reference ID from raw statement or payment SMS.",
                examples: ["ZC-UNKNOWN-9921"]
            })
        ),
        raw_date: t.String({
            description: "Raw statement date string.",
            examples: ["2026-10-28"]
        }),
        raw_phone: t.Nullable(
            t.String({
                description: "Unrecognized sender phone number from transfer notification.",
                examples: ["07712349988"]
            })
        ),
        amount: t.Number({
            description: "Discrepant or unallocated transfer amount in IQD.",
            examples: [50000]
        }),
        anomaly_type: t.String({
            description: "Classification of discrepancy (`orphan_transfer`, `duplicate`, `failed_discrepancy`, `fee_mismatch`, `amount_mismatch`).",
            examples: ["orphan_transfer"]
        }),
        resolution_status: t.String({
            description: "Workflow state (`pending`, `resolved`, `dismissed`).",
            examples: ["pending"]
        }),
        resolution_action: t.Nullable(
            t.String({
                description: "Audit description of the corrective action applied.",
                examples: [null]
            })
        ),
        resolved_at: t.Nullable(
            t.String({
                description: "UTC timestamp when the exception was resolved.",
                examples: [null]
            })
        ),
        reason_note: t.String({
            description: "Diagnostic explanation why automated reconciliation failed.",
            examples: ["Unmatched sender wallet number; no open receivable found."]
        }),
        created_at: t.String({
            description: "UTC timestamp when the exception was queued.",
            examples: ["2026-10-28 10:15:00"]
        })
    },
    {
        description: "Exception record in the reconciliation queue awaiting operator review."
    }
);

const ResolveUnreconciledBodySchema = t.Object(
    {
        queue_id: t.Number({
            description: "Primary key (`unreconciled_queue.queue_id`) of the item to update.",
            examples: [1]
        }),
        action: t.String({
            description: "Audit description of the corrective resolution applied.",
            examples: ["Matched to Customer Party #2 and applied toward Invoice #104"]
        }),
        resolution_status: t.String({
            description: "Target terminal state (`resolved` or `dismissed`).",
            examples: ["resolved"]
        })
    },
    {
        description: "Command payload to resolve or dismiss a reconciliation exception."
    }
);

const ResolveUnreconciledResponseSchema = t.Object(
    {
        success: t.Boolean({
            description: "Indicates whether the resolution state was updated successfully.",
            examples: [true]
        }),
        queue_id: t.Number({
            description: "Identifier of the updated exception record.",
            examples: [1]
        })
    },
    {
        description: "Confirmation response for a reconciliation exception resolution."
    }
);

const CashflowProjectionSchema = t.Object(
    {
        projection_id: t.Number({
            description: "Primary key of the liquidity projection record.",
            examples: [1]
        }),
        generated_date: t.String({
            description: "Computation date in `YYYY-MM-DD` format.",
            examples: ["2026-10-28"]
        }),
        projected_date: t.String({
            description: "Target forecast horizon date in `YYYY-MM-DD` format.",
            examples: ["2026-11-04"]
        }),
        opening_balance: t.Number({
            description: "Starting cash position in IQD integer units.",
            examples: [1500000]
        }),
        expected_inflows: t.Number({
            description: "Projected customer collections and cash receipts in IQD.",
            examples: [800000]
        }),
        expected_outflows: t.Number({
            description: "Projected supplier payments and operational disbursements in IQD.",
            examples: [450000]
        }),
        closing_balance: t.Number({
            description: "Projected net liquidity position (`opening_balance + expected_inflows - expected_outflows`) in IQD.",
            examples: [1850000]
        }),
        risk_level: t.String({
            description: "Treasury liquidity stress indicator (`healthy`, `tight`, `deficit`).",
            examples: ["healthy"]
        }),
        plain_explanation: t.String({
            description: "Human-readable summary of treasury drivers and solvency outlook.",
            examples: ["Sufficient receivable maturities provide comfortable buffer over supplier payables."]
        }),
        created_at: t.String({
            description: "UTC creation timestamp of the forecast snapshot.",
            examples: ["2026-10-28 09:00:00"]
        })
    },
    {
        description: "Forward-looking treasury cashflow and solvency projection record."
    }
);

const CreateCashflowBodySchema = t.Object(
    {
        generated_date: t.String({
            description: "Forecast model computation date in `YYYY-MM-DD` format.",
            examples: ["2026-10-28"]
        }),
        projected_date: t.String({
            description: "Target projection date in `YYYY-MM-DD` format.",
            examples: ["2026-11-04"]
        }),
        opening_balance: t.Number({
            description: "Starting cash position in IQD integer units.",
            examples: [1500000]
        }),
        expected_inflows: t.Number({
            description: "Projected cash collections in IQD integer units.",
            examples: [800000]
        }),
        expected_outflows: t.Number({
            description: "Projected cash disbursements in IQD integer units.",
            examples: [450000]
        }),
        closing_balance: t.Number({
            description: "Projected net ending balance in IQD integer units.",
            examples: [1850000]
        }),
        risk_level: t.String({
            description: "Liquidity risk level (`healthy`, `tight`, `deficit`).",
            examples: ["healthy"]
        }),
        plain_explanation: t.String({
            description: "Human-readable treasury explanation.",
            examples: ["Solid projected liquidity covering all operational commitments."]
        })
    },
    {
        description: "Payload to persist a new deterministic cashflow projection."
    }
);

// ============================================================================
// Application Routing & Global Middleware
// ============================================================================

const app = new Elysia()
    .model({
        ErrorResponse: ErrorResponseSchema,
        HealthResponse: HealthResponseSchema,
        Party: PartySchema,
        CreatePartyBody: CreatePartyBodySchema,
        Invoice: InvoiceSchema,
        CreateInvoiceBody: CreateInvoiceBodySchema,
        Transaction: TransactionSchema,
        CreateTransactionBody: CreateTransactionBodySchema,
        CreateAllocationBody: CreateAllocationBodySchema,
        AllocationResponse: AllocationResponseSchema,
        UnreconciledQueueItem: UnreconciledQueueItemSchema,
        ResolveUnreconciledBody: ResolveUnreconciledBodySchema,
        ResolveUnreconciledResponse: ResolveUnreconciledResponseSchema,
        CashflowProjection: CashflowProjectionSchema,
        CreateCashflowBody: CreateCashflowBodySchema
    })
    .use(
        cors({
            origin: "*",
            methods: ["GET", "POST", "OPTIONS", "PUT", "DELETE"],
            allowedHeaders: ["Content-Type", "Authorization"]
        })
    )
    .onAfterHandle(({ set }) => {
        Object.assign(set.headers, corsHeaders);
    })
    .use(
        swagger({
            path: "/scalar",
            provider: "scalar",
            documentation: {
                info: {
                    title: "Deterministic Financial Ledger & Settlement Engine API",
                    version: "1.0.0",
                    description: `
# Enterprise Architecture & Financial Ledger Specification

The **Deterministic Financial Ledger & Settlement Engine API** provides an ACID-compliant, high-assurance accounting backend designed for merchant treasury management, Accounts Receivable/Payable (AR/AP) debt tracking, multi-channel settlement (ZainCash and Cash), and automated reconciliation.

---

## 1. Architectural Principles & Guarantees

### ACID Persistence & Foreign Key Enforcement
All state-mutating operations execute against an SQLite storage engine configured with Write-Ahead Logging (\`PRAGMA journal_mode = WAL\`) and strict referential integrity (\`PRAGMA foreign_keys = ON\`). Complex debt settlements are encapsulated within serializable database transactions (\`db.transaction\`).

### Deterministic Stored Calculations
* **Net Settlement Amount**: \`transactions.net_amount\` is a stored generated column (\`amount - fee\`).
* **Cashflow Categorization**: \`transactions.is_cash_flow\` automatically separates physical liquidity movements from non-cash credit originations (\`credit_sale\`, \`credit_purchase\`, \`credit_return\`, \`debt_netting\`).
* **Invoice Balance Invariants**: \`credit_invoices.remaining_balance\` is a generated column (\`original_amount - paid_amount\`) protected by a strict check constraint (\`CHECK (paid_amount <= original_amount)\`).

### Zero-Decimal Monetary Representation (IQD)
* **Currency**: Iraqi Dinar (**IQD**).
* **Integer Arithmetic**: All monetary quantities are represented as whole 64-bit integers in IQD, eliminating floating-point rounding discrepancies.

### Automatic Overpayment Sweep
During debt settlement via \`POST /api/allocations\`, if the allocated amount exceeds the invoice's remaining balance:
1. The invoice is fully paid and its status transitions to \`settled\`.
2. The surplus (\`excess_transferred\`) is atomically swept into the counterparty's \`parties.credit_balance\`.
                    `.trim(),
                    contact: {
                        name: "Principal Financial Systems Architecture Team",
                        email: "ledger-architecture@enterprise.local"
                    },
                    license: {
                        name: "Proprietary Enterprise License"
                    }
                },
                tags: [
                    {
                        name: "System",
                        description: "Service liveness, readiness probes, and storage engine telemetry."
                    },
                    {
                        name: "Parties",
                        description: "Counterparty master data management covering customers, suppliers, and payment proxies."
                    },
                    {
                        name: "Invoices",
                        description: "Accounts Receivable (AR) and Accounts Payable (AP) credit invoice lifecycle management."
                    },
                    {
                        name: "Transactions",
                        description: "Immutable financial journal entries across cash and ZainCash settlement channels."
                    },
                    {
                        name: "Allocations",
                        description: "Atomic debt settlement engine linking payments to credit invoices with automatic credit sweeps."
                    },
                    {
                        name: "Unreconciled",
                        description: "Exception handling queue for orphan transfers, discrepancies, and duplicate wallet receipts."
                    },
                    {
                        name: "Cashflow",
                        description: "Forward-looking treasury liquidity projections and solvency stress classifications."
                    }
                ]
            }
        })
    )
    .get("/docs", ({ redirect }) => redirect("/scalar"), {
        detail: { hide: true }
    })
    .onError(({ code, error, set }) => {
        Object.assign(set.headers, corsHeaders);

        if (code === "NOT_FOUND") {
            set.status = 404;
            return { error: "Endpoint not found" };
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error("[Server Error] /api error:", error);
        set.status = 400;
        return { error: "Operation Failed: " + message };
    })
    .get(
        "/api/health",
        () => ({
            status: "ok",
            engine: "deterministic-ledger-sqlite",
            version: "1.0.0"
        }),
        {
            response: {
                200: HealthResponseSchema
            },
            detail: {
                tags: ["System"],
                summary: "Retrieve service health and ledger engine telemetry",
                description: "Returns operational health status and storage engine readiness metrics."
            }
        }
    )
    .get(
        "/api/parties",
        ({ query }) => {
            const role = query.role;
            return (role
                ? db.query("SELECT * FROM parties WHERE role = ?").all(role)
                : db.query("SELECT * FROM parties").all()) as Array<typeof PartySchema.static>;
        },
        {
            query: t.Object({
                role: t.Optional(
                    t.String({
                        description: "Optional filter to restrict counterparties by role (`customer`, `supplier`, `proxy`, `both`).",
                        examples: ["customer"]
                    })
                )
            }),
            response: {
                200: t.Array(PartySchema),
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Parties"],
                summary: "List commercial counterparties",
                description: "Retrieves counterparty master records with current credit balance. Supports optional role-based filtering."
            }
        }
    )
    .post(
        "/api/parties",
        ({ body, set }) => {
            const { name, phone, role, notes } = (body || {}) as {
                name: string;
                phone?: string;
                role: string;
                notes?: string;
            };
            set.status = 201;
            return db
                .query("INSERT INTO parties (name, phone, role, notes) VALUES (?, ?, ?, ?) RETURNING *")
                .get(name, phone || null, role, notes || null);
        },
        {
            body: CreatePartyBodySchema,
            response: {
                201: PartySchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Parties"],
                summary: "Register a new commercial counterparty",
                description: "Creates a new customer, supplier, or proxy in the ledger. Enforces unique phone constraints."
            }
        }
    )
    .get(
        "/api/invoices",
        ({ query }) => {
            const partyId = query.party_id;
            const status = query.status;
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
            return db.query(`${sql} ORDER BY due_date ASC`).all(...params);
        },
        {
            query: t.Object({
                party_id: t.Optional(
                    t.Number({
                        description: "Filter invoices by counterparty identifier (`parties.party_id`).",
                        examples: [1]
                    })
                ),
                status: t.Optional(
                    t.String({
                        description: "Filter by lifecycle state (`unpaid`, `partially_paid`, `settled`, `disputed`, `overdue`, `written_off`).",
                        examples: ["unpaid"]
                    })
                )
            }),
            response: {
                200: t.Array(InvoiceSchema),
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Invoices"],
                summary: "Query credit obligations and invoices",
                description: "Lists Accounts Receivable/Payable credit invoices with remaining balance and due dates. Supports party and status filtering."
            }
        }
    )
    .post(
        "/api/invoices",
        ({ body, set }) => {
            const { party_id, direction, original_amount, due_date } = (body || {}) as {
                party_id: number;
                direction: string;
                original_amount: number;
                due_date: string;
            };
            set.status = 201;
            return db
                .query("INSERT INTO credit_invoices (party_id, direction, original_amount, due_date) VALUES (?, ?, ?, ?) RETURNING *")
                .get(party_id, direction, original_amount, due_date);
        },
        {
            body: CreateInvoiceBodySchema,
            response: {
                201: InvoiceSchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Invoices"],
                summary: "Issue a new credit invoice",
                description: "Originates a new Accounts Receivable or Accounts Payable credit invoice in IQD."
            }
        }
    )
    .get(
        "/api/transactions",
        ({ query }) => {
            const limit = Number(query.limit || 50);
            const type = query.type;
            return type
                ? db.query("SELECT * FROM transactions WHERE type = ? ORDER BY date DESC, time DESC LIMIT ?").all(type, limit)
                : db.query("SELECT * FROM transactions ORDER BY date DESC, time DESC LIMIT ?").all(limit);
        },
        {
            query: t.Object({
                type: t.Optional(
                    t.String({
                        description: "Filter transactions by classification type.",
                        examples: ["debt_collection"]
                    })
                ),
                limit: t.Optional(
                    t.Number({
                        description: "Maximum number of records to return (defaults to 50).",
                        examples: [50]
                    })
                )
            }),
            response: {
                200: t.Array(TransactionSchema),
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Transactions"],
                summary: "List journal transaction entries",
                description: "Retrieves reverse-chronological financial ledger entries with computed net amounts and cashflow classifications."
            }
        }
    )
    .post(
        "/api/transactions",
        ({ body, set }) => {
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
            } = (body || {}) as {
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
            set.status = 201;
            return db
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
                );
        },
        {
            body: CreateTransactionBodySchema,
            response: {
                201: TransactionSchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Transactions"],
                summary: "Record a new ledger transaction",
                description: "Appends an immutable financial transaction to the journal across cash or ZainCash settlement rails."
            }
        }
    )
    .post(
        "/api/allocations",
        ({ body, set }) => {
            try {
                const { txn_id, invoice_id, allocated_amount } = (body || {}) as {
                    txn_id: number;
                    invoice_id: number;
                    allocated_amount: number;
                };
                const result = settleDebt(Number(txn_id), Number(invoice_id), Number(allocated_amount));
                set.status = 201;
                return result;
            } catch (dbErr: unknown) {
                const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
                set.status = 400;
                return { error: msg };
            }
        },
        {
            body: CreateAllocationBodySchema,
            response: {
                201: AllocationResponseSchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Allocations"],
                summary: "Execute atomic invoice debt settlement allocation",
                description: "Applies funds from a payment transaction to settle a credit invoice. Excess amounts are automatically swept into the counterparty's credit balance."
            }
        }
    )
    .get(
        "/api/unreconciled",
        () => {
            return db.query("SELECT * FROM unreconciled_queue WHERE resolution_status = 'pending'").all();
        },
        {
            response: {
                200: t.Array(UnreconciledQueueItemSchema),
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Unreconciled"],
                summary: "Retrieve pending reconciliation exception queue",
                description: "Fetches unallocated or discrepant transfer records awaiting human-in-the-loop investigation and resolution."
            }
        }
    )
    .post(
        "/api/unreconciled/resolve",
        ({ body }) => {
            const { queue_id, action, resolution_status } = (body || {}) as {
                queue_id: number;
                action: string;
                resolution_status: string;
            };
            db.query(
                "UPDATE unreconciled_queue SET resolution_action = ?, resolution_status = ?, resolved_at = CURRENT_TIMESTAMP WHERE queue_id = ?"
            ).run(action, resolution_status, queue_id);
            return { success: true, queue_id };
        },
        {
            body: ResolveUnreconciledBodySchema,
            response: {
                200: ResolveUnreconciledResponseSchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Unreconciled"],
                summary: "Resolve or dismiss a reconciliation exception",
                description: "Updates an anomaly record with the corrective action and transitions its state to `resolved` or `dismissed`."
            }
        }
    )
    .get(
        "/api/cashflow",
        () => {
            return db.query("SELECT * FROM cashflow_projections ORDER BY projected_date ASC").all();
        },
        {
            response: {
                200: t.Array(CashflowProjectionSchema),
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Cashflow"],
                summary: "Retrieve forward-looking cashflow forecasts",
                description: "Returns chronological treasury liquidity projections and solvency stress classifications."
            }
        }
    )
    .post(
        "/api/cashflow",
        ({ body, set }) => {
            const {
                generated_date,
                projected_date,
                opening_balance,
                expected_inflows,
                expected_outflows,
                closing_balance,
                risk_level,
                plain_explanation
            } = (body || {}) as {
                generated_date: string;
                projected_date: string;
                opening_balance: number;
                expected_inflows: number;
                expected_outflows: number;
                closing_balance: number;
                risk_level: string;
                plain_explanation: string;
            };
            set.status = 201;
            return db
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
                );
        },
        {
            body: CreateCashflowBodySchema,
            response: {
                201: CashflowProjectionSchema,
                400: ErrorResponseSchema
            },
            detail: {
                tags: ["Cashflow"],
                summary: "Record a liquidity projection snapshot",
                description: "Persists a forward-looking cashflow model detailing expected inflows, outflows, closing balance, and liquidity stress level."
            }
        }
    )
    .all(
        "*",
        ({ set }) => {
            set.status = 404;
            return { error: "Endpoint not found" };
        },
        {
            response: {
                404: ErrorResponseSchema
            },
            detail: { hide: true }
        }
    );

Bun.serve({
    port,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    ...(tlsPaths ? { tls: { cert: Bun.file(tlsPaths.cert), key: Bun.file(tlsPaths.key) } } : {}),
    fetch: app.fetch
});

console.log(`Deterministic Ledger Database API Server running on port ${port}`);
console.log(`Scalar API Reference available at http://localhost:${port}/scalar`);

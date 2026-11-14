import { Auth, HttpError, type Account } from "./auth";
import { units, decimal } from "../../../packages/core/src/money";
export async function financialReport(auth: Auth, a: Account) {
  if (a.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
  const c = await auth.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const at = (await c.query("SELECT now()::text AS at")).rows[0].at;
    const ledger = (
      await c.query(
        "SELECT account,currency,sum(debit)::numeric(38,6)::text AS debit,sum(credit)::numeric(38,6)::text AS credit FROM runtime.ledger_lines GROUP BY account,currency ORDER BY currency,account",
      )
    ).rows;
    const payments = (
      await c.query(
        "SELECT currency,COALESCE(sum(credited_amount),0)::text AS credited FROM workspace.funding_payments GROUP BY currency",
      )
    ).rows;
    const holds = (
      await c.query(
        "SELECT currency,COALESCE(sum(amount),0)::text AS held FROM workspace.money_movements WHERE status IN ('requested','approved') GROUP BY currency",
      )
    ).rows;
    const currencies = [
      ...new Set([...ledger.map((l) => l.currency), "USDT", "USDC"]),
    ];
    const rows = currencies.map((currency) => {
      const lines = ledger.filter((l) => l.currency === currency),
        sum = (prefix: string, side: "debit" | "credit"): bigint =>
          lines
            .filter((l) => l.account.startsWith(prefix))
            .reduce((n, l) => n + units(l[side], 6), 0n);
      const dr = lines.reduce((n, l) => n + units(l.debit, 6), 0n),
        cr = lines.reduce((n, l) => n + units(l.credit, 6), 0n);
      const deposited = sum("asset:treasury:nowpayments", "debit"),
        outgoing = sum("asset:treasury:nowpayments", "credit"),
        frozen =
          sum("liability:movement:", "credit") -
          sum("liability:movement:", "debit");
      const expectedDeposits = payments
          .filter((p) => p.currency === currency)
          .reduce((n, p) => n + units(p.credited, 6), 0n),
        expectedHolds = holds
          .filter((h) => h.currency === currency)
          .reduce((n, h) => n + units(h.held, 6), 0n);
      return {
        currency,
        ledgerBalanced: dr === cr,
        depositsMatch: deposited === expectedDeposits,
        movementHoldsMatch: frozen === expectedHolds,
        settledDeposits: decimal(deposited, 6),
        verifiedOutflows: decimal(outgoing, 6),
        bookTreasury: decimal(deposited - outgoing, 6),
        pendingMovements: decimal(frozen, 6),
        providerPayable: decimal(
          sum("liability:provider-settlement:", "credit") -
            sum("liability:provider-settlement:", "debit"),
          6,
        ),
      };
    });
    await c.query("COMMIT");
    return { asOf: at, scope: "internal_ledger", rows };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release?.();
  }
}
export function reportCsv(report: Awaited<ReturnType<typeof financialReport>>) {
  const cell = (v: unknown) =>
    '"' +
    String(v)
      .replace(/[\r\n\t]/g, " ")
      .replace(/^[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const header = [
    "币种",
    "账本借贷平衡",
    "充值核对",
    "冻结核对",
    "累计充值",
    "已核验转出",
    "账面结算资产",
    "待处理资金",
    "服务商可结算应付",
  ];
  return (
    "\ufeff" +
    [
      header,
      ...report.rows.map((r) => [
        r.currency,
        r.ledgerBalanced ? "一致" : "差异",
        r.depositsMatch ? "一致" : "差异",
        r.movementHoldsMatch ? "一致" : "差异",
        r.settledDeposits,
        r.verifiedOutflows,
        r.bookTreasury,
        r.pendingMovements,
        r.providerPayable,
      ]),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n")
  );
}

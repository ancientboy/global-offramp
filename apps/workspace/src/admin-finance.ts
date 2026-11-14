import { initialProviders } from "../../../packages/core/src/pricing";
import { Auth, HttpError, type Account } from "./auth";
import { decimal, units } from "../../../packages/core/src/money";
import { z } from "zod";

export const financeKinds = [
  "deposit",
  "simulated_deposit",
  "withdrawal",
  "exchange",
  "order_refund",
  "provider_settlement",
  "other",
] as const;
const filterSchema = z
  .object({
    q: z.string().trim().max(120).default(""),
    customerId: z.string().max(128).default(""),
    currency: z
      .enum(["", "USDT", "USDC", "CNY", "USD", "EUR", "GBP", "MXN", "BRL"])
      .default(""),
    kind: z.enum(["", ...financeKinds]).default(""),
    status: z
      .enum([
        "",
        "pending",
        "completed",
        "review",
        "failed",
        "cancelled",
        "rejected",
      ])
      .default(""),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict();
const signed = (v: string) =>
  v.startsWith("-") ? -units(v.slice(1), 6) : units(v, 6);
const str = (v: unknown) => (v == null ? "" : String(v));
export interface Posting {
  id: string;
  key: string;
  at: string;
  currency: string;
  lines: { account: string; currency: string; debit: string; credit: string }[];
  walletChanges: {
    customerId: string;
    before: string;
    change: string;
    after: string;
  }[];
}
export interface FinanceRow {
  id: string;
  kind: (typeof financeKinds)[number];
  customerId: string;
  customerName: string;
  email: string;
  username: string;
  party: string;
  currency: string;
  amount: string;
  netAmount: string | null;
  payoutCurrency: string;
  payoutAmount: string;
  principal: string;
  exchangeRate: string;
  serviceFee: string;
  channelFee: string;
  bookedFees: string;
  status: string;
  rawStatus: string;
  at: string | null;
  reference: string;
  orderId: string;
  network: string;
  destination: string;
  txid: string;
  postings: Posting[];
}
function status(raw: string) {
  if (["completed", "credited", "sent", "recorded"].includes(raw))
    return "completed";
  if (["review", "unknown", "exception", "creation_unknown"].includes(raw))
    return "review";
  if (["failed", "expired"].includes(raw)) return "failed";
  if (["cancelled", "rejected"].includes(raw)) return raw;
  return "pending";
}
function sumRows(
  rows: FinanceRow[],
): Array<{ currency: string } & Record<string, string>> {
  const sums = new Map<string, Record<string, bigint>>();
  for (const r of rows) {
    const s = sums.get(r.currency) ?? {
      deposits: 0n,
      simulatedDeposits: 0n,
      withdrawals: 0n,
      exchangeSpend: 0n,
      refunds: 0n,
      providerSettlements: 0n,
      fees: 0n,
      pending: 0n,
    };
    sums.set(r.currency, s);
    s.fees += signed(r.bookedFees);
    if (r.status === "completed") {
      const n = signed(r.netAmount ?? r.amount);
      if (r.kind === "deposit") s.deposits += n;
      if (r.kind === "simulated_deposit") s.simulatedDeposits += n;
      if (r.kind === "withdrawal") s.withdrawals += n;
      if (r.kind === "exchange") s.exchangeSpend += n;
      if (r.kind === "order_refund") s.refunds += n;
      if (r.kind === "provider_settlement") s.providerSettlements += n;
    } else if (["pending", "review"].includes(r.status))
      s.pending += signed(r.amount);
  }
  return [...sums]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, s]) => ({
      currency,
      ...(Object.fromEntries(
        Object.entries(s).map(([k, v]) => [k, decimal(v, 6)]),
      ) as Record<string, string>),
    }));
}
/** All joins and balance reconstruction use one read-only snapshot. No writes or credential columns. */
export async function financeSnapshot(auth: Auth, actor: Account) {
  if (actor.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
  const c = await auth.pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const at = (await c.query("SELECT now()::text at")).rows[0].at;
    const state =
      (
        await c.query(`SELECT jsonb_build_object(
 'customers',document->'customers',
 'providers',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p->'id','name',p->'name')),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(document->'payoutProviders','[]'::jsonb)) p),
 'orders',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',o->'id','orderNumber',o->'orderNumber','clientOrderId',o->'clientOrderId','customerId',o->'customerId','createdAt',o->'createdAt','quote',o->'quote','depositStatus',o->'depositStatus','conversionStatus',o->'conversionStatus','payoutStatus',o->'payoutStatus','providerReference',o->'paymentConfirmation'->'providerReference')),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(document->'orders','[]'::jsonb)) o),
 'beneficiaries',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',b->'id','customerId',b->'customerId','name',b->'name','country',b->'country','currency',b->'currency','bankName',b->'bankName','accountMasked',b->'accountMasked','status',b->'status','updatedAt',b->'updatedAt','method',b->'recipientAccount'->'method')),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(document->'beneficiaries','[]'::jsonb)) b),
 'refunds',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r->'id','orderId',r->'orderId','amount',r->'amount','currency',r->'currency','status',r->'status','kind',r->'kind','providerReference',r->'providerReference')),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(document->'refunds','[]'::jsonb)) r)
 ) document FROM runtime.state WHERE id=1`)
      ).rows[0]?.document ?? {};
    const accounts = (
      await c.query(`SELECT c.id,c.kind,c.created_at,a.email,a.username,a.display_name,a.enabled,(s.totp_secret IS NOT NULL) mfa_enabled,
 (SELECT max(created_at) FROM workspace.auth_audit WHERE actor_id=a.id AND action='login.succeeded') last_login,
 p.name partner_name,p.id partner_id
 FROM workspace.customers c LEFT JOIN workspace.accounts a ON a.customer_id=c.id AND a.role='customer'
 LEFT JOIN workspace.account_security s ON s.account_id=a.id
 LEFT JOIN workspace.customer_attributions t ON t.customer_id=c.id LEFT JOIN workspace.partners p ON p.id=t.partner_id ORDER BY c.created_at DESC,c.id`)
    ).rows;
    const payments = (
      await c.query(
        "SELECT id,customer_id,currency,pay_currency,requested_amount::numeric(38,6)::text amount,credited_amount::numeric(38,6)::text net,status,provider_id,pay_address,journal_id,created_at FROM workspace.funding_payments",
      )
    ).rows;
    const movements = (
      await c.query(
        `SELECT m.id,m.kind,m.customer_id,m.provider_id,m.currency,m.network,m.amount::numeric(38,6)::text,m.destination,m.status,m.created_at,m.reserve_journal,m.closing_journal,c.txid FROM workspace.money_movements m LEFT JOIN workspace.chain_transfer_claims c ON c.movement_id=m.id`,
      )
    ).rows;
    const lines = (
      await c.query(
        `SELECT l.id::text sequence,j.id,j.business_key,j.created_at,l.account,l.currency,l.debit::numeric(38,6)::text debit,l.credit::numeric(38,6)::text credit FROM runtime.journals j JOIN runtime.ledger_lines l ON l.journal_id=j.id ORDER BY l.id`,
      )
    ).rows;
    await c.query("COMMIT");
    const customers = new Map<string, any>(
      (state.customers ?? []).map((x: any) => [
        x.id,
        {
          ...x,
          email: null,
          enabled: null,
          createdAt: null,
          mfaEnabled: false,
          lastLogin: null,
          partnerName: null,
        },
      ]),
    );
    for (const a of accounts) {
      const old = customers.get(a.id);
      customers.set(a.id, {
        id: a.id,
        name: old?.name ?? a.display_name ?? a.id,
        kind: a.kind,
        status: old?.status ?? "pending",
        email: a.email,
        username: a.username,
        enabled: a.enabled,
        createdAt: a.created_at,
        mfaEnabled: a.mfa_enabled,
        lastLogin: a.last_login,
        partnerName: a.partner_name,
        partnerId: a.partner_id,
      });
    }
    const orders: any[] = state.orders ?? [],
      refunds: any[] = state.refunds ?? [],
      beneficiaries: any[] = state.beneficiaries ?? [],
      orderMap = new Map(orders.map((o) => [o.id, o])),
      providerNames = new Map(
        [...initialProviders(), ...(state.providers ?? [])].map((p: any) => [
          p.id,
          p.name,
        ]),
      );
    const balance = new Map<string, bigint>(),
      postings = new Map<string, Posting>(),
      owner = new Map<string, string>();
    for (const o of orders) owner.set("liability:order:" + o.id, o.customerId);
    for (const m of movements)
      if (m.customer_id) owner.set("liability:movement:" + m.id, m.customer_id);
    for (const l of lines) {
      let p = postings.get(l.id);
      if (!p) {
        p = {
          id: l.id,
          key: l.business_key,
          at: new Date(l.created_at).toISOString(),
          currency: l.currency,
          lines: [],
          walletChanges: [],
        };
        postings.set(l.id, p);
      }
      p.lines.push({
        account: l.account,
        currency: l.currency,
        debit: l.debit,
        credit: l.credit,
      });
      const key = l.account + "|" + l.currency,
        before = balance.get(key) ?? 0n,
        change = signed(l.credit) - signed(l.debit);
      balance.set(key, before + change);
      if (l.account.startsWith("liability:wallet:"))
        p.walletChanges.push({
          customerId: l.account.slice("liability:wallet:".length),
          before: decimal(before, 6),
          change: decimal(change, 6),
          after: decimal(before + change, 6),
        });
    }
    const byKey = new Map([...postings.values()].map((p) => [p.key, p])),
      used = new Set<string>(),
      rows: FinanceRow[] = [];
    function add(
      input: Partial<FinanceRow> &
        Pick<FinanceRow, "id" | "kind" | "currency" | "amount">,
      ps: Posting[] = [],
    ) {
      const person = customers.get(input.customerId ?? "");
      for (const p of ps) used.add(p.id);
      let fees = 0n;
      for (const p of ps)
        for (const l of p.lines)
          if (
            ["revenue:service-fee", "liability:channel-fee"].includes(l.account)
          )
            fees += signed(l.credit) - signed(l.debit);
      rows.push({
        customerId: "",
        customerName: person?.name ?? "",
        email: person?.email ?? "",
        username: person?.username ?? "",
        party: "",
        netAmount: null,
        payoutCurrency: "",
        payoutAmount: "",
        principal: "",
        exchangeRate: "",
        serviceFee: "0.000000",
        channelFee: "0.000000",
        status: "pending",
        rawStatus: "",
        at: null,
        reference: "",
        orderId: "",
        network: "",
        destination: "",
        txid: "",
        ...input,
        postings: ps,
        bookedFees: decimal(fees, 6),
      });
    }
    function keys(...ks: string[]) {
      return ks.map((k) => byKey.get(k)).filter((p): p is Posting => !!p);
    }
    for (const p of payments)
      add(
        {
          id: p.id,
          kind: "deposit",
          customerId: p.customer_id,
          currency: p.currency,
          amount: p.amount,
          netAmount: p.net,
          status: p.journal_id ? "completed" : status(p.status),
          rawStatus: p.status,
          at: new Date(p.created_at).toISOString(),
          reference: str(p.provider_id),
          network: p.pay_currency,
          destination: str(p.pay_address),
        },
        p.journal_id && postings.has(p.journal_id)
          ? [postings.get(p.journal_id)!]
          : [],
      );
    for (const m of movements)
      add(
        {
          id: m.id,
          kind: m.kind === "refund" ? "withdrawal" : "provider_settlement",
          customerId: m.customer_id ?? "",
          party: providerNames.get(m.provider_id) ?? m.provider_id ?? "",
          currency: m.currency,
          amount: m.amount,
          netAmount: m.status === "completed" ? m.amount : null,
          status: status(m.status),
          rawStatus: m.status,
          at: new Date(m.created_at).toISOString(),
          network: m.network,
          destination: m.destination,
          txid: m.txid ?? "",
        },
        keys(
          "movement-reserve:" + m.id,
          "movement-release:" + m.id,
          "movement-paid:" + m.id,
        ),
      );
    for (const o of orders) {
      const q = o.quote;
      add(
        {
          id: o.id,
          kind: "exchange",
          customerId: o.customerId,
          currency: q.sourceCurrency,
          amount: q.totalDeposit,
          netAmount: o.payoutStatus === "sent" ? q.totalDeposit : null,
          payoutCurrency: q.payoutCurrency,
          payoutAmount: q.payoutAmount,
          principal: q.sourceAmount,
          exchangeRate: q.customerRate,
          serviceFee: q.serviceFee,
          channelFee: q.channelFee,
          status: status(
            o.payoutStatus === "draft" && o.depositStatus === "exception"
              ? "exception"
              : o.payoutStatus,
          ),
          rawStatus: o.payoutStatus,
          at: o.createdAt,
          reference: o.orderNumber ?? o.clientOrderId,
          orderId: o.id,
          txid: o.providerReference ?? "",
        },
        keys(
          ...[
            "wallet-reserve",
            "wallet-release",
            "deposit",
            "conversion-source",
            "conversion-target",
            "payout",
            "provider-payable",
            "fee-service",
            "fee-channel",
          ].map((k) => k + ":" + o.id),
        ),
      );
    }
    for (const r of refunds) {
      const o = orderMap.get(r.orderId),
        ps = keys("refund:" + r.id, "commission-refund:" + r.id);
      add(
        {
          id: r.id,
          kind: "order_refund",
          customerId: o?.customerId ?? "",
          currency: r.currency,
          amount: r.amount,
          netAmount: r.status === "recorded" ? r.amount : null,
          status: status(r.status),
          rawStatus: r.status,
          at: ps[0]?.at ?? null,
          reference: r.providerReference ?? "",
          orderId: r.orderId,
        },
        ps,
      );
    }
    // Include synthetic credits explicitly and preserve every otherwise unassociated journal for audit.
    for (const p of postings.values())
      if (!used.has(p.id)) {
        const l = p.lines.find((l) =>
            l.account.startsWith("liability:wallet:"),
          ),
          customerId =
            l?.account.slice("liability:wallet:".length) ??
            p.lines.map((l) => owner.get(l.account)).find(Boolean) ??
            "";
        const synthetic =
          p.key.startsWith("wallet-deposit:") || p.key.startsWith("deposit:");
        const value = l
          ? decimal(signed(l.credit) - signed(l.debit), 6)
          : decimal(
              p.lines
                .filter((l) => l.currency === p.currency)
                .reduce((n, l) => n + signed(l.debit), 0n),
              6,
            );
        add(
          {
            id: p.id,
            kind: synthetic ? "simulated_deposit" : "other",
            customerId,
            currency: p.currency,
            amount: value,
            netAmount: value,
            status: "completed",
            rawStatus: "posted",
            at: p.at,
            reference: p.key,
          },
          [p],
        );
      }
    rows.sort(
      (a, b) =>
        (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id),
    );
    function group<T>(items: T[], key: (item: T) => string) {
      const map = new Map<string, T[]>();
      for (const item of items) {
        const k = key(item);
        const values = map.get(k) ?? [];
        values.push(item);
        map.set(k, values);
      }
      return map;
    }
    const rowsByCustomer = group(rows, (r) => r.customerId),
      ordersByCustomer = group(orders, (o) => o.customerId),
      beneficiariesByCustomer = group(beneficiaries, (b) => b.customerId),
      heldByCustomer = new Map<string, { order: bigint; withdrawal: bigint }>();
    for (const [account, customerId] of owner)
      for (const currency of ["USDT", "USDC"]) {
        const key = customerId + "|" + currency,
          held = heldByCustomer.get(key) ?? { order: 0n, withdrawal: 0n },
          n = balance.get(account + "|" + currency) ?? 0n;
        if (account.startsWith("liability:order:")) held.order += n;
        else held.withdrawal += n;
        heldByCustomer.set(key, held);
      }
    const people = [...customers.values()].map((person) => {
      const own = rowsByCustomer.get(person.id) ?? [],
        ownedOrders = ordersByCustomer.get(person.id) ?? [];
      return {
        ...person,
        recipientCount: beneficiariesByCustomer.get(person.id)?.length ?? 0,
        orderCount: ownedOrders.length,
        completedOrderCount: ownedOrders.filter(
          (o) => o.payoutStatus === "sent",
        ).length,
        balances: ["USDT", "USDC"].map((currency) => {
          const available =
            balance.get("liability:wallet:" + person.id + "|" + currency) ?? 0n;
          const held = heldByCustomer.get(person.id + "|" + currency),
            orderHeld = held?.order ?? 0n,
            withdrawalHeld = held?.withdrawal ?? 0n;
          return {
            currency,
            available: decimal(available, 6),
            orderHeld: decimal(orderHeld, 6),
            withdrawalHeld: decimal(withdrawalHeld, 6),
            frozen: decimal(orderHeld + withdrawalHeld, 6),
            total: decimal(available + orderHeld + withdrawalHeld, 6),
          };
        }),
        summary: sumRows(own),
      };
    });
    return { asOf: at, rows, people, beneficiaries };
  } catch (e) {
    try {
      await c.query("ROLLBACK");
    } catch {}
    throw e;
  } finally {
    c.release?.();
  }
}
export function financeFilters(params: URLSearchParams) {
  const f = filterSchema.parse(Object.fromEntries(params));
  if (f.from && f.to && Date.parse(f.from) >= Date.parse(f.to))
    throw new HttpError(400, "INVALID_DATE_RANGE");
  return f;
}
export function financePage(
  snapshot: Awaited<ReturnType<typeof financeSnapshot>>,
  params: URLSearchParams,
) {
  const f = financeFilters(params),
    q = f.q.toLowerCase();
  const rows = snapshot.rows.filter(
    (r) =>
      (!f.customerId || r.customerId === f.customerId) &&
      (!f.kind || r.kind === f.kind) &&
      (!f.currency ||
        r.currency === f.currency ||
        r.payoutCurrency === f.currency) &&
      (!f.status || r.status === f.status) &&
      (!f.from || (!!r.at && Date.parse(r.at) >= Date.parse(f.from))) &&
      (!f.to || (!!r.at && Date.parse(r.at) < Date.parse(f.to))) &&
      (!q ||
        [
          r.id,
          r.customerId,
          r.customerName,
          r.email,
          r.username,
          r.reference,
          r.txid,
          r.destination,
          r.party,
          r.orderId,
        ].some((v) => v.toLowerCase().includes(q))),
  );
  const start = (f.page - 1) * f.limit;
  return {
    asOf: snapshot.asOf,
    total: rows.length,
    page: f.page,
    limit: f.limit,
    summary: sumRows(rows),
    records: f.format === "csv" ? rows : rows.slice(start, start + f.limit),
  };
}
export const kindNames: Record<string, string> = {
  deposit: "充值",
  simulated_deposit: "模拟充值",
  withdrawal: "提现",
  exchange: "结汇",
  order_refund: "订单退款",
  provider_settlement: "服务商结算",
  other: "其他账务",
};
export const statusNames: Record<string, string> = {
  pending: "待处理",
  completed: "已完成",
  review: "待核对",
  failed: "未完成",
  cancelled: "已取消",
  rejected: "已拒绝",
};
export function financeCsv(report: ReturnType<typeof financePage>) {
  if (report.total > 10000) throw new HttpError(413, "EXPORT_TOO_LARGE");
  const cell = (v: unknown) =>
    '"' +
    str(v)
      .replace(/[\r\n\t]/g, " ")
      .replace(/^\s*[=+@-]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  return (
    "\ufeff" +
    [
      [
        "类型",
        "业务编号",
        "用户编号",
        "用户",
        "邮箱",
        "登录账号",
        "币种",
        "申请或订单金额",
        "实际充值或完成金额",
        "法币币种",
        "法币金额",
        "结汇本金",
        "客户汇率",
        "报价服务费",
        "报价渠道费",
        "已记账净手续费",
        "状态",
        "创建时间（UTC）",
        "关联订单",
        "网络",
        "收款地址",
        "交易哈希或付款参考号",
        "可用余额变动（按记账顺序）",
      ],
      ...report.records.map((r) => [
        kindNames[r.kind],
        r.id,
        r.customerId,
        r.customerName,
        r.email,
        r.username,
        r.currency,
        r.amount,
        r.netAmount ?? "",
        r.payoutCurrency,
        r.payoutAmount,
        r.principal,
        r.exchangeRate,
        r.serviceFee,
        r.channelFee,
        r.bookedFees,
        statusNames[r.status],
        r.at ?? "",
        r.orderId,
        r.network,
        r.destination,
        r.txid || r.reference,
        r.postings
          .flatMap((p) =>
            p.walletChanges.map(
              (w) => `${p.at}: ${w.before} → ${w.after} (${w.change})`,
            ),
          )
          .join("; "),
      ]),
    ]
      .map((r) => r.map(cell).join(","))
      .join("\r\n")
  );
}

export function customerPage(
  snapshot: Awaited<ReturnType<typeof financeSnapshot>>,
  params: URLSearchParams,
) {
  const f = z
    .object({
      q: z.string().trim().max(120).default(""),
      status: z
        .enum(["", "pending", "approved", "suspended", "disabled"])
        .default(""),
      kind: z.enum(["", "personal", "company"]).default(""),
      page: z.coerce.number().int().min(1).max(1000000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    })
    .strict()
    .parse(Object.fromEntries(params));
  const q = f.q.toLowerCase(),
    people = snapshot.people
      .filter(
        (p) =>
          (!f.kind || p.kind === f.kind) &&
          (!f.status ||
            (f.status === "disabled"
              ? p.enabled === false
              : p.status === f.status)) &&
          (!q ||
            [p.id, p.name, p.email, p.username, p.partnerName].some((v) =>
              String(v ?? "")
                .toLowerCase()
                .includes(q),
            )),
      )
      .sort(
        (a, b) =>
          (Date.parse(str(b.createdAt)) || 0) -
            (Date.parse(str(a.createdAt)) || 0) || a.id.localeCompare(b.id),
      );
  return {
    asOf: snapshot.asOf,
    total: people.length,
    page: f.page,
    limit: f.limit,
    records: people.slice((f.page - 1) * f.limit, f.page * f.limit),
  };
}

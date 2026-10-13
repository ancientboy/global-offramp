import { randomUUID } from "node:crypto";
import { Currency, demand, units, SCALE, amount } from "./money";
import { Journal, State } from "./types";
export function postJournal(
  state: State,
  businessKey: string,
  lines: Journal["lines"],
  now: Date,
  reversalOf?: string,
): Journal {
  const existing = state.journals.find((x) => x.businessKey === businessKey);
  demand(
    lines.length >= 2,
    "UNBALANCED_LEDGER",
    "At least two ledger lines required",
  );
  const totals = new Map<Currency, bigint>();
  const normalized = lines.map((l) => {
    const dr = units(l.debit, SCALE[l.currency]);
    const cr = units(l.credit, SCALE[l.currency]);
    demand(
      dr > 0n !== cr > 0n,
      "LEDGER_LINE",
      "Exactly one non-zero side required",
    );
    totals.set(l.currency, (totals.get(l.currency) ?? 0n) + dr - cr);
    return {
      ...l,
      debit: amount(l.debit, l.currency),
      credit: amount(l.credit, l.currency),
    };
  });
  demand(
    [...totals.values()].every((n) => n === 0n),
    "UNBALANCED_LEDGER",
    "Journal must balance independently in every currency",
  );
  const canonical = (value: Journal["lines"]) =>
    JSON.stringify(
      value
        .map((l) => [
          l.account,
          l.currency,
          amount(l.debit, l.currency),
          amount(l.credit, l.currency),
        ])
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
  if (existing) {
    demand(
      existing.reversalOf === reversalOf &&
        canonical(existing.lines) === canonical(normalized),
      "IDEMPOTENCY_CONFLICT",
      "Journal key was used with different financial content",
    );
    return existing;
  }
  if (reversalOf) {
    const original = state.journals.find((j) => j.id === reversalOf);
    demand(
      original && !state.journals.some((j) => j.reversalOf === reversalOf),
      "REVERSAL_CONFLICT",
      "Original journal missing or already reversed",
    );
    demand(
      canonical(normalized) ===
        canonical(
          original.lines.map((l) => ({
            ...l,
            debit: l.credit,
            credit: l.debit,
          })),
        ),
      "INVALID_REVERSAL",
      "Reversal must exactly negate every original account and currency",
    );
  }
  const journal = {
    id: randomUUID(),
    businessKey,
    createdAt: now.toISOString(),
    lines: normalized,
    ...(reversalOf ? { reversalOf } : {}),
  };
  state.journals.push(journal);
  return journal;
}
export function transfer(
  state: State,
  key: string,
  currency: Currency,
  value: string,
  debit: string,
  credit: string,
  now: Date,
): Journal {
  return postJournal(
    state,
    key,
    [
      { account: debit, currency, debit: value, credit: "0" },
      { account: credit, currency, debit: "0", credit: value },
    ],
    now,
  );
}
export function reverseJournal(
  state: State,
  originalId: string,
  key: string,
  now: Date,
): Journal {
  const original = state.journals.find((j) => j.id === originalId);
  demand(original, "NOT_FOUND", "Original journal missing");
  return postJournal(
    state,
    key,
    original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
    now,
    originalId,
  );
}

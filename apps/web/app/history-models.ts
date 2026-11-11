import type { Order, Customer, Beneficiary } from "./models";
export interface HistoryFilters {
  search: string;
  status: string;
  customerId: string;
  currency: string;
  timeField: "createdAt" | "paidAt";
  from: string;
  to: string;
}
export const emptyHistoryFilters: HistoryFilters = {
  search: "",
  status: "all",
  customerId: "all",
  currency: "all",
  timeField: "createdAt",
  from: "",
  to: "",
};
export function filterHistory(
  orders: Order[],
  f: HistoryFilters,
  customers: Customer[],
  beneficiaries: Beneficiary[],
) {
  return orders
    .filter((o) => {
      if (f.status !== "all" && o.payoutStatus !== f.status) return false;
      if (f.customerId !== "all" && o.customerId !== f.customerId) return false;
      if (
        f.currency !== "all" &&
        o.quote.sourceCurrency !== f.currency &&
        o.quote.payoutCurrency !== f.currency
      )
        return false;
      const time =
        f.timeField === "paidAt" ? o.paymentConfirmation?.paidAt : o.createdAt;
      if (f.timeField === "paidAt" && !time) return false;
      const day =
        time && Number.isFinite(Date.parse(time))
          ? new Date(time).toISOString().slice(0, 10)
          : "";
      if ((f.from && (!day || day < f.from)) || (f.to && (!day || day > f.to)))
        return false;
      const text = [
        o.id,
        o.orderNumber,
        o.clientOrderId,
        o.paymentConfirmation?.providerReference,
        customers.find((c) => c.id === o.customerId)?.name,
        beneficiaries.find((b) => b.id === o.quote.beneficiaryId)?.name,
      ]
        .join(" ")
        .toLowerCase();
      return text.includes(f.search.trim().toLowerCase());
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

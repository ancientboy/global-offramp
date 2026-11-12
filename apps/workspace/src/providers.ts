import { Auth, HttpError, type Account } from "./auth";
/** Return only execution-facing data for the provider bound by the operator, never client-supplied identity. */
export async function providerDashboard(auth: Auth, account: Account) {
  if (account.role !== "payout_provider" || !account.payout_provider_id)
    throw new HttpError(403, "FORBIDDEN");
  const state = await auth.store.read();
  const provider = state.payoutProviders?.find(
    (p) => p.id === account.payout_provider_id && p.status === "active",
  );
  if (!provider) throw new HttpError(403, "PROVIDER_UNAVAILABLE");
  return {
    provider: { id: provider.id, name: provider.name, routes: provider.routes },
    orders: state.orders
      .filter((o) => o.payoutProviderSnapshot?.id === provider.id)
      .map((o) => {
        const b = state.beneficiaries.find(
          (b) =>
            b.id === o.quote.beneficiaryId && b.customerId === o.customerId,
        );
        return {
          id: o.id,
          orderNumber: o.orderNumber ?? o.clientOrderId,
          createdAt: o.createdAt,
          payoutCurrency: o.quote.payoutCurrency,
          payoutAmount: o.quote.payoutAmount,
          payoutStatus: o.payoutStatus,
          receiptStatus: o.receiptStatus,
          recipient: b
            ? {
                name: b.name,
                country: b.country,
                accountMasked: b.accountMasked,
              }
            : null,
        };
      }),
  };
}

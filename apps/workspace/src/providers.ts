import type { RecipientVault } from "./recipient-vault";
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
          depositStatus: o.depositStatus,
          fundingStatus: o.walletFundingStatus ?? null,
          canRecordPayment:
            o.depositStatus === "confirmed" &&
            ["draft", "approved", "awaiting_approval"].includes(
              o.payoutStatus,
            ) &&
            (o.fundingSource !== "wallet" ||
              o.walletFundingStatus === "reserved"),
          processingRecordId:
            o.paymentConfirmation?.internalRecordId ??
            state.attempts.filter((a) => a.orderId === o.id).at(-1)
              ?.internalRecordId ??
            null,
          paymentConfirmation: o.paymentConfirmation
            ? {
                actualAmount: o.paymentConfirmation.actualAmount,
                paidAt: o.paymentConfirmation.paidAt,
                providerReference:
                  o.paymentConfirmation.referenceKind === "system_internal"
                    ? null
                    : o.paymentConfirmation.providerReference,
                internalRecordId:
                  o.paymentConfirmation.internalRecordId ?? null,
              }
            : null,
          payoutCurrency: o.quote.payoutCurrency,
          payoutAmount: o.quote.payoutAmount,
          payoutStatus: o.payoutStatus,
          receiptStatus: o.receiptStatus,
          receiptFile: o.receiptFile
            ? {
                fileName: o.receiptFile.fileName,
                contentType: o.receiptFile.contentType,
                size: o.receiptFile.size,
                sha256: o.receiptFile.sha256,
              }
            : null,
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

export async function providerOrder(
  auth: Auth,
  account: Account,
  id: string,
  vault?: RecipientVault,
) {
  const dashboard = await providerDashboard(auth, account),
    order = dashboard.orders.find((o) => o.id === id);
  if (!order) throw new HttpError(404, "NOT_FOUND");
  const state = await auth.store.read(),
    raw = state.orders.find((o) => o.id === id),
    b = state.beneficiaries.find(
      (b) =>
        b.id === raw?.quote.beneficiaryId && b.customerId === raw?.customerId,
    );
  return {
    ...order,
    serverTime: new Date(auth.now()).toISOString(),
    ...(vault && b?.recipientAccount
      ? {
          recipientDetails: {
            method: b.recipientAccount.method,
            fields: vault.open(b),
          },
        }
      : {}),
  };
}

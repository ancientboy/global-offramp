"use client";
import { createContext } from "react";
import type { ActorKey } from "./models";
export interface WorkspaceAccount {
  id: string;
  email: string | null;
  username?: string | null;
  name: string;
  role: "customer" | "merchant_admin" | "payout_provider" | "partner";
  partnerId?: string;
  payoutProviderId?: string;
  customerId: string | null;
  kind?: "personal" | "company";
}
export const WorkspaceContext = createContext<{
  account: WorkspaceAccount;
  logout: () => Promise<void>;
  expired: () => void;
} | null>(null);

/** Authenticated accounts never inherit a role from the demo view switcher. */
export function resolvePortalActor(
  account: WorkspaceAccount | undefined,
  demo: ActorKey,
): ActorKey {
  if (!account) return demo;
  if (account.role === "merchant_admin") return "admin-demo";
  if (account.role === "partner") return "partner-demo";
  return account.kind === "company" ? "company-demo" : "customer-demo";
}

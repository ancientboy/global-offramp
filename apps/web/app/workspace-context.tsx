"use client";
import { createContext } from "react";
export interface WorkspaceAccount {
  id: string;
  email: string | null;
  username?: string | null;
  name: string;
  role: "customer" | "merchant_admin";
  customerId: string | null;
  kind?: "personal" | "company";
}
export const WorkspaceContext = createContext<{
  account: WorkspaceAccount;
  logout: () => Promise<void>;
  expired: () => void;
} | null>(null);

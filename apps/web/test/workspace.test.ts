import test from "node:test";
import assert from "node:assert/strict";
import React, { createElement } from "react";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
// Node has no CSS loader; CSS does not affect portal permissions under test.
const localRequire = createRequire(import.meta.url);
localRequire.extensions[".css"] = () => {};
Object.assign(globalThis, { React });
const Home = localRequire("../app/page").default;
import {
  WorkspaceContext,
  resolvePortalActor,
  type WorkspaceAccount,
} from "../app/workspace-context";
const account: WorkspaceAccount = {
  id: "server-account",
  email: "customer@example.com",
  name: "Independent customer",
  role: "customer",
  customerId: "server-customer",
  kind: "company",
};
function render(a: WorkspaceAccount) {
  return renderToStaticMarkup(
    createElement(
      WorkspaceContext.Provider,
      { value: { account: a, logout: async () => {}, expired: () => {} } },
      createElement(Home),
    ),
  );
}
test("workspace customer renders only its own portal and personal menu, with no demo role picker", () => {
  const html = render(account);
  assert.match(html, /Independent customer/);
  assert.match(html, /aria-label="个人菜单"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.doesNotMatch(html, /MOCK|内测|沙箱|PostgreSQL|MFA|D1/);
  assert.match(html, /商户工作台/);
  assert.doesNotMatch(html, /切换工作台|经营概览|管理后台/);
});
test("workspace administrator starts in its own overview while public demo retains its picker", () => {
  const html = render({ ...account, role: "merchant_admin", customerId: null });
  assert.match(html, /经营概览/);
  assert.match(html, /管理后台/);
  assert.doesNotMatch(html, /切换工作台|MOCK|内测|沙箱|PostgreSQL|MFA|D1/);
  const demo = renderToStaticMarkup(createElement(Home));
  assert.match(demo, /切换工作台/);
  assert.match(demo, /登录账户/);
});

test("authenticated customers cannot switch into admin or partner views using demo actor state", () => {
  for (const demo of [
    "admin-demo",
    "partner-demo",
    "customer-demo",
    "company-demo",
  ] as const) {
    assert.equal(resolvePortalActor(account, demo), "company-demo");
    assert.equal(
      resolvePortalActor({ ...account, kind: "personal" }, demo),
      "customer-demo",
    );
    assert.equal(
      resolvePortalActor({ ...account, role: "merchant_admin" }, demo),
      "admin-demo",
    );
  }
  assert.equal(resolvePortalActor(undefined, "admin-demo"), "admin-demo");
});

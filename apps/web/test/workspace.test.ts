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
test("workspace customer renders only its own portal and logout, with no demo role picker", () => {
  const html = render(account);
  assert.match(html, /Independent customer/);
  assert.match(html, /退出/);
  assert.match(html, /账号内测/);
  assert.match(html, /商户工作台/);
  assert.doesNotMatch(html, /演示角色切换|经营概览|管理后台/);
});
test("workspace administrator starts in its own overview while public demo retains its picker", () => {
  const html = render({ ...account, role: "merchant_admin", customerId: null });
  assert.match(html, /经营概览/);
  assert.match(html, /管理后台/);
  assert.doesNotMatch(html, /演示角色切换/);
  const demo = renderToStaticMarkup(createElement(Home));
  assert.match(demo, /演示角色切换/);
  assert.match(demo, /业务账号内测/);
});

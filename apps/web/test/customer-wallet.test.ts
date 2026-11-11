import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CustomerWallet from "../app/CustomerWallet";
// Root tsx test runner uses the classic JSX transform; Next uses react-jsx.
Object.assign(globalThis, { React });
const render = (initialCurrency = "USDT", resumeDraft = false) =>
  renderToStaticMarkup(
    React.createElement(CustomerWallet, {
      balances: [
        {
          customerId: "customer-1",
          currency: "USDT",
          available: "123.456789",
          frozen: "7.000001",
        },
        {
          customerId: "customer-1",
          currency: "USDC",
          available: "98.765432",
          frozen: "2.000001",
        },
        {
          customerId: "customer-2",
          currency: "USDT",
          available: "99999.000000",
          frozen: "999.000000",
        },
      ],
      deposits: [],
      orders: [],
      customerId: "customer-1",
      locked: false,
      resumeDraft,
      initialCurrency,
      onTopup: () => {},
      onExchange: () => {},
      onOrder: () => {},
    }),
  );
test("wallet overview shows exact scoped balance/frozen amount and direct actions without rate wall", () => {
  const html = render();
  assert.match(html, /123\.456789/);
  assert.match(html, /7\.000001/);
  assert.doesNotMatch(html, /99999/);
  assert.match(html, /模拟充值/);
  assert.match(html, /去结汇/);
  assert.match(html, /资金记录/);
  assert.doesNotMatch(html, /模拟客户报价|01.*钱包模拟充值/);
});
test("wallet reopens on draft asset and clearly offers draft resumption", () => {
  const html = render("USDC", true);
  assert.match(html, /98\.765432/);
  assert.match(html, /2\.000001/);
  assert.doesNotMatch(html, /123\.456789/);
  assert.match(html, /返回结汇草稿/);
  assert.match(html, /重新获取报价/);
});

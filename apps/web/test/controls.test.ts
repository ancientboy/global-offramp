import test from "node:test";
import assert from "node:assert/strict";
import React, { act, createElement, useState } from "react";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require.extensions[".css"] = () => {};
const { JSDOM } = require("jsdom");
Object.assign(globalThis, { React });
const SelectField = require("../app/SelectField").default;
const { Modal } = require("../app/ui");
async function mount(component: React.ReactNode, url = "https://example.test") {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url, pretendToBeVisual: true },
  );
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLSelectElement",
    "FormData",
    "Node",
    "Event",
    "KeyboardEvent",
    "MouseEvent",
  ]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value:
        key === "window"
          ? dom.window
          : key === "document"
            ? dom.window.document
            : dom.window[key],
      configurable: true,
      writable: true,
    });
  }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { createRoot } =
    require("react-dom/client") as typeof import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root"));
  await act(async () => root.render(component));
  return {
    document: dom.window.document,
    window: dom.window,
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else delete (globalThis as any)[key];
      }
    },
  };
}
test("combobox selection skips disabled options and preserves native change events and FormData", async () => {
  let changes = 0;
  function Form() {
    const [value, setValue] = useState("personal");
    return createElement(
      "form",
      null,
      createElement(
        "label",
        null,
        "客户类型",
        createElement(
          SelectField,
          {
            name: "kind",
            value,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              changes++;
              setValue(e.target.value);
            },
          },
          createElement("option", { value: "personal" }, "个人"),
          createElement(
            "option",
            { value: "disabled", disabled: true },
            "不可选",
          ),
          createElement("option", { value: "company" }, "企业"),
        ),
      ),
    );
  }
  const f = await mount(createElement(Form));
  try {
    const trigger = f.document.querySelector("[role=combobox]") as HTMLElement;
    assert.equal(trigger.getAttribute("aria-label"), "客户类型");
    await act(async () =>
      trigger.dispatchEvent(
        new f.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    const list = f.document.querySelector("[role=listbox]")!;
    assert.ok(list);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    await act(async () =>
      list.dispatchEvent(
        new f.window.KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    await act(async () =>
      list.dispatchEvent(
        new f.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    assert.equal(changes, 1);
    assert.match(trigger.textContent!, /企业/);
    assert.equal(
      new f.window.FormData(f.document.querySelector("form")).get("kind"),
      "company",
    );
    assert.equal(f.document.querySelector("[role=listbox]"), null);
    assert.equal(f.document.activeElement, trigger);
  } finally {
    await f.close();
  }
});
test("Escape closes the option menu before the dialog, and closing the dialog restores opener focus", async () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return createElement(
      React.Fragment,
      null,
      createElement("button", { onClick: () => setOpen(true) }, "打开"),
      open &&
        createElement(
          Modal,
          { title: "选择账户", busy: false, onClose: () => setOpen(false) },
          createElement(
            SelectField,
            { "aria-label": "账户" },
            createElement("option", { value: "one" }, "账户一"),
            createElement("option", { value: "two" }, "账户二"),
          ),
        ),
    );
  }
  const f = await mount(createElement(Harness));
  try {
    const opener = f.document.querySelector("button") as HTMLElement;
    opener.focus();
    await act(async () => opener.click());
    const dialog = f.document.querySelector("[role=dialog]")!;
    const title = f.document.getElementById(
      dialog.getAttribute("aria-labelledby")!,
    );
    assert.equal(title.textContent, "选择账户");
    const trigger = f.document.querySelector("[role=combobox]") as HTMLElement;
    await act(async () => trigger.click());
    await act(async () =>
      f.document.querySelector("[role=listbox]")!.dispatchEvent(
        new f.window.KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
        }),
      ),
    );
    assert.ok(f.document.querySelector("[role=dialog]"));
    assert.equal(f.document.querySelector("[role=listbox]"), null);
    await act(async () =>
      trigger.dispatchEvent(
        new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(f.document.querySelector("[role=dialog]"), null);
    assert.equal(f.document.activeElement, opener);
  } finally {
    await f.close();
  }
});

test("fiat choices inside conditional fragments expose all six currencies and submit the selected currency", async () => {
  const codes = ["CNY", "USD", "EUR", "MXN", "BRL", "GBP"];
  const f = await mount(
    createElement(
      "form",
      null,
      createElement(
        SelectField,
        { name: "currency", defaultValue: "CNY" },
        createElement(
          React.Fragment,
          null,
          ...codes.map((c) => createElement("option", { key: c }, c)),
        ),
      ),
    ),
  );
  try {
    await act(async () => f.document.querySelector("[role=combobox]").click());
    const options = [...f.document.querySelectorAll("[role=option]")];
    assert.deepEqual(
      options.map((o: any) => o.textContent),
      codes,
    );
    await act(async () => options[5].click());
    assert.equal(
      new f.window.FormData(f.document.querySelector("form")).get("currency"),
      "GBP",
    );
    assert.match(
      f.document.querySelector("[role=combobox]").textContent,
      /GBP/,
    );
  } finally {
    await f.close();
  }
});

test("provider orders open details and payment registration requires confirmation", async () => {
  const ProviderPortal = require("../app/ProviderPortal").default;
  const { WorkspaceContext } = require("../app/workspace-context");
  const savedFetch = globalThis.fetch;
  const order = {
    id: "assigned-order",
    orderNumber: "ORDER-001",
    createdAt: "2026-11-13T01:00:00Z",
    payoutCurrency: "CNY",
    payoutAmount: "100.00",
    payoutStatus: "draft",
    receiptStatus: "none",
    depositStatus: "confirmed",
    canRecordPayment: true,
    recipient: { name: "收款人", country: "CN", accountMasked: "**** 1234" },
    paymentConfirmation: null,
  };
  globalThis.fetch = (async (url: any) =>
    new Response(
      JSON.stringify(
        String(url).endsWith("/dashboard")
          ? {
              provider: { id: "official", name: "官方自营", routes: ["CNY"] },
              orders: [order],
            }
          : order,
      ),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  const f = await mount(
    createElement(
      WorkspaceContext.Provider,
      {
        value: {
          account: {
            id: "provider-account",
            name: "服务商",
            role: "payout_provider",
          },
          logout: async () => {},
          expired: () => {},
        },
      },
      createElement(ProviderPortal),
    ),
  );
  try {
    const button = (name: string) =>
      [...f.document.querySelectorAll("button")].find(
        (b: any) => b.textContent === name,
      ) as HTMLButtonElement;
    await act(async () => button("查看 / 处理").click());
    assert.ok(f.document.querySelector("[role=dialog]"));
    assert.match(
      f.document.querySelector("[role=dialog]").textContent,
      /100.00 CNY/,
    );
    await act(async () => button("登记已付款").click());
    assert.ok(f.document.querySelector('input[aria-label="外部付款流水号"]'));
    assert.equal(
      f.document.querySelector('input[aria-label="外部付款流水号"]').required,
      false,
    );
    assert.equal(
      f.document.querySelector('textarea[aria-label="付款说明"]').required,
      false,
    );
    assert.equal(
      f.document.querySelector('input[aria-label="处理记录号"]').readOnly,
      true,
    );

    assert.equal(button("确认登记已付款").disabled, true);
    await act(async () =>
      f.document.querySelector("input[type=checkbox]").click(),
    );
    assert.equal(button("确认登记已付款").disabled, false);
    assert.match(
      f.document.querySelector("[role=dialog]").textContent,
      /不会发起银行或链上转账/,
    );
  } finally {
    await f.close();
    globalThis.fetch = savedFetch;
  }
});

test("invitation landing opens registration, submits the validated invite code and clears it after success", async () => {
  const Workspace = require("../app/workspace/page").default;
  const saved = globalThis.fetch,
    code = "A".repeat(32);
  let submitted: any;
  globalThis.fetch = (async (url: any, options: any) => {
    const path = String(url);
    if (path.endsWith("/auth/me"))
      return new Response(JSON.stringify({ error: "UNAUTHENTICATED" }), {
        status: 401,
      });
    if (path.endsWith("/invites/" + code))
      return new Response(JSON.stringify({ partnerName: "邀请伙伴" }));
    if (path.endsWith("/auth/register")) {
      submitted = JSON.parse(options.body);
      return new Response(JSON.stringify({ account: { id: "registered" } }), {
        status: 201,
      });
    }
    throw Error("Unexpected request");
  }) as typeof fetch;
  const f = await mount(
    createElement(Workspace),
    "https://example.test/workspace?invite=" + code,
  );
  try {
    assert.match(f.document.body.textContent, /邀请伙伴/);
    assert.match(f.document.querySelector("h1").textContent, /注册账号/);
    f.document.querySelector("input[name=name]").value = "邀请客户";
    f.document.querySelector("input[name=identifier]").value =
      "invited@example.test";
    f.document.querySelector("input[name=password]").value =
      "a-long-testing-password";
    await act(async () =>
      f.document
        .querySelector("form")
        .dispatchEvent(
          new f.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(submitted.inviteCode, code);
    assert.equal(submitted.kind, "personal");
    assert.equal(submitted.role, undefined);
    assert.equal(submitted.partnerId, undefined);
    assert.equal(f.window.location.search, "");
    assert.match(f.document.body.textContent, /账号已创建/);
  } finally {
    await f.close();
    globalThis.fetch = saved;
  }
});

test("partner portal shows its own invite and registered leads before any commission exists", async () => {
  const Portal = require("../app/PartnerPortal").default,
    { WorkspaceContext } = require("../app/workspace-context");
  const saved = globalThis.fetch;
  const dashboard = {
    partner: {
      id: "own-partner",
      name: "正式伙伴",
      inviteUrl: "https://example.test/workspace?invite=" + "B".repeat(32),
    },
    customers: [
      {
        alias: "客户-123456",
        displayName: "张**",
        status: "pending",
        kind: "personal",
        registeredAt: "2026-11-13T01:00:00Z",
      },
    ],
    commissions: [],
    settlements: [],
  };
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(dashboard))) as typeof fetch;
  const f = await mount(
    createElement(
      WorkspaceContext.Provider,
      {
        value: {
          account: {
            id: "partner",
            name: "正式伙伴",
            role: "partner",
            customerId: null,
          },
          logout: async () => {},
          expired: () => {},
        },
      },
      createElement(Portal),
    ),
  );
  try {
    assert.equal(
      f.document.querySelector('input[aria-label="专属邀请链接"]').value,
      dashboard.partner.inviteUrl,
    );
    const find = (name: string) =>
      [...f.document.querySelectorAll("button")].find(
        (b: any) => b.textContent === name,
      ) as HTMLButtonElement;
    await act(async () => find("我的客户").click());
    assert.match(f.document.body.textContent, /客户-123456/);
    assert.match(f.document.body.textContent, /待审核/);
    await act(async () => find("佣金明细").click());
    assert.match(f.document.body.textContent, /暂无佣金记录/);
    assert.equal(find("导出明细").disabled, true);
    assert.doesNotMatch(
      f.document.body.textContent,
      /出款工作台|客户钱包|管理后台/,
    );
  } finally {
    await f.close();
    globalThis.fetch = saved;
  }
});

test("admin can create a partner through the account dialog and receive a shareable invite", async () => {
  const Panel = require("../app/PartnerAdminPanel").default,
    saved = globalThis.fetch;
  let body: any,
    created = false;
  const row = {
    id: "new-partner",
    name: "合作伙伴",
    username: "newpartner",
    status: "active",
    customerCount: 0,
    createdAt: "2026-11-13T00:00:00Z",
    inviteUrl: "https://example.test/workspace?invite=" + "C".repeat(32),
  };
  globalThis.fetch = (async (url: any, options: any) => {
    if (options?.method === "POST") {
      body = JSON.parse(options.body);
      created = true;
      return new Response(JSON.stringify({ partner: row }), { status: 201 });
    }
    return new Response(JSON.stringify({ partners: created ? [row] : [] }));
  }) as typeof fetch;
  const f = await mount(createElement(Panel));
  try {
    const button = (text: string) =>
      [...f.document.querySelectorAll("button")].find(
        (b: any) => b.textContent === text,
      ) as HTMLButtonElement;
    await act(async () => button("创建伙伴").click());
    assert.ok(f.document.querySelector("[role=dialog]"));
    f.document.querySelector("input[name=name]").value = "合作伙伴";
    f.document.querySelector("input[name=username]").value = "newpartner";
    await act(async () =>
      f.document
        .querySelector("form")
        .dispatchEvent(
          new f.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.equal(body.username, "newpartner");
    assert.ok(body.password.length >= 12);
    assert.equal(body.role, undefined);
    assert.equal(f.document.querySelector("[role=dialog]"), null);
    assert.equal(
      f.document.querySelector('input[aria-label="合作伙伴的邀请链接"]').value,
      row.inviteUrl,
    );
  } finally {
    await f.close();
    globalThis.fetch = saved;
  }
});

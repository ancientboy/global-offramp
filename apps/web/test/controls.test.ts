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
async function mount(component: React.ReactNode) {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://example.test", pretendToBeVisual: true },
  );
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of [
    "window",
    "document",
    "HTMLElement",
    "HTMLSelectElement",
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

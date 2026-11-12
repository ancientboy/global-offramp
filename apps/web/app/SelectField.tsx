"use client";
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check } from "@phosphor-icons/react";

type Option = { value: string; label: string; disabled: boolean };
function text(node: ReactNode): string {
  return Children.toArray(node)
    .map((n) =>
      isValidElement(n) ? text((n.props as any).children) : String(n),
    )
    .join("");
}
function choices(node: ReactNode, disabled = false): Option[] {
  return Children.toArray(node).flatMap((n) => {
    if (!isValidElement(n)) return [];
    const p = n.props as any;
    if (n.type === Fragment) return choices(p.children, disabled);
    if (n.type === "optgroup")
      return choices(p.children, disabled || !!p.disabled);
    if (n.type !== "option") return [];
    return [
      {
        value: String(p.value ?? text(p.children)),
        label: text(p.children),
        disabled: disabled || !!p.disabled,
      },
    ];
  });
}
/** Form-compatible combobox: the hidden native control still owns FormData/change events. */
export default function SelectField(
  props: SelectHTMLAttributes<HTMLSelectElement>,
) {
  const id = useId(),
    listId = id + "-options";
  const options = useMemo(() => choices(props.children), [props.children]);
  const [local, setLocal] = useState(
    String(props.defaultValue ?? options[0]?.value ?? ""),
  );
  const value = props.value === undefined ? local : String(props.value);
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    [label, setLabel] = useState(props["aria-label"] || "");
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 180,
    maxHeight: 280,
  });
  const button = useRef<HTMLButtonElement>(null),
    native = useRef<HTMLSelectElement>(null),
    list = useRef<HTMLDivElement>(null);
  const search = useRef({ text: "", at: 0 });
  const selected = options.find((o) => o.value === value);
  function close(focus = false) {
    setOpen(false);
    if (focus) button.current?.focus();
  }
  function select(index: number) {
    const option = options[index];
    if (
      !option ||
      option.disabled ||
      props.disabled ||
      button.current?.matches(":disabled")
    )
      return;
    if (props.value === undefined) setLocal(option.value);
    if (native.current) {
      native.current.value = option.value;
      native.current.dispatchEvent(
        new native.current.ownerDocument.defaultView!.Event("change", {
          bubbles: true,
        }),
      );
    }
    close(true);
  }
  function reveal() {
    if (
      props.disabled ||
      button.current?.matches(":disabled") ||
      !options.some((o) => !o.disabled)
    )
      return;
    const selectedIndex = options.findIndex(
      (o) => !o.disabled && o.value === value,
    );
    setActive(
      selectedIndex >= 0
        ? selectedIndex
        : options.findIndex((o) => !o.disabled),
    );
    setOpen(true);
  }
  useEffect(() => {
    if (props["aria-label"]) {
      setLabel(props["aria-label"]);
      return;
    }
    const parent =
      button.current?.closest("label") ??
      [...document.querySelectorAll("label")].find(
        (l) => l.htmlFor === props.id,
      );
    if (parent) {
      const direct = [...parent.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join("")
        .trim();
      setLabel(direct || "选择选项");
    }
  }, [props["aria-label"], props.id]);
  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        close();
        return;
      }
      const width = Math.min(Math.max(rect.width, 180), window.innerWidth - 24),
        below = window.innerHeight - rect.bottom - 16,
        above = rect.top - 16;
      const height = Math.min(options.length * 42 + 12, 280),
        up = below < Math.min(height, 160) && above > below,
        maxHeight = Math.max(80, Math.min(height, up ? above : below));
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        top: up ? rect.top - maxHeight - 6 : rect.bottom + 6,
        width,
        maxHeight,
      });
    }
    place();
    list.current?.focus();
    const outside = (e: PointerEvent) => {
      if (
        !button.current?.contains(e.target as Node) &&
        !list.current?.contains(e.target as Node)
      )
        close();
    };
    const scroll = (e: Event) => {
      if (!list.current?.contains(e.target as Node)) place();
    };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open, options]);
  useEffect(() => {
    if (open)
      list.current
        ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);
  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);
  function key(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        e.stopPropagation();
        close(true);
      }
      return;
    }
    if (e.key === "Tab") {
      close(true);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? select(active) : reveal();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      if (!open) {
        reveal();
        return;
      }
      const direction = e.key === "ArrowUp" || e.key === "End" ? -1 : 1;
      let next =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? options.length - 1
            : (active + direction + options.length) % options.length;
      for (let i = 0; i < options.length && options[next]?.disabled; i++)
        next = (next + direction + options.length) % options.length;
      setActive(next);
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      search.current = {
        text:
          (now - search.current.at < 600 ? search.current.text : "") +
          e.key.toLocaleLowerCase(),
        at: now,
      };
      const index = options.findIndex(
        (o) =>
          !o.disabled &&
          o.label.toLocaleLowerCase().startsWith(search.current.text),
      );
      if (index >= 0) {
        if (!open) reveal();
        setActive(index);
      }
    }
  }
  if (props.multiple) return <select {...props} />;
  return (
    <span
      className={"select-field " + (props.className ?? "")}
      style={props.style}
    >
      <select
        {...props}
        id={undefined}
        ref={native}
        hidden
        aria-hidden="true"
        required={false}
        tabIndex={-1}
        className="select-native"
        style={undefined}
        value={value}
        defaultValue={undefined}
        onChange={(e) => {
          if (props.value === undefined) setLocal(e.target.value);
          props.onChange?.(e);
        }}
      >
        {props.children}
      </select>
      <button
        type="button"
        ref={button}
        id={props.id}
        className={"select-trigger " + (open ? "is-open" : "")}
        disabled={props.disabled}
        role="combobox"
        aria-label={label || undefined}
        aria-labelledby={props["aria-labelledby"]}
        aria-expanded={open}
        aria-controls={listId}
        aria-haspopup="listbox"
        aria-required={props.required}
        aria-invalid={props["aria-invalid"]}
        onClick={() => (open ? close() : reveal())}
        onKeyDown={key}
      >
        <span>{selected?.label || "请选择"}</span>
        <CaretDown size={15} aria-hidden="true" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={list}
            id={listId}
            className="select-menu"
            role="listbox"
            tabIndex={-1}
            aria-label={label || "选择选项"}
            aria-activedescendant={listId + "-" + active}
            style={position}
            onKeyDown={key}
          >
            {options.map((option, index) => (
              <button
                key={option.value + index}
                type="button"
                id={listId + "-" + index}
                data-index={index}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                tabIndex={-1}
                className={
                  "select-option " +
                  (index === active ? "is-active " : "") +
                  (option.value === value ? "is-selected" : "")
                }
                disabled={option.disabled}
                onPointerMove={() => !option.disabled && setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => select(index)}
              >
                <span>{option.label}</span>
                {option.value === value && (
                  <Check size={17} weight="bold" aria-hidden="true" />
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  );
}

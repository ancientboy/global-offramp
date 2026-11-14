"use client";
import {
  createContext,
  useContext,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
// Lifetime is the authenticated Home instance; nothing is shared between accounts or persisted to disk.
export const ViewStateContext = createContext<Map<string, unknown> | null>(
  null,
);
export function useViewState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const cache = useContext(ViewStateContext);
  const read = () => (cache?.has(key) ? (cache.get(key) as T) : initial);
  const [slot, setSlot] = useState(() => ({ key, value: read() }));
  if (slot.key !== key) setSlot({ key, value: read() });
  return [
    slot.key === key ? slot.value : read(),
    (next) =>
      setSlot((previous) => {
        const current = previous.key === key ? previous.value : read();
        const value =
          typeof next === "function" ? (next as (p: T) => T)(current) : next;
        cache?.set(key, value);
        return { key, value };
      }),
  ];
}

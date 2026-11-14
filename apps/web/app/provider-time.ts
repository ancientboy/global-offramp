export function localPaymentInput(date: Date): string {
  const pad = (n: number, size = 2) => String(n).padStart(size, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
export function initialPaymentTime(
  createdAt: string,
  serverTime: string,
  elapsed = 0,
): string {
  return localPaymentInput(
    new Date(
      Math.max(
        Date.parse(createdAt) + 1,
        Date.parse(serverTime) + Math.max(0, elapsed),
      ),
    ),
  );
}
export { displayDate as providerDate } from "./experience-models";

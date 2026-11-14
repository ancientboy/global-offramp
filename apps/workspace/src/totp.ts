import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret() {
  const raw = randomBytes(20);
  let bits = "",
    result = "";
  for (const n of raw) bits += n.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5)
    result += alphabet[parseInt(bits.slice(i, i + 5), 2)];
  return result;
}
export function totp(secret: string, counter: number) {
  let bits = "";
  for (const c of secret) {
    const n = alphabet.indexOf(c);
    if (n < 0) throw Error("Invalid TOTP secret");
    bits += n.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(input).digest(),
    offset = h[19] & 15;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
export function totpCounter(
  secret: string,
  code: string,
  at: number,
  last = -1,
) {
  if (!/^\d{6}$/.test(code)) return -1;
  const current = Math.floor(at / 30000);
  for (const c of [current, current - 1, current + 1])
    if (
      c > last &&
      timingSafeEqual(Buffer.from(totp(secret, c)), Buffer.from(code))
    )
      return c;
  return -1;
}
export function sealSecret(key: Buffer, accountId: string, secret: string) {
  if (key.length !== 32) throw Error("Security key must be 32 bytes");
  const iv = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from("offramp-totp-v1:" + accountId));
  return [
    iv.toString("hex"),
    Buffer.concat([c.update(secret, "utf8"), c.final()]).toString("hex"),
    c.getAuthTag().toString("hex"),
  ].join(":");
}
export function openSecret(key: Buffer, accountId: string, value: string) {
  const [iv, data, tag] = value.split(":");
  const c = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  c.setAAD(Buffer.from("offramp-totp-v1:" + accountId));
  c.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([
    c.update(Buffer.from(data, "hex")),
    c.final(),
  ]).toString("utf8");
}

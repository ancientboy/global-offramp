import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { ReceiptBucket } from "../../../sites/worker";
/** Private directory must be owned exclusively by the service user, outside public assets. */
export class PrivateFiles implements ReceiptBucket {
  constructor(private root: string) {
    if (!root.startsWith("/"))
      throw new Error("Receipt directory must be absolute");
  }
  private file(key: string) {
    if (!/^private-receipts\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(key))
      throw new Error("Invalid object key");
    return resolve(this.root, key);
  }
  async put(key: string, value: Uint8Array) {
    if (createHash("sha256").update(value).digest("hex") !== key.split("/")[2])
      throw new Error("Object digest mismatch");
    const file = this.file(key);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    try {
      await writeFile(file, value, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!Buffer.from(await readFile(file)).equals(Buffer.from(value)))
        throw new Error("Stored object digest mismatch");
    }
  }
  async get(key: string) {
    try {
      const bytes = await readFile(this.file(key));
      if (
        createHash("sha256").update(bytes).digest("hex") !== key.split("/")[2]
      )
        throw new Error("Stored object digest mismatch");
      return { arrayBuffer: async () => new Uint8Array(bytes).buffer };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
}

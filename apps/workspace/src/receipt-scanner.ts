import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./auth";
export class ReceiptScanner {
  private active = 0;
  constructor(readonly command = "/usr/bin/clamdscan") {}
  async scan(input: unknown) {
    const encoded = (input as { dataBase64?: unknown })?.dataBase64;
    if (typeof encoded !== "string" || encoded.length > 2800000)
      throw new HttpError(400, "INVALID_FILE");
    const bytes = Buffer.from(encoded, "base64");
    if (
      !bytes.length ||
      bytes.length > 2 * 1024 * 1024 ||
      bytes.toString("base64") !== encoded
    )
      throw new HttpError(400, "INVALID_FILE");
    if (this.active >= 2) throw new HttpError(429, "SCAN_BUSY");
    this.active++;
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "huitu-scan-"));
      const path = join(dir, "receipt");
      await writeFile(path, bytes, { mode: 0o600 });
      await new Promise<void>((resolve, reject) =>
        execFile(
          this.command,
          ["--fdpass", "--no-summary", path],
          { timeout: 12000, maxBuffer: 4096 },
          (error) => {
            if (!error) resolve();
            else
              reject(
                new HttpError(
                  error.code === 1 ? 400 : 503,
                  error.code === 1 ? "UNSAFE_FILE" : "SCAN_UNAVAILABLE",
                ),
              );
          },
        ),
      );
    } finally {
      this.active--;
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }
  async health() {
    await new Promise<void>((resolve, reject) =>
      execFile(
        this.command,
        ["--ping=2"],
        { timeout: 4000, maxBuffer: 4096 },
        (error) =>
          error ? reject(Error("Receipt scanner unavailable")) : resolve(),
      ),
    );
  }
}

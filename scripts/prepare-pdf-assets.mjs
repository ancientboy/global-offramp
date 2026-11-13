import { readFile, mkdir, cp } from "node:fs/promises";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, ".."),
  moduleRoot = resolve(root, "node_modules/pdfjs-dist");
const { version } = JSON.parse(
  await readFile(resolve(moduleRoot, "package.json"), "utf8"),
);
const output = resolve(root, "apps/web/public/vendor/pdfjs", "v" + version);
await mkdir(output, { recursive: true });
for (const file of ["pdf.worker.min.mjs", "pdf.renderer.min.mjs"])
  await cp(resolve(moduleRoot, "legacy/build", file), resolve(output, file));
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"])
  await cp(resolve(moduleRoot, dir), resolve(output, dir), { recursive: true });
await cp(resolve(moduleRoot, "LICENSE"), resolve(output, "LICENSE"));
console.log("Local PDF preview resources prepared");

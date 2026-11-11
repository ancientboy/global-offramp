import { mkdir, copyFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
const dest = resolve("apps/web/public/ocr");
await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await copyFile(
  "node_modules/tesseract.js/dist/worker.min.js",
  `${dest}/worker.min.js`,
);
for (const name of await readdir("node_modules/tesseract.js-core")) {
  if (/^tesseract-core(?:-simd)?-lstm(?:\.wasm|\.wasm\.js)$/.test(name))
    await copyFile(`node_modules/tesseract.js-core/${name}`, `${dest}/${name}`);
}
for (const lang of ["chi_sim", "eng"])
  await copyFile(
    `node_modules/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
    `${dest}/${lang}.traineddata.gz`,
  );
console.log(
  "Prepared self-hosted local OCR worker, WASM and Chinese/English models.",
);

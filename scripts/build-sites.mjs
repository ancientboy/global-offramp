import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "sites-dist");

/** Build the actual Worker as a standalone browser-compatible ES module. */
export async function bundleWorker() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [join(root, "sites/entry.ts")],
    outfile: join(output, "server/index.js"),
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    treeShaking: true,
    minify: true,
    legalComments: "none",
    metafile: true,
    sourcemap: false,
    inject: [join(root, "sites/globals.ts")],
    alias: {
      "node:crypto": join(root, "sites/crypto.ts"),
      "csv-parse/sync": "csv-parse/browser/esm/sync",
    },
  });
  for (const [name, meta] of Object.entries(result.metafile.outputs)) {
    if (meta.imports.length)
      throw new Error(`Worker has unresolved runtime imports: ${name}`);
  }
  const js = result.outputFiles.find((file) => file.path.endsWith("/index.js"));
  if (!js) throw new Error("Worker index.js was not generated");
  if (/\b(?:process\.env|require\s*\(|import\s*\(\s*["']node:)/.test(js.text))
    throw new Error("Unexpected Node runtime dependency in Worker output");
  return { code: js.text, metafile: result.metafile };
}

export async function buildSites({ workerOnly = false } = {}) {
  if (!workerOnly) {
    // A static export is required; never silently publish the previous prototype.
    await readFile(join(root, "apps/web/out/index.html"));
  }
  const { code } = await bundleWorker();
  await mkdir(join(output, "server"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(output, "server/index.js"), code);
  if (!workerOnly) {
    await rm(join(output, "client"), { recursive: true, force: true });
    await cp(join(root, "apps/web/out"), join(output, "client"), {
      recursive: true,
    });
  }
  return output;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  buildSites({ workerOnly: process.argv.includes("--worker-only") })
    .then((path) => console.log(`Private MOCK preview artifact: ${path}`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

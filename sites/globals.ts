// esbuild injects this binding where core code uses Buffer, without mutating
// globalThis or requiring the Node compatibility runtime in the Worker.
export { Buffer } from "buffer";

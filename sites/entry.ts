import { createPreviewWorker } from "./worker";

// Private Site hosting supplies access control and ASSETS. Demo fixture roles are
// not real authentication. No env binding can select a provider or durable store.
export default createPreviewWorker();

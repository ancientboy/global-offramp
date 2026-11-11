import { createPreviewWorker } from "./worker";

// Private Site hosting supplies access control and ASSETS. Demo fixture roles are
// not real production authentication. DB enables identity-scoped synthetic D1 storage.
export default createPreviewWorker();

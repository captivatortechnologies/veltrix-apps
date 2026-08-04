// Deployment status is derived from platform records for this canvas and the
// semgrep-deployment component(s) — identical to the projects type, so it reuses
// that handler.
import getStatus from '../projects/getStatus'

export default getStatus

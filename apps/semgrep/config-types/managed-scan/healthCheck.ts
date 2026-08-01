// Health for Managed Scan settings is credential-level (does Semgrep answer on
// its public API with the configured token?) — identical to the projects type,
// so it reuses that handler rather than duplicating the probe.
import healthCheck from '../projects/healthCheck'

export default healthCheck

import { deployIndicators } from '../../lib/indicators'

// Upsert declared indicators via POST /api/indicators; non-destructive to
// indicators this config type did not declare.
export default deployIndicators

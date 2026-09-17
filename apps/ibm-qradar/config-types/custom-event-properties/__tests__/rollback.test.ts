// rollback for custom-event-properties — the shared custom-property contract.
//
// Children before parents, the prior regex restored verbatim, and no call at all
// for an entry the deploy never managed to record an id or a prior state for.

import rollback from '../rollback'
import { registerCustomPropertyRollbackContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyRollbackContract({
  label: 'custom-event-properties',
  base: 'event_sources',
  handler: rollback,
})

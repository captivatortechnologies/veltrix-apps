// rollback for flow-custom-properties — the shared custom-property contract.

import rollback from '../rollback'
import { registerCustomPropertyRollbackContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyRollbackContract({
  label: 'flow-custom-properties',
  base: 'flow_sources',
  handler: rollback,
})

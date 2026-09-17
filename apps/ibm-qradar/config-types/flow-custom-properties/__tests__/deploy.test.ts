// deploy for flow-custom-properties.
//
// This config type is `makeDeploy('flow_sources', ...)` — the same engine
// custom-event-properties uses, with one path segment changed. Invoking the
// shared contract with this base is what proves the wrapper passed the right
// one: every asserted path is rebuilt from `flow_sources`, while the log source
// types an expression names still come from the event-sources tree.

import deploy from '../deploy'
import { registerCustomPropertyDeployContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyDeployContract({
  label: 'flow-custom-properties',
  base: 'flow_sources',
  handler: deploy,
  noun: /flow custom property\(ies\)/,
})

// deploy for custom-event-properties.
//
// This config type is `makeDeploy('event_sources', ...)` — the whole body lives
// in `lib/customProperties.ts` and is shared byte for byte with
// flow-custom-properties. The contract is registered once and invoked with this
// type's base, so the wrapper's base argument is itself under test: every path
// asserted below is built from `event_sources`.

import deploy from '../deploy'
import { registerCustomPropertyDeployContract } from '../../../lib/__tests__/customPropertiesContracts'

registerCustomPropertyDeployContract({
  label: 'custom-event-properties',
  base: 'event_sources',
  handler: deploy,
  noun: /custom event property\(ies\)/,
})

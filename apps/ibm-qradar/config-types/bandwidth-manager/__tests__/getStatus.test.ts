// getStatus for bandwidth-manager — the shared contract.
//
// getStatus is byte-identical in all 24 configuration types of this app: it
// reads the platform's own deployment record plus the registered component and
// must never reach QRadar. The shared contract asserts that, the SUCCEEDED-only
// query, the completedAt/startedAt fallback, the canvas version and the
// no-component case.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/qradarContracts'

registerGetStatusContract({ label: 'bandwidth-manager', handler: getStatus })

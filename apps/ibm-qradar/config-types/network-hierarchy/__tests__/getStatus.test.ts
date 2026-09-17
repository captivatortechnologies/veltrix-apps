// getStatus for network-hierarchy — the shared contract.
//
// getStatus is byte-identical in all 24 configuration types of this app: it
// reads the platform's own deployment record plus the registered component and
// must never reach QRadar.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/qradarContracts'

registerGetStatusContract({ label: 'network-hierarchy', handler: getStatus })

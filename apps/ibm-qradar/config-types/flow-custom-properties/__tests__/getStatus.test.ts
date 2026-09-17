// getStatus for flow-custom-properties — the shared contract.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/qradarContracts'

registerGetStatusContract({ label: 'flow-custom-properties', handler: getStatus })

// getStatus for custom-event-properties — the shared contract.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/qradarContracts'

registerGetStatusContract({ label: 'custom-event-properties', handler: getStatus })

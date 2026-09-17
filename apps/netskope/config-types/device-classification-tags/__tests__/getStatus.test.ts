// getStatus for device-classification-tags — the shared contract.
//
// getStatus is identical in all 22 configuration types of this app: it reads the
// platform's own deployment record and reports the registered tenant, and must
// never reach Netskope.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/netskopeContracts'

registerGetStatusContract({ label: 'device-classification-tags', handler: getStatus, configTypeId: 'device-classification-tags' })

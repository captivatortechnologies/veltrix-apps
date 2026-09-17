// getStatus for aig-token-groups — the shared contract.
//
// getStatus is identical in all 22 configuration types of this app: it reads the
// platform's own deployment record and reports the registered tenant, and must
// never reach Netskope.

import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/netskopeContracts'

registerGetStatusContract({ label: 'aig-token-groups', handler: getStatus, configTypeId: 'aig-token-groups' })

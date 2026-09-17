import getStatus from '../getStatus'
import { registerGetStatusContract } from '../../../lib/__tests__/netskopeContracts'

registerGetStatusContract({ label: 'url-lists', handler: getStatus, configTypeId: 'url-lists' })

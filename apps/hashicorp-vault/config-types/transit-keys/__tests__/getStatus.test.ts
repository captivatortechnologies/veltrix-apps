import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Transit Keys Get Status Handler', getStatus, 'transit-keys')

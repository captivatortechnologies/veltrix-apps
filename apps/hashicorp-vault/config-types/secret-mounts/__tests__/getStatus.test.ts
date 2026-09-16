import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Secret Engines Get Status Handler', getStatus, 'secret-mounts')

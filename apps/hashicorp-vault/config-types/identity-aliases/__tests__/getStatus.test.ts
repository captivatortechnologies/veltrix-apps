import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Identity Aliases Get Status Handler', getStatus, 'identity-aliases')

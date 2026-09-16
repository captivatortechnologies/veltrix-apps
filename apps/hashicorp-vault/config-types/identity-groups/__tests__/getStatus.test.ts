import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Identity Groups Get Status Handler', getStatus, 'identity-groups')

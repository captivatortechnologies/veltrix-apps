import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Identity Entities Get Status Handler', getStatus, 'identity-entities')

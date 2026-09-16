import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Auth Methods Get Status Handler', getStatus, 'auth-methods')

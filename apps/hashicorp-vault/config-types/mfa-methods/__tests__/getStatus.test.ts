import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Login MFA Methods Get Status Handler', getStatus, 'mfa-methods')

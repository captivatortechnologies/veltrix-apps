import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Login MFA Enforcement Get Status Handler', getStatus, 'mfa-login-enforcement')

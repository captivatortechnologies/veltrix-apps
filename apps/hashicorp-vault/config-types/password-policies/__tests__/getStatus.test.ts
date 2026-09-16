import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Password Policies Get Status Handler', getStatus, 'password-policies')

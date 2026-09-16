import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Audit Devices Get Status Handler', getStatus, 'audit-devices')

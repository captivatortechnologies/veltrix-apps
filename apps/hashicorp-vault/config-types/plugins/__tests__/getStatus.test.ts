import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Plugins Get Status Handler', getStatus, 'plugins')

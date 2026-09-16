import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Sentinel Policies Get Status Handler', getStatus, 'sentinel-policies')

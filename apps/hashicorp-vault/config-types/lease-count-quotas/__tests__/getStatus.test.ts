import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Lease Count Quotas Get Status Handler', getStatus, 'lease-count-quotas')

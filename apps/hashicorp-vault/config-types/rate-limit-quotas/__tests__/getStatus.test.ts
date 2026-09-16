import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault Rate Limit Quotas Get Status Handler', getStatus, 'rate-limit-quotas')

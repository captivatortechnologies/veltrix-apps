import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'

describeGetStatusContract('Vault PKI Roles Get Status Handler', getStatus, 'pki-roles')

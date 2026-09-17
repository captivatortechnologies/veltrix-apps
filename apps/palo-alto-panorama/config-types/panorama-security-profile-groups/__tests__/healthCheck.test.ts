import healthCheck from '../healthCheck'
import { describeHealthCheckContract } from '../../../lib/__tests__/healthCheckContract'
import { fixture } from './fixture'

describeHealthCheckContract(fixture, healthCheck)

import getStatus from '../getStatus'
import { describeGetStatusContract } from '../../../lib/__tests__/getStatusContract'
import { fixture } from './fixture'

describeGetStatusContract(fixture, getStatus)

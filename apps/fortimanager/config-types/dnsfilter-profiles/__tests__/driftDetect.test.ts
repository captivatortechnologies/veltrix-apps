import driftDetect from '../driftDetect'
import { describeDriftContract } from '../../../lib/__tests__/driftContract'
import { fixture } from './fixture'

describeDriftContract(fixture, driftDetect)

import deploy from '../deploy'
import { describeDeployContract } from '../../../lib/__tests__/deployContract'
import { fixture } from './fixture'

describeDeployContract(fixture, deploy)

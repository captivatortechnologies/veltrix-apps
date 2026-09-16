import rollback from '../rollback'
import { describeRollbackContract } from '../../../lib/__tests__/rollbackContract'
import { fixture } from './fixture'

describeRollbackContract(fixture, rollback)

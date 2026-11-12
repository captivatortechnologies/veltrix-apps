import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import getStatus from '../getStatus'
import { licensingContract } from '../../../lib/__tests__/licensingContract'
licensingContract('groups',{validate,deploy,rollback,driftDetect,healthCheck},getStatus)

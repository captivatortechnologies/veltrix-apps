import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import getStatus from '../getStatus'
import { managedContract } from '../../../lib/__tests__/managedContract'
import { resourceDefinition } from '../../../lib/resourceDefinitions'
managedContract(resourceDefinition('microsoft365-groups'), {validate,deploy,rollback,driftDetect,healthCheck,getStatus})

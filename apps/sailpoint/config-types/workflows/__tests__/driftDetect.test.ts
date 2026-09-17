// driftDetect for ISC workflows.
//
// The definition graph is normalised by ISC on save, so drift tracks the stable
// scalars; a workflow switched off in the console is the case that matters.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncWorkflow, workflowItem } from './fixtures'

registerCollectionDriftContract({
  label: 'workflows',
  handler: driftDetect,
  listPath: '/v3/workflows',
  item: workflowItem(),
  matchingLive: inSyncWorkflow(),
  driftedLive: inSyncWorkflow({ enabled: true }),
  driftedField: `${NAME}.enabled`,
  absentField: NAME,
})

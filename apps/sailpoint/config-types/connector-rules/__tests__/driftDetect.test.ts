// driftDetect for ISC connector rules.
//
// The drift worth catching is someone editing the BeanShell in the console — the
// handler reports that the script differs without echoing the source into the diff.

import { registerCollectionDriftContract } from '../../../lib/__tests__/collectionContracts'
import driftDetect from '../driftDetect'
import { NAME, inSyncConnectorRule, ruleItem } from './fixtures'

registerCollectionDriftContract({
  label: 'connector-rules',
  handler: driftDetect,
  listPath: '/beta/connector-rules',
  item: ruleItem(),
  matchingLive: inSyncConnectorRule(),
  driftedLive: inSyncConnectorRule({ sourceCode: { version: '2.0', script: 'map.put("edited-in-console", true);' } }),
  driftedField: `${NAME}.script`,
  absentField: NAME,
})

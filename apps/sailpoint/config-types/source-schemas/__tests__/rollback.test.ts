// rollback for ISC source schemas.
//
// Restoring a schema PUTs back the prior attribute definitions and, critically,
// the prior `identityAttribute`. An entry with no schema id, or one recorded as
// pre-existing with nothing captured, must make no call — a PUT of an invented
// schema would re-correlate accounts on the next aggregation.

import { registerRollbackContract } from '../../../lib/__tests__/collectionContracts'
import rollback from '../rollback'
import { CHILD_PATH, PRIOR, SCHEMA_ID, SCHEMA_NAME, SOURCE_ID, SOURCE_NAME } from './fixtures'

const BASE_ENTRY = { sourceName: SOURCE_NAME, sourceId: SOURCE_ID, schemaName: SCHEMA_NAME }

registerRollbackContract({
  label: 'source-schemas',
  handler: rollback,
  restore: {
    entry: { ...BASE_ENTRY, existed: true, schemaId: SCHEMA_ID, prior: PRIOR },
    method: 'PUT',
    path: `${CHILD_PATH}/${SCHEMA_ID}`,
    bodyIncludes: ['objectGUID', '"cn"', 'legacyMode'],
  },
  remove: {
    entry: { ...BASE_ENTRY, existed: false, schemaId: 'sch-created' },
    method: 'DELETE',
    path: `${CHILD_PATH}/sch-created`,
  },
  unrecoverable: [
    // Created, but the vendor response carried no id — nothing to delete.
    { ...BASE_ENTRY, existed: false },
    // Pre-existing, but deploy never captured the schema it had.
    { ...BASE_ENTRY, existed: true, schemaId: SCHEMA_ID },
  ],
})

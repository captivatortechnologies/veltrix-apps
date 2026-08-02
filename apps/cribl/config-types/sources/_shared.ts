// Cribl Sources config type — input integrations over /api/v1/m/<group>/system/inputs.
//
// A Source is one flat Cribl object { id, type, ...conf }; all CRUD / drift /
// rollback logic is shared with Destinations in lib/criblSystemEntities. This
// module only names the collection (the descriptor) and re-exports the shared
// surface the handlers and tests build on.

import type { EntityDescriptor } from '../../lib/criblSystemEntities'

/** The Cribl inputs collection this config type manages. */
export const SOURCE: EntityDescriptor = {
  resource: 'system/inputs',
  kind: 'source',
  Kind: 'Source',
}

export { buildEntityBody, type SystemEntity } from '../../lib/criblSystemEntities'

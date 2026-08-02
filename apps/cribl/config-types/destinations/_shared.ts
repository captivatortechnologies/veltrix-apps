// Cribl Destinations config type — output integrations over
// /api/v1/m/<group>/system/outputs.
//
// A Destination is one flat Cribl object { id, type, ...conf }; all CRUD / drift
// / rollback logic is shared with Sources in lib/criblSystemEntities. This module
// only names the collection (the descriptor) and re-exports the shared surface
// the handlers and tests build on.

import type { EntityDescriptor } from '../../lib/criblSystemEntities'

/** The Cribl outputs collection this config type manages. */
export const DESTINATION: EntityDescriptor = {
  resource: 'system/outputs',
  kind: 'destination',
  Kind: 'Destination',
}

export { buildEntityBody, type SystemEntity } from '../../lib/criblSystemEntities'

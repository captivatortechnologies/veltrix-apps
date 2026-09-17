// Shared fixtures for the connector-rules handler tests.
//
// A connector rule is BeanShell that runs inside aggregation, so the live fixture
// carries a different script from the canvas: the update is a full-body PUT and the
// prior snapshot is the only copy of the code that was running.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Build Map Normalizer'
export const LIVE_ID = 'cr-19ab55'

/** What the canvas declares. */
export function ruleItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    type: 'BuildMap',
    description: 'Normalise account attributes during aggregation',
    version: '2.0',
    script: 'map.put("normalised", true);',
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveConnectorRule(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'BuildMap',
    description: 'Legacy description nobody updated',
    sourceCode: { version: '1.0', script: 'map.put("superseded", true);' },
    ...over,
  }
}

/** A live object matching {@link ruleItem} in every field drift tracks. */
export function inSyncConnectorRule(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'BuildMap',
    description: 'Normalise account attributes during aggregation',
    sourceCode: { version: '2.0', script: 'map.put("normalised", true);' },
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveConnectorRule}. */
export const PRIOR = {
  name: NAME,
  type: 'BuildMap',
  description: 'Legacy description nobody updated',
  sourceCode: { version: '1.0', script: 'map.put("superseded", true);' },
}

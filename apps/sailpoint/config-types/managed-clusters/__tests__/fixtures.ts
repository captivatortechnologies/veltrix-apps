// Shared fixtures for the managed-clusters handler tests.
//
// Only the name and description round-trip into the rollback snapshot; the cluster
// configuration is applied but never captured, which the prior fixture reflects.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'On-Prem VA Cluster'
export const LIVE_ID = 'mc-0b12'

/** What the canvas declares. */
export function clusterItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    type: 'sailpoint',
    description: 'VA cluster for the datacentre connectors',
    configuration: { clusterType: 'sailpoint' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveManagedCluster(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'sailpoint',
    description: 'Legacy description nobody updated',
    ...over,
  }
}

/** A live object matching {@link clusterItem} in every field drift tracks. */
export function inSyncManagedCluster(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    type: 'sailpoint',
    description: 'VA cluster for the datacentre connectors',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveManagedCluster}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated' }

// Shared fixtures for the campaign-templates handler tests.
//
// The embedded `campaign` object is normalised by ISC on save, so only the
// scalar fields round-trip — the fixtures keep the campaign blob constant and vary
// the name, description and deadline.
//
// The canvas item and the live object differ in every field the handler tracks, so
// "deploy records the LIVE prior, not the desired values" is a real assertion
// rather than a coincidence.
//
// Not a test file — the runner only collects `*.test.ts`.

import { item } from '../../../lib/__tests__/fakeIsc'

export const NAME = 'Quarterly Finance Access Review'
export const LIVE_ID = 'ct-7f21a3'

/** What the canvas declares. */
export function templateItem(fields: Record<string, unknown> = {}) {
  return item(NAME, {
    name: NAME,
    description: 'Quarterly review of all finance access',
    deadlineDuration: 'P2W',
    campaign: { name: NAME, type: 'MANAGER' },
    ...fields,
  })
}

/** What the tenant currently has — stale in every tracked field. */
export function liveCampaignTemplate(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Legacy description nobody updated',
    deadlineDuration: 'P1W',
    campaign: { name: NAME, type: 'MANAGER' },
    ...over,
  }
}

/** A live object matching {@link templateItem} in every field drift tracks. */
export function inSyncCampaignTemplate(over: Record<string, unknown> = {}) {
  return {
    id: LIVE_ID,
    name: NAME,
    description: 'Quarterly review of all finance access',
    deadlineDuration: 'P2W',
    ...over,
  }
}

/** The rollback snapshot deploy must record when it updates {@link liveCampaignTemplate}. */
export const PRIOR = { name: NAME, description: 'Legacy description nobody updated', deadlineDuration: 'P1W' }

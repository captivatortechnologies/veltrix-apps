import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readByol } from '../byolInput'

// =============================================================================
// readByol — the generic SDK `tiers: [{key, count, placement}]` body shape
// (Fleet's own "Database nodes" / "Fleet servers" tiers), with the legacy
// indexerCount/searchHeadCount/indexerPlacement/searchHeadPlacement fields
// kept as a back-compat fallback for callers that predate per-tier topology.
// =============================================================================

const base = {
  name: 'Prod Fleet',
  deploymentType: 'single',
  environmentType: 'production',
  hosting_type: 'AWS',
  region: 'us-east-1',
}

test('accepts the generic tiers body shape and maps to the legacy fields', () => {
  const { data, error } = readByol({
    ...base,
    tiers: [
      { key: 'database', count: 2, placement: { mode: 'single' } },
      { key: 'server', count: 3, placement: { mode: 'single' } },
    ],
  })
  assert.equal(error, undefined)
  assert.equal(data.indexerCount, 2)
  assert.equal(data.searchHeadCount, 3)
  assert.deepEqual(data.nodeTiers, [
    { key: 'database', count: 2, placement: null },
    { key: 'server', count: 3, placement: null },
  ])
})

test('falls back to legacy indexerCount/searchHeadCount when tiers is absent', () => {
  const { data, error } = readByol({
    ...base,
    indexerCount: 4,
    searchHeadCount: 5,
  })
  assert.equal(error, undefined)
  assert.equal(data.indexerCount, 4)
  assert.equal(data.searchHeadCount, 5)
  assert.deepEqual(data.nodeTiers, [
    { key: 'database', count: 4, placement: null },
    { key: 'server', count: 5, placement: null },
  ])
})

test('prefers tiers over legacy fields when both are present', () => {
  const { data } = readByol({
    ...base,
    indexerCount: 99,
    searchHeadCount: 99,
    tiers: [
      { key: 'database', count: 1, placement: null },
      { key: 'server', count: 1, placement: null },
    ],
  })
  assert.equal(data.indexerCount, 1)
  assert.equal(data.searchHeadCount, 1)
})

test('defaults a missing tier (single deployment) to a count of 1', () => {
  const { data, error } = readByol({ ...base })
  assert.equal(error, undefined)
  assert.equal(data.indexerCount, 1)
  assert.equal(data.searchHeadCount, 1)
})

test('rejects a database-node count below the base minimum', () => {
  const { error } = readByol({ ...base, tiers: [{ key: 'database', count: 0 }, { key: 'server', count: 1 }] })
  assert.match(error ?? '', /Database nodes must be at least 1/)
})

test('rejects a Fleet-server count below the base minimum', () => {
  const { error } = readByol({ ...base, tiers: [{ key: 'database', count: 1 }, { key: 'server', count: 0 }] })
  assert.match(error ?? '', /Fleet servers must be at least 1/)
})

test('distributed deployments require at least 2 Fleet servers (using tier labels, not "search heads")', () => {
  const { error } = readByol({
    ...base,
    deploymentType: 'distributed',
    tiers: [
      { key: 'database', count: 3 },
      { key: 'server', count: 1 },
    ],
  })
  assert.match(error ?? '', /Distributed deployments require at least 2 Fleet servers/)
})

test('distributed deployments accept a single database node (Fleet-appropriate minimum, unlike Splunk indexers)', () => {
  const { error } = readByol({
    ...base,
    deploymentType: 'distributed',
    tiers: [
      { key: 'database', count: 1 },
      { key: 'server', count: 2 },
    ],
  })
  assert.equal(error, undefined)
})

test('placement validation errors use the tier label, e.g. "Database nodes placement:"', () => {
  const { error } = readByol({
    ...base,
    deploymentType: 'distributed',
    tiers: [
      { key: 'database', count: 3, placement: { mode: 'multi-site', sites: [{ site: 'us-east-1a', percent: 100 }] } },
      { key: 'server', count: 2 },
    ],
  })
  assert.match(error ?? '', /^Database nodes placement:/)
})

test('multi-region placement requires a dedicated network, using the "Fleet servers" label', () => {
  const { error } = readByol({
    ...base,
    deploymentType: 'distributed',
    networkMode: 'shared',
    tiers: [
      { key: 'database', count: 3 },
      {
        key: 'server',
        count: 2,
        placement: {
          mode: 'multi-site',
          granularity: 'region',
          sites: [
            { site: 'us-east-1', percent: 50 },
            { site: 'us-west-2', percent: 50 },
          ],
        },
      },
    ],
  })
  assert.match(error ?? '', /^Fleet servers placement: multi-region placement requires a dedicated cloud fabric/)
})

test('multi-site placement round-trips into nodeTiers for a distributed deployment', () => {
  const placement = {
    mode: 'multi-site' as const,
    granularity: 'az' as const,
    sites: [
      { site: 'us-east-1a', percent: 60 },
      { site: 'us-east-1b', percent: 40 },
    ],
  }
  const { data, error } = readByol({
    ...base,
    deploymentType: 'distributed',
    tiers: [
      { key: 'database', count: 3, placement },
      { key: 'server', count: 2 },
    ],
  })
  assert.equal(error, undefined)
  assert.deepEqual((data.nodeTiers as any[])[0], { key: 'database', count: 3, placement })
  assert.deepEqual((data.nodeTiers as any[])[1], { key: 'server', count: 2, placement: null })
})

test('a single (non-distributed) deployment always stores null placement, even if the client sent one', () => {
  const { data } = readByol({
    ...base,
    tiers: [
      { key: 'database', count: 1, placement: { mode: 'multi-site', sites: [{ site: 'a', percent: 100 }] } },
      { key: 'server', count: 1 },
    ],
  })
  assert.deepEqual((data.nodeTiers as any[])[0].placement, null)
})

test('rejects a missing name', () => {
  const { error } = readByol({ ...base, name: '' })
  assert.match(error ?? '', /Name is required/)
})

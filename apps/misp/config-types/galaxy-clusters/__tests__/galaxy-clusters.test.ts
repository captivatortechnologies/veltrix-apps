import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildClusterFields, findGalaxyRef, findCluster, galaxiesFromList, clustersFromList, parseAuthors, parseElements } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.value ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { galaxy: 'mitre-attack-pattern', value: 'APT-Internal-1', description: 'Homegrown actor', distribution: '0', publish: 'no' }

test('validate rejects a missing galaxy', async () => {
  const res = await validate(ctxOf([{ ...good, galaxy: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GALAXY'))
})

test('validate rejects a missing value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects an invalid distribution', async () => {
  const res = await validate(ctxOf([{ ...good, distribution: '9' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DISTRIBUTION'))
})

test('validate requires a sharing_group_id when distribution is Sharing Group', async () => {
  const res = await validate(ctxOf([{ ...good, distribution: '4' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_SHARING_GROUP'))
})

test('validate accepts distribution 4 with a sharing_group_id', async () => {
  const res = await validate(ctxOf([{ ...good, distribution: '4', sharing_group_id: 3 }]))
  assert.equal(res.valid, true)
})

test('validate rejects invalid elements JSON', async () => {
  const res = await validate(ctxOf([{ ...good, elements: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_JSON'))
})

test('validate warns on a duplicate galaxy/value pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_CLUSTER'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('parseAuthors splits on commas and trims', () => {
  assert.deepEqual(parseAuthors('Jane Doe, Threat Intel Team, '), ['Jane Doe', 'Threat Intel Team'])
})

test('parseElements parses a valid JSON array', () => {
  const elements = parseElements('[{"key":"country","value":"US"}]')
  assert.deepEqual(elements, [{ key: 'country', value: 'US' }])
})

test('parseElements returns empty array on invalid JSON', () => {
  assert.deepEqual(parseElements('{not json'), [])
})

test('buildClusterFields includes sharing_group_id only for distribution 4', () => {
  const withSg = buildClusterFields({ value: 'x', distribution: '4', sharing_group_id: 5 })
  assert.equal(withSg.sharing_group_id, 5)
  const without = buildClusterFields({ value: 'x', distribution: '0', sharing_group_id: 5 })
  assert.equal('sharing_group_id' in without, false)
})

test('findGalaxyRef matches by type, uuid, or name', () => {
  const galaxies = galaxiesFromList([{ Galaxy: { id: 1, uuid: 'abc-123', type: 'mitre-attack-pattern', name: 'Attack Pattern' } }])
  assert.ok(findGalaxyRef(galaxies, 'mitre-attack-pattern'))
  assert.ok(findGalaxyRef(galaxies, 'abc-123'))
  assert.ok(findGalaxyRef(galaxies, 'Attack Pattern'))
  assert.equal(findGalaxyRef(galaxies, 'nope'), null)
})

test('findCluster never matches a default cluster', () => {
  const clusters = clustersFromList([{ GalaxyCluster: { id: 1, value: 'APT1', default: true } }])
  assert.equal(findCluster(clusters, 'APT1'), null)
})

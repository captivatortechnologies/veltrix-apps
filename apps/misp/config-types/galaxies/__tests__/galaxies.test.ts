import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildGalaxyFields, findGalaxy, galaxiesFromList, normalizeYesNo } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the MISP REST API via node:https inside mispApi, which
 * is impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Internal Threat Actors', type: 'internal-threat-actor', description: 'Homegrown actor tracking', enabled: 'yes', local_only: 'no' }

test('validate rejects a missing type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate rejects an uppercase type', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'Internal-Threat-Actor' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects invalid kill_chain_order JSON', async () => {
  const res = await validate(ctxOf([{ ...good, kill_chain_order: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_JSON'))
})

test('validate accepts valid kill_chain_order JSON', async () => {
  const res = await validate(ctxOf([{ ...good, kill_chain_order: '{"Kill Chain":["Recon"]}' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate type', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TYPE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildGalaxyFields defaults namespace to custom', () => {
  const fields = buildGalaxyFields({ name: 'x', type: 'x-galaxy' })
  assert.equal(fields.namespace, 'custom')
})

test('buildGalaxyFields omits kill_chain_order and icon when blank', () => {
  const fields = buildGalaxyFields({ name: 'x', type: 'x-galaxy' })
  assert.equal('kill_chain_order' in fields, false)
  assert.equal('icon' in fields, false)
})

test('findGalaxy never matches a default galaxy', () => {
  const galaxies = galaxiesFromList([{ Galaxy: { id: 1, type: 'mitre-attack-pattern', default: true } }])
  assert.equal(findGalaxy(galaxies, 'mitre-attack-pattern'), null)
})

test('findGalaxy matches a custom galaxy by type case-insensitively', () => {
  const galaxies = galaxiesFromList([{ Galaxy: { id: 2, type: 'Internal-Threat-Actor', default: false } }])
  assert.ok(findGalaxy(galaxies, 'internal-threat-actor'))
})

test('normalizeYesNo handles strings and booleans', () => {
  assert.equal(normalizeYesNo('yes'), true)
  assert.equal(normalizeYesNo('no'), false)
  assert.equal(normalizeYesNo(true), true)
})

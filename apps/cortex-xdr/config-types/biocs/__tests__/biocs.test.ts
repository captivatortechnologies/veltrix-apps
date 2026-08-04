import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildBiocFields, findBioc, biocsFromReply, isValidJson, normalizeName } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (identity matching + body building) — both network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Suspicious PowerShell Download',
  type: 'EXECUTION',
  severity: 'SEV_040_HIGH',
  status: 'enabled',
  comment: 'Flags encoded PowerShell download-and-execute chains',
}

// --- validate -----------------------------------------------------------------

test('validate accepts a well-formed BIOC rule', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown category', async () => {
  const res = await validate(ctxOf([{ ...good, type: 'MADE_UP' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TYPE'))
})

test('validate rejects an unknown severity', async () => {
  const res = await validate(ctxOf([{ ...good, severity: 'SEV_050_CRITICAL' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SEVERITY'))
})

test('validate rejects an unknown status', async () => {
  const res = await validate(ctxOf([{ ...good, status: 'archived' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_STATUS'))
})

test('validate rejects invalid indicator JSON', async () => {
  const res = await validate(ctxOf([{ ...good, indicator: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_INDICATOR_JSON'))
})

test('validate accepts valid indicator JSON', async () => {
  const res = await validate(ctxOf([{ ...good, indicator: '{"AND":[]}' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ----------------------------------------------------------

test('buildBiocFields omits empty optional fields', () => {
  const bioc = buildBiocFields({ name: 'Rule A', type: 'EVASION', severity: 'SEV_020_LOW', status: 'enabled' })
  assert.equal(bioc.name, 'Rule A')
  assert.equal('comment' in bioc, false)
  assert.equal('indicator' in bioc, false)
  assert.equal('mitre_tactic_id_and_name' in bioc, false)
})

test('buildBiocFields defaults status to enabled when blank', () => {
  const bioc = buildBiocFields({ name: 'Rule B', type: 'OTHER', severity: 'SEV_010_INFO' })
  assert.equal(bioc.status, 'enabled')
})

test('buildBiocFields parses a valid indicator JSON blob', () => {
  const bioc = buildBiocFields({ name: 'Rule C', type: 'OTHER', severity: 'SEV_010_INFO', indicator: '{"AND":[{"field":"x"}]}' })
  assert.deepEqual(bioc.indicator, { AND: [{ field: 'x' }] })
})

test('isValidJson tolerates blank and rejects malformed JSON', () => {
  assert.equal(isValidJson(''), true)
  assert.equal(isValidJson('{"a":1}'), true)
  assert.equal(isValidJson('{a:1}'), false)
})

test('findBioc matches case-insensitively on name', () => {
  const live = [{ name: 'SUSPICIOUS DOWNLOAD', severity: 'SEV_020_LOW' }]
  const match = findBioc(live, 'suspicious download')
  assert.ok(match)
  assert.equal(match?.severity, 'SEV_020_LOW')
})

test('biocsFromReply unwraps both the array and { objects } shapes', () => {
  assert.equal(biocsFromReply([{ name: 'a' }]).length, 1)
  assert.equal(biocsFromReply({ objects: [{ name: 'b' }, { name: 'c' }] }).length, 2)
  assert.equal(biocsFromReply(null).length, 0)
})

test('normalizeName trims and lowercases', () => {
  assert.equal(normalizeName('  Rule Name  '), 'rule name')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractIpRestrictionSpecs,
  findIpRestrictionByName,
  restrictionIdOf,
  restrictionNameOf,
  buildIpRestrictionCreateBody,
  buildIpRestrictionUpdateBody,
  buildIpRestrictionRestoreBody,
  type LiveIpRestriction,
} from '../_shared'
import { recordsFromResponse } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers in _shared.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Corp Network', range: '172.56.23.0/24', comment: 'HQ subnet' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing range', async () => {
  const res = await validate(ctxOf([{ ...good, range: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RANGE'))
})

test('validate accepts a good CIDR range', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a single IP address', async () => {
  const res = await validate(ctxOf([{ ...good, range: '172.56.24.72' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a range that is not IP/CIDR shaped', async () => {
  const res = await validate(ctxOf([{ ...good, range: 'not-an-ip' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RANGE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_RESTRICTION'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('extractIpRestrictionSpecs maps and trims canvas fields', () => {
  const specs = extractIpRestrictionSpecs(toItems([{ name: '  Corp Network  ', range: ' 172.56.23.0/24 ' }]))
  assert.equal(specs[0].name, 'Corp Network')
  assert.equal(specs[0].range, '172.56.23.0/24')
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LiveIpRestriction>(JSON.stringify({ records: [{ id: 1, name: 'A', range: '10.0.0.0/8' }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
})

test('restrictionNameOf reads the name', () => {
  assert.equal(restrictionNameOf({ name: 'Corp Network' }), 'Corp Network')
  assert.equal(restrictionNameOf({}), '')
})

test('findIpRestrictionByName matches case-insensitively', () => {
  const restrictions: LiveIpRestriction[] = [
    { id: 1, name: 'Corp Network' },
    { id: 2, name: 'Remote Office' },
  ]
  assert.equal(findIpRestrictionByName(restrictions, 'corp network')?.id, 1)
  assert.equal(findIpRestrictionByName(restrictions, 'REMOTE OFFICE')?.id, 2)
  assert.equal(findIpRestrictionByName(restrictions, 'nope'), null)
})

test('restrictionIdOf reads numeric ids and rejects blanks', () => {
  assert.equal(restrictionIdOf({ id: 8 }), 8)
  assert.equal(restrictionIdOf({ id: '3' }), 3)
  assert.equal(restrictionIdOf({}), null)
})

test('buildIpRestrictionCreateBody sends name + range only', () => {
  const spec = extractIpRestrictionSpecs(toItems([good]))[0]
  const body = buildIpRestrictionCreateBody(spec)
  assert.equal(body.name, 'Corp Network')
  assert.equal(body.range, '172.56.23.0/24')
  assert.equal(Object.keys(body).length, 2)
})

test('buildIpRestrictionUpdateBody carries the id and managed fields', () => {
  const spec = extractIpRestrictionSpecs(toItems([{ ...good, range: '192.0.1.0/24' }]))[0]
  const body = buildIpRestrictionUpdateBody(spec, { id: 42, name: 'Corp Network', range: '172.56.23.0/24' })
  assert.equal(body.id, 42)
  assert.equal(body.name, 'Corp Network')
  assert.equal(body.range, '192.0.1.0/24')
})

test('buildIpRestrictionRestoreBody restores prior managed fields', () => {
  const body = buildIpRestrictionRestoreBody({ id: 5, name: 'Old', range: '10.0.0.0/8' })
  assert.equal(body.id, 5)
  assert.equal(body.name, 'Old')
  assert.equal(body.range, '10.0.0.0/8')
})

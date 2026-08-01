import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractGroupSpecs,
  findGroupByName,
  groupIdOf,
  isSynchronizedGroup,
  buildGroupCreateBody,
  buildGroupUpdateBody,
  buildGroupRestoreBody,
  type LiveGroup,
} from '../_shared'
import { recordsFromResponse } from '../../../lib/secretServerApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy / rollback / drift / health apply over the Secret Server REST API via
 * node:https inside secretServerApi, which is impractical to mock here. Tests
 * cover validate.ts and the pure, network-free helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.groupName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { groupName: 'Local Admins', enabled: true, comment: 'admins' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing group name', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_GROUP'))
})

test('validate rejects a name longer than 255 characters', async () => {
  const res = await validate(ctxOf([{ ...good, groupName: 'x'.repeat(256) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NAME_TOO_LONG'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('extractGroupSpecs maps and trims canvas fields', () => {
  const specs = extractGroupSpecs(toItems([{ groupName: '  Local Admins  ', enabled: false }]))
  assert.equal(specs[0].groupName, 'Local Admins')
  assert.equal(specs[0].enabled, false)
})

test('recordsFromResponse parses a paginated envelope and a bare array', () => {
  const env = recordsFromResponse<LiveGroup>(JSON.stringify({ records: [{ id: 1, name: 'A', enabled: true }], total: 1 }))
  assert.equal(env.records.length, 1)
  assert.equal(env.total, 1)
  const arr = recordsFromResponse<LiveGroup>(JSON.stringify([{ id: 2, name: 'B' }]))
  assert.equal(arr.records.length, 1)
  assert.equal(recordsFromResponse('not json').records.length, 0)
})

test('findGroupByName matches case-insensitively', () => {
  const groups: LiveGroup[] = [
    { id: 1, name: 'Local Admins', enabled: true },
    { id: 2, name: 'Auditors', enabled: false },
  ]
  assert.equal(findGroupByName(groups, 'local admins')?.id, 1)
  assert.equal(findGroupByName(groups, 'AUDITORS')?.id, 2)
  assert.equal(findGroupByName(groups, 'nope'), null)
})

test('groupIdOf reads numeric ids and rejects blanks', () => {
  assert.equal(groupIdOf({ id: 8 }), 8)
  assert.equal(groupIdOf({ id: '3' }), 3)
  assert.equal(groupIdOf({}), null)
})

test('isSynchronizedGroup flags directory-synced groups', () => {
  assert.equal(isSynchronizedGroup({ synchronized: true }), true)
  assert.equal(isSynchronizedGroup({ synchronized: false }), false)
  assert.equal(isSynchronizedGroup({}), false)
})

test('buildGroupCreateBody sends name + enabled', () => {
  const spec = extractGroupSpecs(toItems([good]))[0]
  const body = buildGroupCreateBody(spec)
  assert.equal(body.name, 'Local Admins')
  assert.equal(body.enabled, true)
})

test('buildGroupUpdateBody carries the id and managed fields', () => {
  const spec = extractGroupSpecs(toItems([{ ...good, enabled: false }]))[0]
  const body = buildGroupUpdateBody(spec, { id: 42, name: 'Local Admins', enabled: true })
  assert.equal(body.id, 42)
  assert.equal(body.name, 'Local Admins')
  assert.equal(body.enabled, false)
})

test('buildGroupRestoreBody restores prior managed fields', () => {
  const body = buildGroupRestoreBody({ id: 5, name: 'Old', enabled: false })
  assert.equal(body.id, 5)
  assert.equal(body.name, 'Old')
  assert.equal(body.enabled, false)
})

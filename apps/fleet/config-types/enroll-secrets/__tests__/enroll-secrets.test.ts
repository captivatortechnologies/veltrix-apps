import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { normalizeItem, groupByScope, toTeamId } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Fleet REST API via node:https inside fleetApi,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared.ts helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.label ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { label: 'workstations-default', teamId: '', value: 'sup3rSecretEnrollToken' }

test('validate rejects an unsafe label', async () => {
  const res = await validate(ctxOf([{ ...good, label: 'bad/label' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LABEL'))
})

test('validate rejects a non-numeric team id', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: 'prod' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAM_ID'))
})

test('validate rejects an empty secret value', async () => {
  const res = await validate(ctxOf([{ ...good, value: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate warns on a duplicate secret value within the same scope', async () => {
  const res = await validate(ctxOf([good, { ...good, label: 'workstations-backup' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_VALUE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('toTeamId maps blank to undefined (global scope)', () => {
  assert.equal(toTeamId(''), undefined)
  assert.equal(toTeamId('4'), 4)
})

test('groupByScope buckets items by teamId, keeping global (undefined) separate', () => {
  const items = [
    normalizeItem({ ...good, label: 'a', teamId: '1' }),
    normalizeItem({ ...good, label: 'b', teamId: '' }),
    normalizeItem({ ...good, label: 'c', teamId: '1' }),
  ]
  const groups = groupByScope(items)
  assert.equal(groups.size, 2)
  assert.equal(groups.get(1)?.length, 2)
  assert.equal(groups.get(undefined)?.length, 1)
})

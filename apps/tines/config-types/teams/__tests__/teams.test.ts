import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTeamSpecs, buildTeamBody, findTeam } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the Tines REST API via fetch inside tinesApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure
// _shared helpers (extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Security Automation' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid team', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('extractTeamSpecs trims the name', () => {
  const specs = extractTeamSpecs(ctxOf([{ name: '  SOC  ' }]).canvas)
  assert.equal(specs[0].name, 'SOC')
})

test('buildTeamBody returns just the name', () => {
  const body = buildTeamBody({ itemName: 'g', name: 'SOC' })
  assert.deepEqual(body, { name: 'SOC' })
})

test('findTeam matches by name case-insensitively', () => {
  const live = [{ id: 1, name: 'Security Automation' }, { id: 2, name: 'SOC' }]
  assert.equal(findTeam(live, 'soc')?.id, 2)
  assert.equal(findTeam(live, 'missing'), null)
})

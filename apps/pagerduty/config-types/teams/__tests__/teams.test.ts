import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractTeamSpecs, buildTeamBody, teamRestoreBody, findTeam } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure _shared
// helpers (extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Platform SRE', description: 'Owns the platform' }

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
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a team with no description', async () => {
  const res = await validate(ctxOf([{ name: 'NOC' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('extractTeamSpecs trims the name and description', () => {
  const specs = extractTeamSpecs(ctxOf([{ name: '  Platform SRE  ', description: '  Owns it  ' }]).canvas)
  assert.equal(specs[0].name, 'Platform SRE')
  assert.equal(specs[0].description, 'Owns it')
})

test('buildTeamBody sets the type and omits a blank description', () => {
  const body = buildTeamBody({ itemName: 'g', name: 'NOC', description: '' })
  assert.equal(body.type, 'team')
  assert.equal(body.name, 'NOC')
  assert.equal(body.description, undefined)
})

test('teamRestoreBody reconstructs the prior body', () => {
  const body = teamRestoreBody({ id: 'PT1', name: 'Platform SRE', description: 'Owns the platform' })
  assert.equal(body.type, 'team')
  assert.equal(body.name, 'Platform SRE')
  assert.equal(body.description, 'Owns the platform')
})

test('findTeam matches by name case-insensitively', () => {
  const live = [{ id: 'PT1', name: 'Platform SRE' }, { id: 'PT2', name: 'NOC' }]
  assert.equal(findTeam(live, 'platform sre')?.id, 'PT1')
  assert.equal(findTeam(live, 'missing'), null)
})

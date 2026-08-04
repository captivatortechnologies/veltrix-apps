import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractBusinessServiceSpecs,
  buildBusinessServiceBody,
  businessServiceRestoreBody,
  findBusinessService,
  findTeamId,
} from '../_shared'
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

const good = {
  name: 'Self-serve mobile checkout',
  description: 'Checkout service for our mobile clients',
  point_of_contact: 'Jane Doe',
  team: 'SRE Team',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid business service', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a business service with no description, point of contact or team', async () => {
  const res = await validate(ctxOf([{ name: 'Stand-alone node' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('extractBusinessServiceSpecs trims fields and carries the team name', () => {
  const specs = extractBusinessServiceSpecs(
    ctxOf([{ name: '  Checkout  ', point_of_contact: '  Jane Doe  ', team: '  SRE Team  ' }]).canvas,
  )
  assert.equal(specs[0].name, 'Checkout')
  assert.equal(specs[0].pointOfContact, 'Jane Doe')
  assert.equal(specs[0].teamName, 'SRE Team')
})

test('buildBusinessServiceBody omits type, description, point_of_contact and team when blank', () => {
  const body = buildBusinessServiceBody(
    { itemName: 'g', name: 'Checkout', description: '', pointOfContact: '', teamName: '' },
    null,
  )
  assert.equal(body.name, 'Checkout')
  assert.equal((body as Record<string, unknown>).type, undefined)
  assert.equal(body.description, undefined)
  assert.equal(body.point_of_contact, undefined)
  assert.equal(body.team, undefined)
})

test('buildBusinessServiceBody attaches the resolved team id and never sends type', () => {
  const body = buildBusinessServiceBody(
    { itemName: 'g', name: 'Checkout', description: 'desc', pointOfContact: 'Jane Doe', teamName: 'SRE Team' },
    'PT123',
  )
  assert.equal(body.name, 'Checkout')
  assert.equal(body.description, 'desc')
  assert.equal(body.point_of_contact, 'Jane Doe')
  assert.equal(body.team?.id, 'PT123')
  assert.equal((body as Record<string, unknown>).type, undefined)
})

test('businessServiceRestoreBody reconstructs the prior body including its team id', () => {
  const body = businessServiceRestoreBody({
    id: 'PBS1',
    name: 'Checkout',
    description: 'desc',
    point_of_contact: 'Jane Doe',
    team: { id: 'PT123', type: 'team_reference', self: 'https://api.pagerduty.com/teams/PT123' },
  })
  assert.equal(body.name, 'Checkout')
  assert.equal(body.description, 'desc')
  assert.equal(body.point_of_contact, 'Jane Doe')
  assert.equal(body.team?.id, 'PT123')
  assert.equal((body as Record<string, unknown>).type, undefined)
})

test('businessServiceRestoreBody omits team when the prior had none', () => {
  const body = businessServiceRestoreBody({ id: 'PBS1', name: 'Stand-alone node' })
  assert.equal(body.team, undefined)
})

test('findBusinessService matches by name case-insensitively', () => {
  const live = [{ id: 'PBS1', name: 'Self-serve mobile checkout' }, { id: 'PBS2', name: 'Stand-alone node' }]
  assert.equal(findBusinessService(live, 'self-serve mobile checkout')?.id, 'PBS1')
  assert.equal(findBusinessService(live, 'missing'), null)
})

test('findTeamId resolves a team name to its id case-insensitively', () => {
  const teams = [{ id: 'PT1', name: 'SRE Team' }, { id: 'PT2', name: 'Platform' }]
  assert.equal(findTeamId(teams, 'sre team'), 'PT1')
  assert.equal(findTeamId(teams, 'nope'), null)
})

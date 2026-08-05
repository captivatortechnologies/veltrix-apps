import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractGlobalResourceSpecs, buildGlobalResourceBody, findGlobalResource } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'api_base_url', team_id: '1', value: 'https://example.com', read_access: 'TEAM' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid resource', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

test('validate rejects missing name/team/value', async () => {
  const res = await validate(ctxOf([{ name: '', team_id: '', value: '', read_access: 'TEAM' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TEAM'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate rejects an invalid read_access', async () => {
  const res = await validate(ctxOf([{ ...good, read_access: 'EVERYONE' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_READ_ACCESS'))
})

test('validate requires shared_team_slugs when SPECIFIC_TEAMS', async () => {
  const res = await validate(ctxOf([{ ...good, read_access: 'SPECIFIC_TEAMS', shared_team_slugs: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SHARED_TEAMS'))
})

test('validate accepts SPECIFIC_TEAMS with slugs', async () => {
  const res = await validate(ctxOf([{ ...good, read_access: 'SPECIFIC_TEAMS', shared_team_slugs: ['soc-team'] }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate (team, name)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('buildGlobalResourceBody omits folder_id when null and includes shared slugs only for SPECIFIC_TEAMS', () => {
  const spec = {
    itemName: 'i',
    name: 'x',
    teamId: '1',
    folderName: '',
    value: 'v',
    description: '',
    readAccess: 'SPECIFIC_TEAMS',
    sharedTeamSlugs: ['a', 'b'],
  }
  const body = buildGlobalResourceBody(spec, null)
  assert.equal(body.folder_id, undefined)
  assert.deepEqual(body.shared_team_slugs, ['a', 'b'])
})

test('findGlobalResource matches within the declared team only', () => {
  const live = [{ id: 1, team_id: '1', name: 'api_base_url' }]
  assert.equal(findGlobalResource(live, '1', 'api_base_url')?.id, 1)
  assert.equal(findGlobalResource(live, '2', 'api_base_url'), null)
})

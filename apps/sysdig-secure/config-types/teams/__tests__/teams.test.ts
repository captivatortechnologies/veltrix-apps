import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildTeamBody, findTeamByName, isMalformedUserRolesJson, parseUserRoles, splitList } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigTeam } from '../../../lib/sysdigApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'DevOps', description: 'Platform team', theme: '#73A1F7', scopeBy: 'container', enabled: true }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid theme color', async () => {
  const res = await validate(ctxOf([{ ...good, theme: 'blue' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_THEME'))
})

test('validate rejects an invalid scopeBy', async () => {
  const res = await validate(ctxOf([{ ...good, scopeBy: 'namespace' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPE_BY'))
})

test('validate rejects malformed userRolesJson', async () => {
  const res = await validate(ctxOf([{ ...good, userRolesJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_USER_ROLES_JSON'))
})

test('validate accepts a good team', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on more than one default team', async () => {
  const res = await validate(ctxOf([{ ...good, defaultTeam: true }, { ...good, name: 'SRE', defaultTeam: true }]))
  assert.ok(res.warnings.some((w) => w.code === 'MULTIPLE_DEFAULT_TEAMS'))
})

test('parseUserRoles parses a valid array and ignores malformed JSON', () => {
  assert.deepEqual(parseUserRoles('[{"email":"a@x.com","role":"ROLE_TEAM_EDIT"}]'), [{ email: 'a@x.com', role: 'ROLE_TEAM_EDIT' }])
  assert.deepEqual(parseUserRoles('not json'), [])
  assert.deepEqual(parseUserRoles(undefined), [])
})

test('isMalformedUserRolesJson only flags real parse failures', () => {
  assert.equal(isMalformedUserRolesJson(undefined), false)
  assert.equal(isMalformedUserRolesJson('[]'), false)
  assert.equal(isMalformedUserRolesJson('{bad'), true)
})

test('splitList handles arrays and comma/newline strings', () => {
  assert.deepEqual(splitList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(splitList('a, b\nc'), ['a', 'b', 'c'])
})

test('buildTeamBody maps fields plus resolved zoneIds/userRoles', () => {
  const body = buildTeamBody(good, [1, 2], [{ userId: 5, userName: 'a@x.com', role: 'ROLE_TEAM_EDIT' }])
  assert.equal(body.name, 'DevOps')
  assert.equal(body.scopeBy, 'container')
  assert.equal(body.origin, 'SYSDIG')
  assert.deepEqual(body.zoneIds, [1, 2])
  assert.equal(body.userRoles?.[0]?.userId, 5)
})

test('buildTeamBody omits zoneIds when allZones is set', () => {
  const body = buildTeamBody({ ...good, allZones: true }, [], [])
  assert.equal(body.allZones, true)
  assert.equal(body.zoneIds, undefined)
})

test('findTeamByName matches by exact name', () => {
  const teams: SysdigTeam[] = [{ name: 'A' }, { name: 'DevOps', id: 9 }]
  assert.equal(findTeamByName(teams, 'DevOps')?.id, 9)
  assert.equal(findTeamByName(teams, 'missing'), null)
})

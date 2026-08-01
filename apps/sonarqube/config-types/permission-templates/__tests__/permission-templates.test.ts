import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseGroupPermissions,
  templatesFromSearch,
  findTemplate,
  groupPermsFromTemplateGroups,
  reconcileGroupPerms,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the SonarQube Web API via node:http(s), which is
 * impractical to mock here. Tests focus on validate.ts and _shared (pure, network-free).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Veltrix Default', description: 'Org default', projectKeyPattern: 'com\\.veltrix\\..*', groupPermissions: 'developers: user, codeviewer' }

// --- validate ----------------------------------------------------------------

test('validate accepts a well-formed template', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid project-key pattern', async () => {
  const res = await validate(ctxOf([{ ...good, projectKeyPattern: '([unterminated' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PATTERN'))
})

test('validate rejects an unknown permission in a group grant', async () => {
  const res = await validate(ctxOf([{ ...good, groupPermissions: 'developers: superuser' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'UNKNOWN_PERMISSION'))
})

test('validate rejects a malformed group grant line', async () => {
  const res = await validate(ctxOf([{ ...good, groupPermissions: 'developers user' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GRANT'))
})

test('validate warns on a duplicate template name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- parseGroupPermissions ---------------------------------------------------

test('parseGroupPermissions parses, lowercases, dedupes and merges groups', () => {
  const { grants, errors } = parseGroupPermissions('developers: User, codeviewer\ndevelopers: SCAN\n# note\nadmins: admin')
  assert.equal(errors.length, 0)
  const developers = grants.find((g) => g.group === 'developers')
  assert.deepEqual(developers?.permissions, ['codeviewer', 'scan', 'user'])
  assert.deepEqual(grants.find((g) => g.group === 'admins')?.permissions, ['admin'])
})

test('parseGroupPermissions flags bad permission and bad line', () => {
  const a = parseGroupPermissions('devs: nope')
  assert.ok(a.errors.some((e) => e.code === 'UNKNOWN_PERMISSION'))
  const b = parseGroupPermissions('no-colon-here')
  assert.ok(b.errors.some((e) => e.code === 'INVALID_GRANT'))
})

// --- search / template_groups helpers ----------------------------------------

test('templatesFromSearch unwraps envelope and findTemplate matches by name', () => {
  const templates = templatesFromSearch({ permissionTemplates: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] })
  assert.equal(templates.length, 2)
  assert.equal(findTemplate(templates, 'B')?.id, '2')
  assert.equal(findTemplate(templates, 'missing'), null)
})

test('groupPermsFromTemplateGroups maps group name to sorted perms', () => {
  const map = groupPermsFromTemplateGroups({ groups: [{ name: 'developers', permissions: ['user', 'codeviewer'] }] })
  assert.deepEqual(map.get('developers'), ['codeviewer', 'user'])
})

// --- reconcileGroupPerms -----------------------------------------------------

test('reconcileGroupPerms adds missing, removes extra, scoped to declared groups', () => {
  const desired = [{ group: 'developers', permissions: ['user', 'scan'] }]
  const live = new Map<string, string[]>([
    ['developers', ['user', 'codeviewer']], // add scan, remove codeviewer
    ['admins', ['admin']], // undeclared → untouched
  ])
  const { toAdd, toRemove } = reconcileGroupPerms(desired, live)
  assert.deepEqual(toAdd, [{ group: 'developers', permission: 'scan' }])
  assert.deepEqual(toRemove, [{ group: 'developers', permission: 'codeviewer' }])
})

test('reconcileGroupPerms is a no-op when live matches desired', () => {
  const desired = [{ group: 'developers', permissions: ['user'] }]
  const live = new Map<string, string[]>([['developers', ['user']]])
  const { toAdd, toRemove } = reconcileGroupPerms(desired, live)
  assert.equal(toAdd.length, 0)
  assert.equal(toRemove.length, 0)
})

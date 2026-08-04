import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildMapping, buildMappingUpdate, buildMappingFromPrior, resolveGroupId, findMapping, type RunzeroGroupMapping } from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.ssoValue ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { group: 'Viewers', ssoAttribute: 'memberOf', ssoValue: 'CN=Viewers,OU=Groups,DC=corp', description: 'Viewer group' }

// --- validate -------------------------------------------------------------

test('validate requires group, attribute and value', async () => {
  const res = await validate(ctxOf([{ group: '', ssoAttribute: '', ssoValue: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_GROUP'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ATTRIBUTE'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_VALUE'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid mapping', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (attribute, value) pair', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_MAPPING'))
})

test('validate does not confuse different values for the same attribute', async () => {
  const res = await validate(ctxOf([good, { ...good, ssoValue: 'CN=Admins,OU=Groups,DC=corp' }]))
  assert.ok(!res.warnings.some((w) => w.code === 'DUPLICATE_MAPPING'))
})

// --- _shared helpers ------------------------------------------------------

test('resolveGroupId matches by name and falls back to a raw id', () => {
  const groups = [{ id: 'g-1', name: 'Viewers' }]
  assert.equal(resolveGroupId(groups, 'Viewers'), 'g-1')
  assert.equal(resolveGroupId(groups, 'g-explicit'), 'g-explicit')
})

test('findMapping matches the (attribute, value) pair exactly (case-sensitive)', () => {
  const mappings: RunzeroGroupMapping[] = [{ id: 'm-1', sso_attribute: 'memberOf', sso_value: 'CN=Viewers' }]
  assert.equal(findMapping(mappings, 'memberOf', 'CN=Viewers')?.id, 'm-1')
  assert.equal(findMapping(mappings, 'memberOf', 'cn=viewers'), null)
  assert.equal(findMapping(mappings, '', ''), null)
})

test('buildMapping omits id on create', () => {
  const body = buildMapping(good, 'g-1')
  assert.ok(!('id' in body))
  assert.equal(body.group_id, 'g-1')
  assert.equal(body.sso_attribute, 'memberOf')
})

test('buildMappingUpdate embeds the id', () => {
  const body = buildMappingUpdate('m-1', good, 'g-1')
  assert.equal(body.id, 'm-1')
  assert.equal(body.sso_value, good.ssoValue)
})

test('buildMappingFromPrior restores a recorded mapping', () => {
  const prior: RunzeroGroupMapping = { id: 'm-1', group_id: 'g-1', sso_attribute: 'memberOf', sso_value: 'CN=Viewers', description: 'd' }
  const body = buildMappingFromPrior('m-1', prior)
  assert.deepEqual(body, { id: 'm-1', group_id: 'g-1', sso_attribute: 'memberOf', sso_value: 'CN=Viewers', description: 'd' })
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreatePermissionCommand, buildModifyPermissionCommand, buildDeletePermissionCommand, parsePermissions } from '../../../lib/gmp/permissions'
import { extractSpecs } from '../_shared'

// The deploy/rollback/health/drift handlers talk to gvmd over a live TLS
// socket, which cannot be mocked here (house convention). These tests exercise
// validate.ts, _shared.ts and the GMP command assembly + response parsing.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'get_tasks', subjectType: 'user', subjectId: '66abe5ce-1234-4a5b-8c9d-0123456789ab' }

test('validate rejects a missing command name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid subject type', async () => {
  const res = await validate(ctxOf([{ ...good, subjectType: 'team' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SUBJECT_TYPE'))
})

test('validate rejects a non-UUID subject id', async () => {
  const res = await validate(ctxOf([{ ...good, subjectId: 'nope' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SUBJECT'))
})

test('validate requires a resource type when a resource id is declared', async () => {
  const res = await validate(ctxOf([{ ...good, resourceId: 'b493b7a8-0001-0000-0000-000000000001' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RESOURCE_TYPE'))
})

test('validate accepts a good global permission', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a good resource-scoped permission', async () => {
  const res = await validate(ctxOf([{ ...good, resourceId: 'b493b7a8-0001-0000-0000-000000000001', resourceType: 'task' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- command builders --------------------------------------------------------

test('buildCreatePermissionCommand nests subject and optional resource', () => {
  const xml = buildCreatePermissionCommand({ name: 'get_targets', subjectId: 'sub-1', subjectType: 'user', resourceId: 'res-1', resourceType: 'target' })
  assert.ok(xml.includes('<name>get_targets</name>'))
  assert.ok(xml.includes('<subject id="sub-1"><type>user</type></subject>'))
  assert.ok(xml.includes('<resource id="res-1"><type>target</type></resource>'))
})

test('buildCreatePermissionCommand omits resource when not declared', () => {
  const xml = buildCreatePermissionCommand({ name: 'get_targets', subjectId: 'sub-1', subjectType: 'user' })
  assert.ok(!xml.includes('<resource'))
})

test('buildModifyPermissionCommand targets by permission_id', () => {
  const xml = buildModifyPermissionCommand('p1', { name: 'Super', subjectId: 's1', subjectType: 'role' })
  assert.ok(xml.startsWith('<modify_permission permission_id="p1">'))
  assert.ok(xml.includes('<subject id="s1"><type>role</type></subject>'))
})

test('buildDeletePermissionCommand sets ultimate', () => {
  assert.equal(buildDeletePermissionCommand('p1', true), '<delete_permission permission_id="p1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parsePermissions extracts subject and resource refs', () => {
  const xml = `<get_permissions_response><permission id="p1">
    <name>get_targets</name>
    <subject id="sub-1"><type>user</type><name>alice</name></subject>
    <resource id="res-1"><type>target</type><name>Prod</name></resource>
  </permission></get_permissions_response>`
  const [p] = parsePermissions(xml)
  assert.equal(p.subjectId, 'sub-1')
  assert.equal(p.subjectType, 'user')
  assert.equal(p.resourceId, 'res-1')
  assert.equal(p.resourceType, 'target')
})

test('parsePermissions handles a global permission with no resource', () => {
  const xml = '<get_permissions_response><permission id="p1"><name>Super</name><subject id="sub-1"><type>role</type></subject></permission></get_permissions_response>'
  const [p] = parsePermissions(xml)
  assert.equal(p.resourceId, '')
})

// --- _shared helpers -----------------------------------------------------------

test('extractSpecs uses the canvas item id as itemId', () => {
  const items = [{ id: 'abc123', name: 'unused', fields: good }]
  const [spec] = extractSpecs(items)
  assert.equal(spec.itemId, 'abc123')
  assert.equal(spec.name, 'get_tasks')
})

test('extractSpecs falls back to item.name when id is absent', () => {
  const items = [{ name: 'fallback-name', fields: good }]
  const [spec] = extractSpecs(items)
  assert.equal(spec.itemId, 'fallback-name')
})

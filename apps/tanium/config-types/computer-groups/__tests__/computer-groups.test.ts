import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildGroupBody,
  restoreGroupBody,
  computerSpecsOf,
  groupModeOf,
  createResourceFor,
  parseFilterJson,
  groupsFromList,
  groupFromResponse,
  findGroup,
  unwrapData,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the Tanium REST v2 API via node:https inside
 * taniumApi, which is impractical to mock here. Tests focus on validate.ts and the
 * pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Windows Endpoints', filterText: 'Operating System contains Windows', comment: 'all windows hosts' }

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a group with no filter at all', async () => {
  const res = await validate(ctxOf([{ name: 'Empty', filterText: '', filterJson: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_FILTER'))
})

test('validate accepts a group with only a structured filter JSON', async () => {
  const res = await validate(ctxOf([{ name: 'Linux', filterJson: '{"and_flag":true}' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects invalid structured filter JSON', async () => {
  const res = await validate(ctxOf([{ name: 'Broken', filterJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_FILTER_JSON'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a good filter-expression group', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- validate (manual mode) --------------------------------------------------

test('validate rejects a manual group with no members', async () => {
  const res = await validate(ctxOf([{ name: 'Empty Manual', mode: 'manual' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'NO_MEMBERS'))
})

test('validate ignores filter fields for a manual group', async () => {
  // A manual group with no filterText/filterJson must NOT trigger NO_FILTER —
  // that check only applies in filter mode.
  const res = await validate(ctxOf([{ name: 'Servers', mode: 'manual', computerNames: ['db01'] }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a manual group with only IP addresses', async () => {
  const res = await validate(ctxOf([{ name: 'ByIp', mode: 'manual', ipAddresses: ['10.0.0.1', '10.0.0.2'] }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared ----------------------------------------------------------------

test('buildGroupBody maps filterText to the group text field', () => {
  const body = buildGroupBody(good)
  assert.equal(body.name, 'Windows Endpoints')
  assert.equal(body.text, 'Operating System contains Windows')
  assert.equal(body.filters, undefined)
})

test('buildGroupBody attaches a parsed structured filter', () => {
  const body = buildGroupBody({ name: 'Linux', filterJson: '{"and_flag":true}' })
  assert.equal(body.name, 'Linux')
  assert.deepEqual(body.filters, { and_flag: true })
})

test('parseFilterJson reports invalid JSON', () => {
  assert.ok(parseFilterJson('{bad').error)
  assert.equal(parseFilterJson('').value, undefined)
  assert.deepEqual(parseFilterJson('[]').value, [])
})

test('parseFilterJson rejects a non-object root', () => {
  assert.ok(parseFilterJson('42').error)
})

test('unwrapData unwraps a { data } envelope', () => {
  assert.deepEqual(unwrapData({ data: { id: 1 } }), { id: 1 })
  assert.deepEqual(unwrapData({ id: 1 }), { id: 1 })
})

test('groupsFromList unwraps a { data: [...] } list', () => {
  const groups = groupsFromList({ data: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] })
  assert.equal(groups.length, 2)
  assert.equal(groups[1].name, 'B')
})

test('groupFromResponse unwraps a single group envelope', () => {
  const g = groupFromResponse({ data: { id: 7, name: 'One' } })
  assert.equal(g?.id, 7)
})

test('findGroup matches by name case-insensitively', () => {
  const groups = [{ id: 1, name: 'Windows Endpoints' }, { id: 2, name: 'Linux' }]
  assert.equal(findGroup(groups, 'windows endpoints')?.id, 1)
  assert.equal(findGroup(groups, 'macOS'), null)
})

// --- _shared (manual mode) ---------------------------------------------------

test('groupModeOf defaults to filter when mode is absent', () => {
  assert.equal(groupModeOf({}), 'filter')
  assert.equal(groupModeOf({ mode: 'manual' }), 'manual')
  assert.equal(groupModeOf({ mode: 'bogus' }), 'filter')
})

test('createResourceFor routes manual to computer_groups and filter to groups', () => {
  assert.equal(createResourceFor('manual'), 'computer_groups')
  assert.equal(createResourceFor('filter'), 'groups')
})

test('computerSpecsOf builds computer_name entries before ip_address entries', () => {
  const specs = computerSpecsOf({ computerNames: ['web01', 'web02'], ipAddresses: ['10.0.0.5'] })
  assert.deepEqual(specs, [
    { computer_name: 'web01' },
    { computer_name: 'web02' },
    { ip_address: '10.0.0.5' },
  ])
})

test('buildGroupBody builds computer_specs for manual mode and ignores filter fields', () => {
  const body = buildGroupBody({ name: 'Servers', mode: 'manual', computerNames: ['db01'], filterText: 'ignored' })
  assert.equal(body.name, 'Servers')
  assert.deepEqual(body.computer_specs, [{ computer_name: 'db01' }])
  assert.equal(body.text, undefined)
})

test('restoreGroupBody detects manual mode from a non-empty computer_specs list', () => {
  const body = restoreGroupBody({ name: 'Servers', computer_specs: [{ computer_name: 'db01' }] })
  assert.deepEqual(body, { name: 'Servers', computer_specs: [{ computer_name: 'db01' }] })
})

test('restoreGroupBody falls back to filter shape when computer_specs is empty or absent', () => {
  assert.deepEqual(restoreGroupBody({ name: 'Linux', text: 'OS contains Linux' }), { name: 'Linux', text: 'OS contains Linux' })
  assert.deepEqual(restoreGroupBody({ name: 'Empty', computer_specs: [] }), { name: 'Empty' })
})

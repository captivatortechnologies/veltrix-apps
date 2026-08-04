import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { buildCreateGroupCommand, buildModifyGroupCommand, buildDeleteGroupCommand, parseGroups } from '../../../lib/gmp/groups'
import { buildGroupInput, findGroupByName } from '../_shared'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}
const good = { name: 'Managers', users: ['sarah', 'bob'], comment: 'ops' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate group name', async () => {
  const res = await validate(ctxOf([good, { ...good, comment: 'other' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

// --- command builders --------------------------------------------------------

test('buildCreateGroupCommand joins users and emits specials/full', () => {
  const xml = buildCreateGroupCommand({ name: 'Managers', users: ['sarah', 'bob'], specialsFull: true })
  assert.ok(xml.includes('<users>sarah, bob</users>'))
  assert.ok(xml.includes('<specials><full/></specials>'))
})

test('buildCreateGroupCommand omits specials when not set', () => {
  const xml = buildCreateGroupCommand({ name: 'Managers' })
  assert.ok(!xml.includes('<specials>'))
})

test('buildModifyGroupCommand never includes specials (create-only)', () => {
  const xml = buildModifyGroupCommand('g1', { name: 'Renamed', users: ['sarah'] })
  assert.equal(xml, '<modify_group group_id="g1"><name>Renamed</name><users>sarah</users></modify_group>')
})

test('buildDeleteGroupCommand sets ultimate', () => {
  assert.equal(buildDeleteGroupCommand('g1', true), '<delete_group group_id="g1" ultimate="1"/>')
})

// --- response parsing ---------------------------------------------------------

test('parseGroups extracts users list and specialsFull', () => {
  const xml = `<get_groups_response><group id="g1"><name>Managers</name><users>sarah, bob</users><specials><full/></specials></group></get_groups_response>`
  const [g] = parseGroups(xml)
  assert.deepEqual(g.users, ['sarah', 'bob'])
  assert.equal(g.specialsFull, true)
})

test('parseGroups defaults specialsFull to false when absent', () => {
  const [g] = parseGroups('<get_groups_response><group id="g1"><name>Managers</name></group></get_groups_response>')
  assert.equal(g.specialsFull, false)
})

// --- _shared helpers -----------------------------------------------------------

test('buildGroupInput accepts a comma-separated users string too', () => {
  const input = buildGroupInput({ name: 'Managers', users: 'sarah, bob' })
  assert.deepEqual(input.users, ['sarah', 'bob'])
})

test('findGroupByName matches on the trimmed name', () => {
  const groups = parseGroups('<get_groups_response><group id="g1"><name>Managers</name></group></get_groups_response>')
  assert.equal(findGroupByName(groups, 'Managers')?.id, 'g1')
  assert.equal(findGroupByName(groups, 'Nope'), null)
})

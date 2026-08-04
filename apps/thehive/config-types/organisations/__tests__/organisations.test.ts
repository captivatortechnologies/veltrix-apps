import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrganisationCreateBody,
  buildOrganisationUpdateBody,
  toOrganisationUpdate,
  findOrganisation,
  organisationId,
  normalizeSharingRule,
  organisationsFromList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift apply over the TheHive REST API (node:https inside
 * thehiveApi), impractical to mock here. Tests cover validate.ts and the pure
 * network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'soc-eu', description: 'EU SOC tenant', taskRule: 'manual', observableRule: 'autoShare', locked: false }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...good, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects an invalid sharing rule', async () => {
  const res = await validate(ctxOf([{ ...good, taskRule: 'nonsense' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TASK_RULE'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good organisation', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('normalizeSharingRule falls back to manual', () => {
  assert.equal(normalizeSharingRule('autoShare'), 'autoShare')
  assert.equal(normalizeSharingRule('bogus'), 'manual')
  assert.equal(normalizeSharingRule(undefined), 'manual')
})

test('buildOrganisationCreateBody includes name/description and normalised rules', () => {
  const body = buildOrganisationCreateBody(good)
  assert.equal(body.name, 'soc-eu')
  assert.equal(body.description, 'EU SOC tenant')
  assert.equal(body.taskRule, 'manual')
  assert.equal(body.observableRule, 'autoShare')
  assert.equal(body.locked, false)
})

test('buildOrganisationUpdateBody omits name', () => {
  const body = buildOrganisationUpdateBody(good)
  assert.ok(!('name' in body))
  assert.equal(body.description, 'EU SOC tenant')
})

test('toOrganisationUpdate maps a live organisation to its mutable subset', () => {
  const body = toOrganisationUpdate({ _id: 'abc', name: 'x', description: 'D', taskRule: 'manual', observableRule: 'manual', locked: true })
  assert.deepEqual(body, { description: 'D', taskRule: 'manual', observableRule: 'manual', locked: true })
})

test('findOrganisation matches by name; organisationId prefers _id then id', () => {
  const live = [{ _id: 'abc', name: 'soc-eu' }, { id: 5, name: 'soc-us' }]
  assert.equal(organisationId(findOrganisation(live, 'soc-eu')), 'abc')
  assert.equal(organisationId(findOrganisation(live, 'soc-us')), '5')
  assert.equal(findOrganisation(live, 'nope'), null)
})

test('organisationsFromList unwraps arrays and wrapped rows', () => {
  assert.equal(organisationsFromList([{ name: 'a' }]).length, 1)
  assert.equal(organisationsFromList({ data: [{ name: 'a' }] }).length, 1)
  assert.equal(organisationsFromList(null).length, 0)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import {
  normalizeSetting,
  parseIdList,
  toStringMap,
  desiredFromItem,
  buildConfigBody,
  configBodyChanges,
  restoreBody,
  type CodeSecurityConfiguration,
} from '../_shared'

/**
 * Deploy/rollback/drift apply over the GitHub REST API via fetch, which is
 * impractical to mock here. Tests focus on validate.ts and _shared.ts, which are
 * pure and network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  org: 'octo-org',
  name: 'Baseline',
  description: 'Org baseline',
  advanced_security: 'enabled',
  secret_scanning: 'enabled',
  secret_scanning_push_protection: 'enabled',
  dependency_graph: 'enabled',
  dependabot_alerts: 'enabled',
  dependabot_security_updates: 'enabled',
  code_scanning_default_setup: 'enabled',
  private_vulnerability_reporting: 'not_set',
  enforcement: 'enforced',
  attach_scope: 'all',
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing org and name', async () => {
  const res = await validate(ctxOf([{ ...good, org: '', name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ORG'))
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate accepts a good configuration', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate (org, name)', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_CONFIGURATION'))
})

test('validate warns when push protection has no secret scanning', async () => {
  const res = await validate(ctxOf([{ ...good, secret_scanning: 'disabled', secret_scanning_push_protection: 'enabled' }]))
  assert.ok(res.warnings.some((w) => w.code === 'PUSH_PROTECTION_WITHOUT_SECRET_SCANNING'))
})

test('validate warns when security updates has no alerts', async () => {
  const res = await validate(ctxOf([{ ...good, dependabot_alerts: 'disabled', dependabot_security_updates: 'enabled' }]))
  assert.ok(res.warnings.some((w) => w.code === 'UPDATES_WITHOUT_ALERTS'))
})

test('validate warns when selected scope has no ids', async () => {
  const res = await validate(ctxOf([{ ...good, attach_scope: 'selected', selected_repository_ids: '' }]))
  assert.ok(res.warnings.some((w) => w.code === 'SELECTED_WITHOUT_IDS'))
})

// --- _shared ----------------------------------------------------------------

test('normalizeSetting keeps known values and drops others', () => {
  assert.equal(normalizeSetting('Enabled'), 'enabled')
  assert.equal(normalizeSetting('not_set'), 'not_set')
  assert.equal(normalizeSetting('bogus'), '')
  assert.equal(normalizeSetting(''), '')
})

test('parseIdList extracts positive integer ids', () => {
  assert.deepEqual(parseIdList('1, 2  3\n4'), [1, 2, 3, 4])
  assert.deepEqual(parseIdList('1, -2, x, 0, 5'), [1, 5])
  assert.deepEqual(parseIdList(''), [])
})

test('toStringMap reads an object and a JSON string', () => {
  assert.deepEqual(toStringMap({ a: 'enabled', b: 1 }), { a: 'enabled', b: '1' })
  assert.deepEqual(toStringMap('{"c":"disabled"}'), { c: 'disabled' })
  assert.deepEqual(toStringMap('not json'), {})
})

test('desiredFromItem reads identity, features, enforcement and attach', () => {
  const d = desiredFromItem({ ...good, attach_scope: 'selected', selected_repository_ids: '10 20' })
  assert.equal(d.org, 'octo-org')
  assert.equal(d.name, 'Baseline')
  assert.equal(d.features.advanced_security, 'enabled')
  assert.equal(d.enforcement, 'enforced')
  assert.equal(d.attachScope, 'selected')
  assert.deepEqual(d.selectedRepositoryIds, [10, 20])
})

test('desiredFromItem maps attach scope "none" to no attach', () => {
  assert.equal(desiredFromItem({ ...good, attach_scope: 'none' }).attachScope, '')
})

test('buildConfigBody includes name, enforcement and explicit features; explicit wins over additional', () => {
  const d = desiredFromItem({ ...good, additional_settings: { advanced_security: 'disabled', secret_scanning_validity_checks: 'enabled' } })
  const body = buildConfigBody(d)
  assert.equal(body.name, 'Baseline')
  assert.equal(body.enforcement, 'enforced')
  assert.equal(body.advanced_security, 'enabled') // explicit select wins over additional
  assert.equal(body.secret_scanning_validity_checks, 'enabled') // extra key passes through
})

test('configBodyChanges returns only fields that differ from live', () => {
  const d = desiredFromItem(good)
  const live: CodeSecurityConfiguration = {
    id: 5,
    name: 'Baseline',
    description: 'Org baseline',
    advanced_security: 'enabled',
    secret_scanning: 'disabled', // differs (desired enabled)
    enforcement: 'enforced',
  }
  const changes = configBodyChanges(d, live)
  assert.equal(changes.secret_scanning, 'enabled')
  assert.equal(changes.advanced_security, undefined) // unchanged, omitted
  assert.equal(changes.name, undefined) // unchanged, omitted
})

test('restoreBody reconstructs a PATCH body from a prior configuration', () => {
  const body = restoreBody({ id: 5, name: 'Baseline', description: 'x', enforcement: 'unenforced', secret_scanning: 'disabled' })
  assert.equal(body.name, 'Baseline')
  assert.equal(body.enforcement, 'unenforced')
  assert.equal(body.secret_scanning, 'disabled')
})

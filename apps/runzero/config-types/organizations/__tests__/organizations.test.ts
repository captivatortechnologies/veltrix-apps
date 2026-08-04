import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrgOptions,
  buildOrgOptionsFromPrior,
  findOrg,
  dayCount,
  parseExpirationSettings,
  deepEqualJson,
  type RunzeroOrganization,
} from '../_shared'
import { coerceList } from '../../../lib/runzeroApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * deploy/rollback/drift/health hit the runZero console API via fetch, which is impractical to
 * mock here. Tests focus on validate.ts and the network-free _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Acme Corp', description: 'Main tenant', expirationAssetsStaleDays: 365 }

// --- validate -------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid organization', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate warns on a suspect parent id', async () => {
  const res = await validate(ctxOf([{ ...good, parentId: 'not-a-uuid' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SUSPECT_PARENT_ID'))
})

test('validate errors on malformed expiration settings JSON', async () => {
  const res = await validate(ctxOf([{ ...good, expirationSettingsJson: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_JSON'))
})

test('validate accepts well-formed expiration settings JSON', async () => {
  const res = await validate(ctxOf([{ ...good, expirationSettingsJson: '{"attributes": 7}' }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- _shared helpers ------------------------------------------------------

test('dayCount coerces blanks to undefined and negatives are rejected', () => {
  assert.equal(dayCount(''), undefined)
  assert.equal(dayCount(null), undefined)
  assert.equal(dayCount(365), 365)
  assert.equal(dayCount('30'), 30)
  assert.equal(dayCount(-1), undefined)
})

test('parseExpirationSettings parses JSON and rejects malformed input', () => {
  assert.deepEqual(parseExpirationSettings('{"attributes": 7}'), { attributes: 7 })
  assert.equal(parseExpirationSettings(''), null)
  assert.equal(parseExpirationSettings('{bad'), null)
})

test('deepEqualJson ignores key order', () => {
  assert.equal(deepEqualJson({ a: 1, b: 2 }, { b: 2, a: 1 }), true)
  assert.equal(deepEqualJson({ a: 1 }, { a: 2 }), false)
})

test('buildOrgOptions maps fields and omits blank optional keys', () => {
  const opts = buildOrgOptions({ name: '  Acme  ', description: '  d  ', expirationAssetsStaleDays: 365 })
  assert.deepEqual(opts, { name: 'Acme', description: 'd', expiration_assets_stale: '365' })
})

test('buildOrgOptions includes parentId and expiration settings JSON when set', () => {
  const opts = buildOrgOptions({
    name: 'Acme',
    parentId: 'e77602e0-3fb8-4734-aef9-fbc6fdcb0fa8',
    expirationSettingsJson: '{"attributes":7}',
  })
  assert.equal(opts.parent_id, 'e77602e0-3fb8-4734-aef9-fbc6fdcb0fa8')
  assert.equal(opts.expiration_settings, '{"attributes":7}')
})

test('buildOrgOptionsFromPrior restores a recorded organization', () => {
  const prior: RunzeroOrganization = {
    id: 'org-1',
    name: 'Acme',
    description: 'd',
    expiration_assets_stale: 365,
    expiration_settings: { attributes: 7 },
  }
  const opts = buildOrgOptionsFromPrior(prior)
  assert.equal(opts.name, 'Acme')
  assert.equal(opts.expiration_assets_stale, '365')
  assert.equal(opts.expiration_settings, '{"attributes":7}')
})

test('findOrg matches by name case-insensitively', () => {
  const orgs = [{ id: '1', name: 'Acme Corp' }, { id: '2', name: 'Widgets Inc' }]
  assert.equal(findOrg(orgs, 'acme corp')?.id, '1')
  assert.equal(findOrg(orgs, 'WIDGETS INC')?.id, '2')
  assert.equal(findOrg(orgs, 'nope'), null)
})

test('coerceList accepts a bare array and a { data } envelope', () => {
  assert.equal(coerceList([{ id: '1' }]).length, 1)
  assert.equal(coerceList({ data: [{ id: '1' }, { id: '2' }] }).length, 2)
  assert.equal(coerceList(null).length, 0)
})

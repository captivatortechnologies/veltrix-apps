import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  normalizeNetwork,
  parseRecipients,
  readActivationFields,
  isActiveAt,
  isPending,
  activatePath,
  statusPath,
  type ActivationStatus,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Network Lists API through fetch,
 * which is impractical to mock here, so tests focus on validate.ts and the pure
 * _shared helpers — especially the idempotency logic (isActiveAt / isPending)
 * that decides whether an activation is triggered. The EdgeGrid signer is
 * covered in lib/__tests__/akamaiApi.test.ts.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.networkListName ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { networkListName: 'Corp blocklist', network: 'STAGING', comments: 'go live', notificationRecipients: ['ops@example.com'] }

// --- validate ---------------------------------------------------------------

test('validate accepts a good activation item', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
})

test('validate rejects a missing list name', async () => {
  const res = await validate(ctxOf([{ ...good, networkListName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an unknown environment', async () => {
  const res = await validate(ctxOf([{ ...good, network: 'DEV' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NETWORK'))
})

test('validate rejects a malformed notification email', async () => {
  const res = await validate(ctxOf([{ ...good, notificationRecipients: ['not-an-email'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_EMAIL'))
})

test('validate warns on the same list + environment twice', async () => {
  const res = await validate(ctxOf([good, { ...good, network: 'staging' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_TARGET'))
})

test('validate allows the same list on both environments', async () => {
  const res = await validate(ctxOf([good, { ...good, network: 'PRODUCTION' }]))
  assert.equal(res.valid, true, JSON.stringify(res.errors))
  assert.equal(res.warnings.filter((w) => w.code === 'DUPLICATE_TARGET').length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('normalizeNetwork coerces to STAGING/PRODUCTION with STAGING as the default', () => {
  assert.equal(normalizeNetwork('production'), 'PRODUCTION')
  assert.equal(normalizeNetwork('STAGING'), 'STAGING')
  assert.equal(normalizeNetwork('nonsense'), 'STAGING')
})

test('parseRecipients splits, trims and de-dupes (case-insensitive) email lists', () => {
  assert.deepEqual(parseRecipients('a@x.com\nb@x.com, a@X.com'), ['a@x.com', 'b@x.com'])
  assert.deepEqual(parseRecipients(['ops@x.com', ' ops@x.com ']), ['ops@x.com'])
  assert.deepEqual(parseRecipients(''), [])
})

test('readActivationFields normalizes an item', () => {
  assert.deepEqual(readActivationFields(good), {
    networkListName: 'Corp blocklist',
    network: 'STAGING',
    comments: 'go live',
    recipients: ['ops@example.com'],
  })
})

test('isActiveAt is true only when ACTIVE and the activated syncPoint is current', () => {
  const active: ActivationStatus = { activationStatus: 'ACTIVE', syncPoint: 5 }
  assert.equal(isActiveAt(active, 5), true) // exactly current
  assert.equal(isActiveAt(active, 6), false) // edits pending (list bumped to 6)
  assert.equal(isActiveAt({ activationStatus: 'MODIFIED', syncPoint: 5 }, 5), false)
  assert.equal(isActiveAt({ activationStatus: 'INACTIVE' }, 0), false)
  assert.equal(isActiveAt(null, 0), false)
})

test('isPending is true for in-flight activations/deactivations', () => {
  assert.equal(isPending({ activationStatus: 'PENDING_ACTIVATION' }), true)
  assert.equal(isPending({ activationStatus: 'PENDING_DEACTIVATION' }), true)
  assert.equal(isPending({ activationStatus: 'ACTIVE' }), false)
  assert.equal(isPending(null), false)
})

test('activatePath / statusPath build the environment-scoped endpoints', () => {
  assert.equal(activatePath('12345_LIST', 'STAGING'), '/network-list/v2/network-lists/12345_LIST/environments/STAGING/activate')
  assert.equal(statusPath('12345_LIST', 'PRODUCTION'), '/network-list/v2/network-lists/12345_LIST/environments/PRODUCTION/status')
})

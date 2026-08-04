import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  SCALAR_SETTING_GROUPS,
  buildScalarGroupRequest,
  scalarGroupFromReply,
  parseActionCenterExpiration,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Cortex XDR REST API via fetch,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers (request building + reply parsing) — both network-free.
 */
function ctxOf(fieldsList: Array<Record<string, unknown>>): PipelineContext {
  const items = fieldsList.map((fields, i) => ({ id: `i${i}`, name: `item-${i}`, fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = {
  enable_bandwidth_control: true,
  bandwidth_in_mbps: 500,
  enable_minor_content_version_updates: true,
  license_revocation_after_lost_connection: 30,
  agent_deletion_retention: 180,
  amount_of_parallel_upgrades: 20,
  time_interval_hours: 24,
  action_center_expiration: { isolate: '24' },
}

// --- validate -----------------------------------------------------------------

test('validate accepts well-formed settings', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there is no item', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects more than one item (singleton)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SINGLETON'))
})

test('validate rejects an out-of-range bandwidth', async () => {
  const res = await validate(ctxOf([{ ...good, bandwidth_in_mbps: 10 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_BANDWIDTH'))
})

test('validate rejects an out-of-range license revocation period', async () => {
  const res = await validate(ctxOf([{ ...good, license_revocation_after_lost_connection: 1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_LICENSE_REVOCATION'))
})

test('validate warns when retention is not greater than revocation', async () => {
  const res = await validate(ctxOf([{ ...good, license_revocation_after_lost_connection: 40, agent_deletion_retention: 30 }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'RETENTION_NOT_GREATER_THAN_REVOCATION'))
})

test('validate rejects an out-of-range parallel-upgrade count', async () => {
  const res = await validate(ctxOf([{ ...good, amount_of_parallel_upgrades: 0 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PARALLEL_UPGRADES'))
})

test('validate rejects an unknown time_interval_hours value', async () => {
  const res = await validate(ctxOf([{ ...good, time_interval_hours: 12 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TIME_INTERVAL'))
})

test('validate rejects a non-positive action_center_expiration value', async () => {
  const res = await validate(ctxOf([{ ...good, action_center_expiration: { isolate: '0' } }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_EXPIRATION'))
})

// --- _shared helpers ----------------------------------------------------------

test('SCALAR_SETTING_GROUPS covers all 9 documented settings', () => {
  assert.equal(SCALAR_SETTING_GROUPS.length, 9)
})

test('buildScalarGroupRequest always includes every declared boolean/int key', () => {
  const group = SCALAR_SETTING_GROUPS.find((g) => g.key === 'content_management')!
  const body = buildScalarGroupRequest(group, good)
  assert.equal(body.enable_bandwidth_control, true)
  assert.equal(body.bandwidth_in_mbps, 500)
  assert.equal(body.enable_minor_content_version_updates, true)
})

test('buildScalarGroupRequest falls back to the documented default when a field is blank', () => {
  const group = SCALAR_SETTING_GROUPS.find((g) => g.key === 'auto_upgrade')!
  const body = buildScalarGroupRequest(group, {})
  assert.equal(body.amount_of_parallel_upgrades, 20)
})

test('scalarGroupFromReply returns the flat object as-is', () => {
  assert.deepEqual(scalarGroupFromReply({ allow_logs_collection: true }), { allow_logs_collection: true })
  assert.deepEqual(scalarGroupFromReply(null), {})
})

test('parseActionCenterExpiration drops non-positive values', () => {
  const parsed = parseActionCenterExpiration({ isolate: '24', quarantine: '0', scan: '-5' })
  assert.deepEqual(parsed, { isolate: 24 })
})

test('parseActionCenterExpiration tolerates an empty map', () => {
  assert.deepEqual(parseActionCenterExpiration(undefined), {})
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { parseScope, buildMdmPatch } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.teamId ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  teamId: 'global',
  enableDiskEncryption: 'yes',
  windowsRequireBitlockerPin: 'no',
  enableRecoveryLockPassword: 'no',
  appleRequireHardwareAttestation: 'no',
  enableEndUserAuthentication: 'no',
  macosMigrationEnabled: 'no',
  windowsEnabledAndConfigured: 'no',
}

test('validate rejects an invalid scope', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: 'prod' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPE'))
})

test('validate accepts a numeric team scope', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: '5' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed deadline', async () => {
  const res = await validate(ctxOf([{ ...good, macosDeadline: '01/01/2025' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DATE'))
})

test('validate warns when a global-only field is set to yes for a team scope', async () => {
  const res = await validate(ctxOf([{ ...good, teamId: '5', enableRecoveryLockPassword: 'yes' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'GLOBAL_ONLY_FIELD_ON_TEAM'))
})

test('validate requires a migration webhook URL when macOS migration is enabled globally', async () => {
  const res = await validate(ctxOf([{ ...good, macosMigrationEnabled: 'yes', macosMigrationWebhookUrl: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_MIGRATION_WEBHOOK'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared.ts -------------------------------------------------------------

test('parseScope maps "global" and blank to undefined, and parses numeric team ids', () => {
  assert.equal(parseScope('global').teamId, undefined)
  assert.equal(parseScope('').teamId, undefined)
  assert.equal(parseScope('7').teamId, 7)
})

test('buildMdmPatch includes global-only fields for the global scope', () => {
  const patch = buildMdmPatch({}, { ...good, appleRequireHardwareAttestation: 'yes' }, { teamId: undefined })
  assert.equal(patch.apple_require_hardware_attestation, true)
})

test('buildMdmPatch omits global-only fields for a team scope', () => {
  const patch = buildMdmPatch({}, { ...good, appleRequireHardwareAttestation: 'yes' }, { teamId: 5 })
  assert.equal(patch.apple_require_hardware_attestation, undefined)
})

test('buildMdmPatch sets macos_updates only when a version or deadline is declared', () => {
  const withDates = buildMdmPatch({}, { ...good, macosMinVersion: '14.0', macosDeadline: '2026-01-01' }, { teamId: undefined })
  assert.deepEqual(withDates.macos_updates, { minimum_version: '14.0', deadline: '2026-01-01' })

  const withoutDates = buildMdmPatch({}, good, { teamId: undefined })
  assert.equal(withoutDates.macos_updates, undefined)
})

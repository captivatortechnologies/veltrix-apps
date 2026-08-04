import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  extractLdapServerSettingsSpecs,
  buildLdapServerBody,
  findLdapServerByName,
  priorFieldsOf,
  type JumpCloudLdapServer,
} from '../_shared'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function canvasOf(list: Array<Record<string, unknown>>): CanvasSnapshot {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { items, sections: items } as unknown as CanvasSnapshot
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: canvasOf(list) } as unknown as PipelineContext
}

const good = { name: 'Corp LDAP', userLockoutAction: 'disable', userPasswordExpirationAction: 'remove' }

// --- validate -----------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects an invalid action value', async () => {
  const res = await validate(ctxOf([{ ...good, userLockoutAction: 'delete' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION'))
})

test('validate warns when both actions are unmanaged', async () => {
  const res = await validate(ctxOf([{ name: 'Corp LDAP', userLockoutAction: '', userPasswordExpirationAction: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_ACTIONS'))
})

test('validate errors on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_NAME'))
})

// --- _shared helpers ----------------------------------------------------------

test('extractLdapServerSettingsSpecs trims fields', () => {
  const [spec] = extractLdapServerSettingsSpecs(canvasOf([{ name: '  Corp LDAP  ', userLockoutAction: ' disable ' }]))
  assert.equal(spec.name, 'Corp LDAP')
  assert.equal(spec.userLockoutAction, 'disable')
  assert.equal(spec.itemId, 'i0')
})

test('buildLdapServerBody sends name always, actions only when set', () => {
  assert.deepEqual(buildLdapServerBody({ name: 'N', userLockoutAction: '', userPasswordExpirationAction: '' }), { name: 'N' })
  assert.deepEqual(
    buildLdapServerBody({ name: 'N', userLockoutAction: 'disable', userPasswordExpirationAction: 'remove' }),
    { name: 'N', user_lockout_action: 'disable', user_password_expiration_action: 'remove' },
  )
})

test('findLdapServerByName matches case-insensitively', () => {
  const servers: JumpCloudLdapServer[] = [{ id: 'a', name: 'Corp LDAP' }]
  assert.equal(findLdapServerByName(servers, 'corp ldap')?.id, 'a')
  assert.equal(findLdapServerByName(servers, 'MISSING'), null)
})

test('priorFieldsOf omits unset actions', () => {
  assert.deepEqual(priorFieldsOf({ id: 'a', name: 'N' }), { name: 'N' })
  assert.deepEqual(priorFieldsOf({ id: 'a', name: 'N', user_lockout_action: 'disable' }), { name: 'N', user_lockout_action: 'disable' })
})

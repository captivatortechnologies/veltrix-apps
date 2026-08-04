import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildRequiredActionRep,
  projectFromFields,
  projectFromLive,
  readOptionalInt,
  WELL_KNOWN_REQUIRED_ACTIONS,
  type KeycloakRequiredActionRep,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The pipeline handlers apply over the Keycloak Admin REST API via node:https,
 * which is impractical to mock here. Tests focus on validate.ts and the pure
 * _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.alias ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { alias: 'UPDATE_PASSWORD', name: 'Update Password', enabled: true, defaultAction: false, priority: 10 }

// --- validate ----------------------------------------------------------------

test('validate rejects a missing alias', async () => {
  const res = await validate(ctxOf([{ ...good, alias: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ALIAS'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate alias', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ALIAS'))
})

test('validate warns (not errors) on an unrecognized alias', async () => {
  const res = await validate(ctxOf([{ ...good, alias: 'custom-my-action' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'UNKNOWN_REQUIRED_ACTION'))
})

test('validate does not warn on a well-known alias', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.ok(!res.warnings.some((w) => w.code === 'UNKNOWN_REQUIRED_ACTION'))
})

test('validate rejects a negative priority', async () => {
  const res = await validate(ctxOf([{ ...good, priority: -1 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PRIORITY'))
})

test('validate accepts a blank priority', async () => {
  const res = await validate(ctxOf([{ ...good, priority: undefined }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('WELL_KNOWN_REQUIRED_ACTIONS includes the documented built-ins', () => {
  assert.ok(WELL_KNOWN_REQUIRED_ACTIONS.has('UPDATE_PASSWORD'))
  assert.ok(WELL_KNOWN_REQUIRED_ACTIONS.has('webauthn-register-passwordless'))
  assert.ok(!WELL_KNOWN_REQUIRED_ACTIONS.has('custom-my-action'))
})

test('readOptionalInt tolerates numeric strings and truncates decimals', () => {
  assert.equal(readOptionalInt('10'), 10)
  assert.equal(readOptionalInt(5.9), 5)
  assert.equal(readOptionalInt(''), undefined)
  assert.equal(readOptionalInt('not-a-number'), undefined)
})

test('buildRequiredActionRep produces a full merged representation', () => {
  const base: KeycloakRequiredActionRep = { alias: 'UPDATE_PASSWORD', providerId: 'UPDATE_PASSWORD', name: 'old' }
  const rep = buildRequiredActionRep(good, base)
  assert.equal(rep.alias, 'UPDATE_PASSWORD')
  assert.equal(rep.providerId, 'UPDATE_PASSWORD')
  assert.equal(rep.name, 'Update Password')
  assert.equal(rep.enabled, true)
  assert.equal(rep.defaultAction, false)
  assert.equal(rep.priority, 10)
})

test('buildRequiredActionRep keeps the prior priority when none is declared', () => {
  const base: KeycloakRequiredActionRep = { alias: 'UPDATE_PASSWORD', priority: 50 }
  const rep = buildRequiredActionRep({ ...good, priority: undefined }, base)
  assert.equal(rep.priority, 50)
})

test('buildRequiredActionRep replaces config authoritatively instead of merging with the base', () => {
  const base: KeycloakRequiredActionRep = { alias: 'UPDATE_PASSWORD', config: { stale: 'value' } }
  const rep = buildRequiredActionRep({ ...good, config: { max_auth_age: '300' } }, base)
  assert.deepEqual(rep.config, { max_auth_age: '300' })
})

test('projectFromFields and projectFromLive agree for an unchanged action', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakRequiredActionRep = {
    alias: 'UPDATE_PASSWORD',
    name: 'Update Password',
    enabled: true,
    defaultAction: false,
    priority: 10,
    config: {},
  }
  assert.deepEqual(projectFromLive(live), fromFields)
})

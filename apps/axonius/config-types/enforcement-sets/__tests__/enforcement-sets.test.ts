import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  parseText,
  parseJsonObject,
  parseJsonArray,
  buildMainAction,
  buildActions,
  buildCreateBody,
  buildUpdateBody,
  buildRestoreBody,
  buildDeleteBody,
  enforcementsFromResponse,
  enforcementFromResponse,
  enforcementId,
  findEnforcement,
  liveActionName,
  getEnforcementResource,
  updateEnforcementResource,
} from '../_shared'
import { apiUrl } from '../../../lib/axoniusApi'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift handlers apply over the Axonius REST API via node:https
 * inside axoniusApi, which is impractical to mock here. Tests cover validate.ts and
 * the pure _shared helpers (identity, body building, JSON:API unwrapping, JSON
 * parsing).
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'Notify on new device',
  action_name: 'create_notification',
  action_label: 'Notify',
  config: '{"description":"new device seen"}',
  triggers: '[]',
}

// --- validate ---------------------------------------------------------------

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing action name', async () => {
  const res = await validate(ctxOf([{ ...good, action_name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACTION_NAME'))
})

test('validate rejects a non-object config', async () => {
  const res = await validate(ctxOf([{ ...good, config: '[1,2,3]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate rejects malformed JSON config', async () => {
  const res = await validate(ctxOf([{ ...good, config: '{not json}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CONFIG'))
})

test('validate rejects non-array triggers', async () => {
  const res = await validate(ctxOf([{ ...good, triggers: '{"period":"daily"}' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TRIGGERS'))
})

test('validate accepts a well-formed set and warns on no trigger', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_TRIGGER'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, action_name: 'tag' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- JSON parsing -----------------------------------------------------------

test('parseJsonObject returns an empty object for a blank value', () => {
  const r = parseJsonObject('')
  assert.deepEqual(r, { ok: true, value: {} })
})

test('parseJsonObject rejects arrays and scalars', () => {
  assert.equal(parseJsonObject('[1]').ok, false)
  assert.equal(parseJsonObject('"x"').ok, false)
})

test('parseJsonArray returns an empty array for a blank value', () => {
  assert.deepEqual(parseJsonArray(''), { ok: true, value: [] })
})

test('parseText trims', () => {
  assert.equal(parseText('  x '), 'x')
  assert.equal(parseText(undefined), '')
})

// --- body building ----------------------------------------------------------

test('buildMainAction produces the verified { name, action:{ action_name, config } } shape', () => {
  const main = buildMainAction('Notify', 'create_notification', { description: 'd' })
  assert.deepEqual(main, { name: 'Notify', action: { action_name: 'create_notification', config: { description: 'd' } } })
})

test('buildActions wraps main and adds empty success/failure/post chains', () => {
  const actions = buildActions(buildMainAction('n', 'a', {}))
  assert.deepEqual(actions.success, [])
  assert.deepEqual(actions.failure, [])
  assert.deepEqual(actions.post, [])
  assert.equal(actions.main?.action?.action_name, 'a')
})

test('buildCreateBody produces an enforcements_schema JSON:API body', () => {
  const body = buildCreateBody({ name: 'n', actions: buildActions(buildMainAction('n', 'a', {})), triggers: [], description: 'd' })
  assert.equal(body.data.type, 'enforcements_schema')
  assert.equal(body.data.attributes.name, 'n')
  assert.equal(body.data.attributes.description, 'd')
})

test('buildUpdateBody carries the uuid in the attributes', () => {
  const body = buildUpdateBody({ uuid: 'u1', name: 'n', actions: buildActions({}), triggers: [] })
  assert.equal(body.data.type, 'enforcements_schema')
  assert.equal(body.data.attributes.uuid, 'u1')
})

test('buildRestoreBody restores prior name/actions/triggers under the uuid', () => {
  const body = buildRestoreBody('u2', { name: 'prior', actions: { main: {} }, triggers: [{ period: 'daily' }] })
  assert.equal(body.data.attributes.uuid, 'u2')
  assert.equal(body.data.attributes.name, 'prior')
  assert.deepEqual(body.data.attributes.triggers, [{ period: 'daily' }])
})

test('buildDeleteBody wraps the uuid in an enforcements_delete_schema value selector', () => {
  const body = buildDeleteBody('u3')
  assert.equal(body.data.type, 'enforcements_delete_schema')
  assert.deepEqual(body.data.attributes.value, { ids: ['u3'], include: true })
})

// --- response unwrapping + identity -----------------------------------------

const listResponse = {
  data: [
    { id: 'e1', type: 'enforcements_details_schema', attributes: { uuid: 'e1', name: 'Notify on new device', actions_main_type: 'create_notification' } },
    { id: 'e2', type: 'enforcements_details_schema', attributes: { uuid: 'e2', name: 'Tag stale', actions_main_type: 'tag' } },
  ],
}

test('enforcementsFromResponse flattens JSON:API rows and carries the uuid', () => {
  const rows = enforcementsFromResponse(listResponse)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].name, 'Notify on new device')
  assert.equal(enforcementId(rows[0]), 'e1')
})

test('findEnforcement matches by name and liveActionName reads the summary type', () => {
  const rows = enforcementsFromResponse(listResponse)
  const match = findEnforcement(rows, 'Tag stale')
  assert.equal(enforcementId(match), 'e2')
  assert.equal(liveActionName(match), 'tag')
  assert.equal(findEnforcement(rows, 'nope'), null)
})

test('enforcementFromResponse flattens a single document with full actions', () => {
  const full = enforcementFromResponse({
    data: { id: 'e1', attributes: { uuid: 'e1', name: 'n', actions: { main: { action: { action_name: 'a' } } }, triggers: [] } },
  })
  assert.equal(full?.name, 'n')
  assert.equal(liveActionName(full), 'a')
})

// --- endpoint construction --------------------------------------------------

test('enforcement resource paths encode the uuid', () => {
  assert.equal(getEnforcementResource('a b'), 'enforcements/a%20b')
  assert.equal(updateEnforcementResource('a b'), 'enforcements/a%20b')
})

test('apiUrl joins base, root and the enforcements resource', () => {
  assert.equal(apiUrl('https://tenant.axonius.com', undefined, 'enforcements'), 'https://tenant.axonius.com/api/enforcements')
})

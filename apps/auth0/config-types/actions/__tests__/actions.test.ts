import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildActionCreateBody,
  buildActionUpdateBody,
  findActionByName,
  liveBindingsToEntries,
  parseDependencies,
  parseDependencyLine,
  parseSecretsAuthored,
  secretNames,
  snapshotAction,
  withActionBound,
  withActionUnbound,
  TRIGGER_DEFAULT_VERSIONS,
  type Auth0Action,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * The deploy/rollback/drift/health handlers apply over the Auth0 Management API
 * via lib/auth0Api (global fetch), which is impractical to mock here. Tests focus
 * on validate.ts and the pure _shared helpers, which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = {
  name: 'enrich-login',
  runtime: 'node22',
  trigger_id: 'post-login',
  code: 'exports.onExecutePostLogin = async (event, api) => {}',
  dependencies: 'lodash@4.17.21',
  secrets: 'API_KEY=super-secret',
  deploy_after_update: true,
  trigger_binding_enabled: true,
}

// --- validate ---------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a name containing < or >', async () => {
  const res = await validate(ctxOf([{ ...good, name: 'bad<name>' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_NAME'))
})

test('validate rejects an unknown runtime', async () => {
  const res = await validate(ctxOf([{ ...good, runtime: 'python3.9' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_RUNTIME'))
})

test('validate rejects an unknown trigger', async () => {
  const res = await validate(ctxOf([{ ...good, trigger_id: 'not-a-trigger' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TRIGGER'))
})

test('validate rejects empty code', async () => {
  const res = await validate(ctxOf([{ ...good, code: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_CODE'))
})

test('validate rejects a malformed dependency line', async () => {
  const res = await validate(ctxOf([{ ...good, dependencies: 'lodash-without-version' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_DEPENDENCY'))
})

test('validate rejects a malformed secret line', async () => {
  const res = await validate(ctxOf([{ ...good, secrets: 'NOT_A_KV_PAIR' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SECRET'))
})

test('validate warns on a duplicate action name', async () => {
  const res = await validate(ctxOf([good, { ...good, code: 'exports.onExecutePostLogin = async () => {}' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good action', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
})

// --- _shared ------------------------------------------------------------------

test('buildActionCreateBody includes name and resolves the trigger default version', () => {
  const body = buildActionCreateBody(good)
  assert.equal(body.name, 'enrich-login')
  assert.deepEqual(body.supported_triggers, [{ id: 'post-login', version: TRIGGER_DEFAULT_VERSIONS['post-login'] }])
  assert.deepEqual(body.dependencies, [{ name: 'lodash', version: '4.17.21' }])
  assert.deepEqual(body.secrets, [{ name: 'API_KEY', value: 'super-secret' }])
})

test('buildActionUpdateBody omits name', () => {
  const body = buildActionUpdateBody(good) as Record<string, unknown>
  assert.equal('name' in body, false)
})

test('an explicit trigger_version overrides the curated default', () => {
  const body = buildActionCreateBody({ ...good, trigger_version: 'v99' })
  assert.deepEqual(body.supported_triggers, [{ id: 'post-login', version: 'v99' }])
})

test('parseDependencyLine parses name@version and rejects malformed lines', () => {
  assert.deepEqual(parseDependencyLine('lodash@4.17.21'), { name: 'lodash', version: '4.17.21' })
  assert.equal(parseDependencyLine('lodash'), null)
  assert.equal(parseDependencyLine(''), null)
})

test('parseDependencies parses every non-blank line', () => {
  assert.deepEqual(parseDependencies('lodash@4.17.21\naxios@1.6.0'), [
    { name: 'lodash', version: '4.17.21' },
    { name: 'axios', version: '1.6.0' },
  ])
})

test('parseSecretsAuthored splits on the first = and de-duplicates by name', () => {
  const secrets = parseSecretsAuthored('API_KEY=abc=def\nAPI_KEY=overridden\nOTHER=x')
  assert.deepEqual(secrets, [{ name: 'API_KEY', value: 'abc=def' }, { name: 'OTHER', value: 'x' }])
})

test('secretNames returns only the declared names', () => {
  assert.deepEqual(secretNames('A=1\nB=2'), ['A', 'B'])
})

test('findActionByName matches by trimmed name', () => {
  const list: Auth0Action[] = [{ id: 'act_1', name: 'enrich-login ' }]
  assert.equal(findActionByName(list, 'enrich-login')?.id, 'act_1')
  assert.equal(findActionByName(list, 'missing'), null)
})

test('snapshotAction captures managed fields', () => {
  const snap = snapshotAction({
    id: 'act_1',
    name: 'enrich-login',
    code: 'live code',
    runtime: 'node22',
    supported_triggers: [{ id: 'post-login', version: 'v3' }],
  })
  assert.deepEqual(snap, { code: 'live code', supported_triggers: [{ id: 'post-login', version: 'v3' }], runtime: 'node22' })
})

test('liveBindingsToEntries drops entries with no action id and preserves order', () => {
  const entries = liveBindingsToEntries([
    { action: { id: 'act_1', name: 'first' }, display_name: 'First' },
    { action: undefined },
    { action: { id: 'act_2' }, display_name: 'Second' },
  ])
  assert.deepEqual(entries, [
    { ref: { type: 'action_id', value: 'act_1' }, display_name: 'First' },
    { ref: { type: 'action_id', value: 'act_2' }, display_name: 'Second' },
  ])
})

test('withActionBound appends when absent and updates in place when present', () => {
  const current = [{ ref: { type: 'action_id' as const, value: 'act_1' }, display_name: 'First' }]
  const appended = withActionBound(current, 'act_2', 'Second')
  assert.equal(appended.length, 2)
  assert.equal(appended[1].display_name, 'Second')

  const updated = withActionBound(current, 'act_1', 'Renamed')
  assert.equal(updated.length, 1)
  assert.equal(updated[0].display_name, 'Renamed')
})

test('withActionUnbound removes only the matching entry, leaving others untouched', () => {
  const current = [
    { ref: { type: 'action_id' as const, value: 'act_1' }, display_name: 'First' },
    { ref: { type: 'action_id' as const, value: 'act_2' }, display_name: 'Second' },
  ]
  const next = withActionUnbound(current, 'act_1')
  assert.deepEqual(next, [{ ref: { type: 'action_id', value: 'act_2' }, display_name: 'Second' }])
})

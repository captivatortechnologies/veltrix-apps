import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { extractCredentialSpecs, buildCredentialBody, findCredential, readKeyValueMap } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'slack_bot_token', team_id: '1', mode: 'TEXT', secret_value: 'xoxb-abc', read_access: 'TEAM' }

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid TEXT credential', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an invalid mode', async () => {
  const res = await validate(ctxOf([{ ...good, mode: 'HTTP_REQUEST_AGENT' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_MODE'))
})

test('validate warns (not errors) on blank secret material', async () => {
  const res = await validate(ctxOf([{ ...good, secret_value: '' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'SECRET_BLANK'))
})

test('validate requires shared_team_slugs when SPECIFIC_TEAMS', async () => {
  const res = await validate(ctxOf([{ ...good, read_access: 'SPECIFIC_TEAMS', shared_team_slugs: [] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SHARED_TEAMS'))
})

test('validate warns on a duplicate (team, name)', async () => {
  const res = await validate(ctxOf([good, good]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('readKeyValueMap accepts both object-map and array-of-pairs shapes', () => {
  assert.deepEqual(readKeyValueMap({ owner: 'soc' }), { owner: 'soc' })
  assert.deepEqual(readKeyValueMap([{ key: 'owner', value: 'soc' }]), { owner: 'soc' })
  assert.deepEqual(readKeyValueMap(undefined), {})
})

test('buildCredentialBody sends `value` for TEXT mode and spreads secret_config for others', () => {
  const textSpec = extractCredentialSpecs(ctxOf([good]).canvas)[0]
  const textBody = buildCredentialBody(textSpec, null)
  assert.equal(textBody.value, 'xoxb-abc')
  assert.equal(textBody.mode, 'TEXT')

  const awsSpec = extractCredentialSpecs(
    ctxOf([{ name: 'aws', team_id: '1', mode: 'AWS', secret_config: { aws_access_key: 'AKIA123', aws_secret_key: 'shh' } }]).canvas,
  )[0]
  const awsBody = buildCredentialBody(awsSpec, null)
  assert.equal(awsBody.aws_access_key, 'AKIA123')
  assert.equal(awsBody.aws_secret_key, 'shh')
  assert.equal(awsBody.value, undefined)
})

test('buildCredentialBody includes folder_id only when resolved', () => {
  const spec = extractCredentialSpecs(ctxOf([good]).canvas)[0]
  assert.equal(buildCredentialBody(spec, null).folder_id, undefined)
  assert.equal(buildCredentialBody(spec, '9').folder_id, '9')
})

test('findCredential matches within the declared team only', () => {
  const live = [{ id: 1, team_id: '1', name: 'slack_bot_token' }]
  assert.equal(findCredential(live, '1', 'slack_bot_token')?.id, 1)
  assert.equal(findCredential(live, '2', 'slack_bot_token'), null)
})

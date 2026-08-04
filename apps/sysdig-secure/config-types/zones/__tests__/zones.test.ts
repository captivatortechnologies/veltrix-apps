import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import { buildZoneBody, findZoneByName, isMalformedScopesJson, parseScopes } from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import type { SysdigZone } from '../../../lib/sysdigApi'

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { name: 'Production AWS', enabled: true, scopesJson: '[{"targetType":"aws","rules":"account in (\\"111111111111\\")"}]' }

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects malformed scopesJson', async () => {
  const res = await validate(ctxOf([{ ...good, scopesJson: 'not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SCOPES_JSON'))
})

test('validate rejects an empty scopes array', async () => {
  const res = await validate(ctxOf([{ ...good, scopesJson: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SCOPES'))
})

test('validate rejects an unknown targetType', async () => {
  const res = await validate(ctxOf([{ ...good, scopesJson: '[{"targetType":"vmware","rules":"x"}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TARGET_TYPE'))
})

test('validate rejects a scope with empty rules', async () => {
  const res = await validate(ctxOf([{ ...good, scopesJson: '[{"targetType":"aws","rules":""}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_RULES'))
})

test('validate accepts a good zone', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('parseScopes parses a valid array and ignores malformed JSON', () => {
  assert.deepEqual(parseScopes('[{"targetType":"aws","rules":"x"}]'), [{ targetType: 'aws', rules: 'x' }])
  assert.deepEqual(parseScopes('nope'), [])
})

test('isMalformedScopesJson only flags real parse failures', () => {
  assert.equal(isMalformedScopesJson(undefined), false)
  assert.equal(isMalformedScopesJson('[]'), false)
  assert.equal(isMalformedScopesJson('{bad'), true)
})

test('buildZoneBody maps fields to the Sysdig zone shape', () => {
  const body = buildZoneBody(good)
  assert.equal(body.name, 'Production AWS')
  assert.equal(body.scopes.length, 1)
  assert.equal(body.scopes[0].targetType, 'aws')
})

test('findZoneByName matches by exact name', () => {
  const zones: SysdigZone[] = [{ name: 'A', scopes: [] }, { name: 'Production AWS', id: 3, scopes: [] }]
  assert.equal(findZoneByName(zones, 'Production AWS')?.id, 3)
  assert.equal(findZoneByName(zones, 'missing'), null)
})

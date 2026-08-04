import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildAuthFlowRep,
  builtInRefusalMessage,
  findFlowByAlias,
  projectFromFields,
  projectFromLive,
  type KeycloakAuthFlowRep,
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

const good = { alias: 'My Custom Browser Flow', description: 'Adds an extra step', providerId: 'basic-flow' }

// --- validate ----------------------------------------------------------------

test('validate rejects a missing alias', async () => {
  const res = await validate(ctxOf([{ ...good, alias: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ALIAS'))
})

test('validate accepts an alias containing spaces', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate warns on a duplicate alias', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'Copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ALIAS'))
})

test('validate rejects a missing providerId', async () => {
  const res = await validate(ctxOf([{ ...good, providerId: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_PROVIDER_ID'))
})

test('validate rejects a providerId outside basic-flow/client-flow', async () => {
  const res = await validate(ctxOf([{ ...good, providerId: 'form-flow' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_PROVIDER_ID'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers ---------------------------------------------------------

test('findFlowByAlias matches on exact alias', () => {
  const list: KeycloakAuthFlowRep[] = [
    { id: 'f1', alias: 'browser', builtIn: true },
    { id: 'f2', alias: 'My Custom Browser Flow', builtIn: false },
  ]
  assert.equal(findFlowByAlias(list, 'My Custom Browser Flow')?.id, 'f2')
  assert.equal(findFlowByAlias(list, 'missing'), null)
})

test('buildAuthFlowRep creates a new flow forced to topLevel:true, builtIn:false', () => {
  const rep = buildAuthFlowRep(good)
  assert.equal(rep.alias, 'My Custom Browser Flow')
  assert.equal(rep.description, 'Adds an extra step')
  assert.equal(rep.providerId, 'basic-flow')
  assert.equal(rep.topLevel, true)
  assert.equal(rep.builtIn, false)
})

test('buildAuthFlowRep update spreads the live rep and never rewrites providerId', () => {
  const existing: KeycloakAuthFlowRep = {
    id: 'f2',
    alias: 'My Custom Browser Flow',
    description: 'old',
    providerId: 'basic-flow',
    topLevel: true,
    builtIn: false,
  }
  const rep = buildAuthFlowRep({ ...good, description: 'new', providerId: 'client-flow' }, existing)
  assert.equal(rep.id, 'f2')
  assert.equal(rep.description, 'new')
  // providerId is immutable after creation — untouched even if a different value is authored.
  assert.equal(rep.providerId, 'basic-flow')
})

test('buildAuthFlowRep keeps a prior description when none is authored', () => {
  const existing: KeycloakAuthFlowRep = { id: 'f2', alias: 'My Custom Browser Flow', description: 'kept' }
  const rep = buildAuthFlowRep({ alias: 'My Custom Browser Flow' }, existing)
  assert.equal(rep.description, 'kept')
})

test('builtInRefusalMessage names the alias and points at authoring a new flow', () => {
  const msg = builtInRefusalMessage('browser')
  assert.match(msg, /browser/)
  assert.match(msg, /new custom flow/)
})

test('projectFromFields and projectFromLive agree for an unchanged flow', () => {
  const fromFields = projectFromFields(good)
  const live: KeycloakAuthFlowRep = { alias: 'My Custom Browser Flow', description: 'Adds an extra step' }
  assert.deepEqual(projectFromLive(live), fromFields)
})

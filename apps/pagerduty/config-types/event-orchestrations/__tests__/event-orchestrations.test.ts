import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildOrchestrationBody,
  extractEventOrchestrationSpecs,
  findOrchestration,
  findTeamId,
  hasStartSet,
  parseCatchAll,
  parseOrchestrationSets,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure
// _shared helpers (parsing / extraction / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const ROUTER_SETS = '[{"id":"start","rules":[{"label":"Route billing","actions":{"route_to":"PSERV1"}}]}]'
const good = {
  name: 'Primary Orchestration',
  description: 'Routes production incidents',
  team: 'SRE',
  router_sets: ROUTER_SETS,
  router_catch_all: '{"actions":{"route_to":"unrouted"}}',
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid event orchestration', async () => {
  const res = await validate(ctxOf([{ ...good }]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts blank optional fields (team, catch_all, global/unrouted)', async () => {
  const res = await validate(ctxOf([{ name: 'Minimal', router_sets: ROUTER_SETS }]))
  assert.equal(res.valid, true)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate rejects missing router_sets', async () => {
  const res = await validate(ctxOf([{ ...good, router_sets: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTER_SETS'))
})

test('validate rejects router_sets that are not valid JSON', async () => {
  const res = await validate(ctxOf([{ ...good, router_sets: '[not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTER_SETS'))
})

test('validate rejects a router set missing an id', async () => {
  const res = await validate(ctxOf([{ ...good, router_sets: '[{"rules":[]}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTER_SETS'))
})

test('validate warns when router_sets has no "start" set', async () => {
  const res = await validate(ctxOf([{ ...good, router_sets: '[{"id":"step-two","rules":[]}]' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'MISSING_START_SET'))
})

test('validate rejects a malformed router_catch_all', async () => {
  const res = await validate(ctxOf([{ ...good, router_catch_all: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ROUTER_CATCH_ALL'))
})

test('validate rejects invalid global_sets when declared', async () => {
  const res = await validate(ctxOf([{ ...good, global_sets: '[]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GLOBAL_SETS'))
})

test('validate ignores a malformed global_catch_all when global_sets is blank', async () => {
  const res = await validate(ctxOf([{ ...good, global_sets: '', global_catch_all: 'not json' }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed global_catch_all when global_sets is declared', async () => {
  const res = await validate(ctxOf([{ ...good, global_sets: ROUTER_SETS, global_catch_all: 'not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_GLOBAL_CATCH_ALL'))
})

test('validate ignores a malformed unrouted_catch_all when unrouted_sets is blank', async () => {
  const res = await validate(ctxOf([{ ...good, unrouted_sets: '', unrouted_catch_all: 'not json' }]))
  assert.equal(res.valid, true)
})

test('validate rejects invalid unrouted_sets when declared', async () => {
  const res = await validate(ctxOf([{ ...good, unrouted_sets: '[{"rules":[]}]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_UNROUTED_SETS'))
})

test('parseOrchestrationSets returns typed sets for a valid array', () => {
  const parsed = parseOrchestrationSets(ROUTER_SETS)
  assert.equal(parsed.error, null)
  assert.equal(parsed.sets?.length, 1)
  assert.equal(parsed.sets?.[0].id, 'start')
})

test('parseOrchestrationSets flags a set with no id', () => {
  const parsed = parseOrchestrationSets('[{"rules":[]}]')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseOrchestrationSets flags rules that are not an array', () => {
  const parsed = parseOrchestrationSets('[{"id":"start","rules":"nope"}]')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseOrchestrationSets flags a rule that is not an object', () => {
  const parsed = parseOrchestrationSets('[{"id":"start","rules":["nope"]}]')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseOrchestrationSets rejects a blank input', () => {
  const parsed = parseOrchestrationSets('')
  assert.equal(parsed.sets, null)
  assert.ok(parsed.error)
})

test('parseCatchAll defaults a blank input to {"actions":{}}', () => {
  const parsed = parseCatchAll('')
  assert.equal(parsed.error, null)
  assert.deepEqual(parsed.catchAll?.actions, {})
})

test('parseCatchAll accepts a custom actions object', () => {
  const parsed = parseCatchAll('{"actions":{"route_to":"unrouted"}}')
  assert.equal(parsed.error, null)
  assert.equal(parsed.catchAll?.actions.route_to, 'unrouted')
})

test('parseCatchAll rejects an object with no actions key', () => {
  const parsed = parseCatchAll('{"foo":"bar"}')
  assert.equal(parsed.catchAll, null)
  assert.ok(parsed.error)
})

test('parseCatchAll rejects a non-object value', () => {
  const parsed = parseCatchAll('[1,2,3]')
  assert.equal(parsed.catchAll, null)
  assert.ok(parsed.error)
})

test('hasStartSet detects the mandatory "start" set', () => {
  assert.equal(hasStartSet([{ id: 'start' }]), true)
  assert.equal(hasStartSet([{ id: 'step-two' }]), false)
})

test('extractEventOrchestrationSpecs trims text fields and carries raw JSON as-is', () => {
  const specs = extractEventOrchestrationSpecs(ctxOf([{ name: '  Primary  ', team: '  SRE  ', router_sets: ROUTER_SETS }]).canvas)
  assert.equal(specs[0].name, 'Primary')
  assert.equal(specs[0].team, 'SRE')
  assert.equal(specs[0].routerSetsJson, ROUTER_SETS)
})

test('buildOrchestrationBody omits blank description/team and sends only { id } for team', () => {
  const spec = { itemName: 'g', name: 'Primary', description: '', team: '', routerSetsJson: '', routerCatchAllJson: '', globalSetsJson: '', globalCatchAllJson: '', unroutedSetsJson: '', unroutedCatchAllJson: '' }
  const body = buildOrchestrationBody(spec, undefined)
  assert.equal(body.name, 'Primary')
  assert.equal(body.description, undefined)
  assert.equal(body.team, undefined)

  const withTeam = buildOrchestrationBody({ ...spec, description: 'desc' }, 'PTEAM1')
  assert.equal(withTeam.description, 'desc')
  assert.deepEqual(withTeam.team, { id: 'PTEAM1' })
})

test('findOrchestration matches by name case-insensitively', () => {
  const live = [{ id: 'PO1', name: 'Primary Orchestration' }, { id: 'PO2', name: 'Secondary' }]
  assert.equal(findOrchestration(live, 'primary orchestration')?.id, 'PO1')
  assert.equal(findOrchestration(live, 'missing'), null)
})

test('findTeamId resolves a team name to its id', () => {
  const teams = [{ id: 'PTEAM1', name: 'SRE' }, { id: 'PTEAM2', name: 'Platform' }]
  assert.equal(findTeamId(teams, 'sre'), 'PTEAM1')
  assert.equal(findTeamId(teams, 'nope'), null)
})

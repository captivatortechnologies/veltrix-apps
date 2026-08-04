import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  actionRestoreBody,
  buildActionBody,
  extractAutomationActionSpecs,
  findAutomationAction,
  findRunnerId,
  findServiceId,
  findTeamId,
  liveServiceIds,
  liveTeamIds,
  parseActionData,
  parseNameList,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

// These handlers apply over the PagerDuty REST API via fetch inside pagerdutyApi,
// which is impractical to mock here. Tests focus on validate.ts + the pure
// _shared helpers (extraction / parsing / body building), which are network-free.

function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const scriptAction = {
  name: 'Restart web tier',
  description: 'Restarts the web tier via a Runner-hosted script',
  action_type: 'script',
  action_data: JSON.stringify({ script: 'systemctl restart web', invocation_command: '/bin/bash' }),
}

const paAction = {
  name: 'Run remediation job',
  description: 'Kicks off a Process Automation remediation job',
  action_type: 'process_automation',
  action_data: JSON.stringify({ process_automation_job_id: 'P123456' }),
}

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate accepts a valid script action', async () => {
  const res = await validate(ctxOf([scriptAction]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate accepts a valid process_automation action', async () => {
  const res = await validate(ctxOf([paAction]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects a missing name', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate rejects a missing description', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, description: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DESCRIPTION'))
})

test('validate rejects a missing action_type', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACTION_TYPE'))
})

test('validate rejects an invalid action_type', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_type: 'webhook' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_TYPE'))
})

test('validate rejects a script action with no script in action_data', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_data: JSON.stringify({ invocation_command: '/bin/bash' }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_DATA'))
})

test('validate rejects a process_automation action with no job id in action_data', async () => {
  const res = await validate(ctxOf([{ ...paAction, action_data: JSON.stringify({ process_automation_job_arguments: '--x' }) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_DATA'))
})

test('validate rejects malformed action_data JSON', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_data: '{not json' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_DATA'))
})

test('validate rejects an invalid action_classification', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_classification: 'urgent' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACTION_CLASSIFICATION'))
})

test('validate accepts a valid action_classification', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, action_classification: 'diagnostic' }]))
  assert.equal(res.valid, true)
})

test('validate rejects malformed teams JSON', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, teams: '{not an array' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_TEAMS'))
})

test('validate rejects malformed services JSON', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, services: '[123]' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SERVICES'))
})

test('validate warns when services is declared alongside map_to_all_services', async () => {
  const res = await validate(ctxOf([{ ...scriptAction, services: JSON.stringify(['Checkout API']), map_to_all_services: true }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'IGNORED_SERVICES'))
})

test('validate warns on a duplicate name', async () => {
  const res = await validate(ctxOf([scriptAction, { ...scriptAction, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('extractAutomationActionSpecs trims fields and carries the boolean defaults', () => {
  const specs = extractAutomationActionSpecs(
    ctxOf([{ name: '  Restart web tier  ', description: '  desc  ', action_type: 'script', runner: '  Prod Runner  ' }]).canvas,
  )
  assert.equal(specs[0].name, 'Restart web tier')
  assert.equal(specs[0].description, 'desc')
  assert.equal(specs[0].runnerName, 'Prod Runner')
  assert.equal(specs[0].allowInvocationManually, true)
  assert.equal(specs[0].onlyInvocableOnUnresolvedIncidents, false)
  assert.equal(specs[0].allowInvocationFromEventOrchestration, false)
  assert.equal(specs[0].mapToAllServices, false)
})

test('parseActionData requires a non-empty script for a script action', () => {
  const missing = parseActionData(JSON.stringify({ invocation_command: '/bin/bash' }), 'script')
  assert.equal(missing.data, null)
  assert.ok(missing.error)

  const ok = parseActionData(JSON.stringify({ script: 'echo hi', invocation_command: '/bin/bash' }), 'script')
  assert.equal(ok.error, null)
  assert.equal(ok.data?.script, 'echo hi')
  assert.equal(ok.data?.invocation_command, '/bin/bash')
})

test('parseActionData requires a non-empty process_automation_job_id for a process_automation action', () => {
  const missing = parseActionData(JSON.stringify({ process_automation_job_arguments: '--x' }), 'process_automation')
  assert.equal(missing.data, null)
  assert.ok(missing.error)

  const ok = parseActionData(JSON.stringify({ process_automation_job_id: 'P1', process_automation_node_filter: 'tags: web' }), 'process_automation')
  assert.equal(ok.error, null)
  assert.equal(ok.data?.process_automation_job_id, 'P1')
  assert.equal(ok.data?.process_automation_node_filter, 'tags: web')
})

test('parseActionData rejects a blank value', () => {
  const res = parseActionData('', 'script')
  assert.equal(res.data, null)
  assert.ok(res.error)
})

test('parseActionData rejects malformed JSON', () => {
  const res = parseActionData('{not json', 'script')
  assert.equal(res.data, null)
  assert.ok(res.error)
})

test('parseNameList treats a blank input as an empty, valid list', () => {
  const res = parseNameList('', 'team')
  assert.deepEqual(res.names, [])
  assert.equal(res.error, null)
})

test('parseNameList parses a valid JSON array of names', () => {
  const res = parseNameList(JSON.stringify(['SRE Team', 'Platform']), 'team')
  assert.deepEqual(res.names, ['SRE Team', 'Platform'])
  assert.equal(res.error, null)
})

test('parseNameList rejects a non-array', () => {
  const res = parseNameList(JSON.stringify({ a: 1 }), 'team')
  assert.equal(res.names, null)
  assert.ok(res.error?.includes('team'))
})

test('parseNameList rejects an empty-string entry', () => {
  const res = parseNameList(JSON.stringify(['Ok', '  ']), 'service')
  assert.equal(res.names, null)
  assert.ok(res.error?.includes('service'))
})

test('buildActionBody omits runner and action_classification when unset', () => {
  const body = buildActionBody(
    {
      itemName: 'g',
      name: 'Restart web tier',
      description: 'desc',
      actionType: 'script',
      runnerName: '',
      actionDataJson: '',
      actionClassification: '',
      teamsJson: '',
      servicesJson: '',
      mapToAllServices: false,
      onlyInvocableOnUnresolvedIncidents: false,
      allowInvocationManually: true,
      allowInvocationFromEventOrchestration: false,
    },
    { script: 'echo hi' },
    null,
  )
  assert.equal(body.name, 'Restart web tier')
  assert.equal(body.action_type, 'script')
  assert.equal(body.runner, undefined)
  assert.equal(body.action_classification, undefined)
  assert.equal((body as Record<string, unknown>).type, undefined)
})

test('buildActionBody includes runner and action_classification when set', () => {
  const body = buildActionBody(
    {
      itemName: 'g',
      name: 'Restart web tier',
      description: 'desc',
      actionType: 'script',
      runnerName: 'Prod Runner',
      actionDataJson: '',
      actionClassification: 'diagnostic',
      teamsJson: '',
      servicesJson: '',
      mapToAllServices: true,
      onlyInvocableOnUnresolvedIncidents: true,
      allowInvocationManually: false,
      allowInvocationFromEventOrchestration: true,
    },
    { script: 'echo hi' },
    'PR123',
  )
  assert.equal(body.runner, 'PR123')
  assert.equal(body.action_classification, 'diagnostic')
  assert.equal(body.map_to_all_services, true)
  assert.equal(body.only_invocable_on_unresolved_incidents, true)
  assert.equal(body.allow_invocation_manually, false)
  assert.equal(body.allow_invocation_from_event_orchestration, true)
})

test('actionRestoreBody reconstructs the prior body including its bare runner id', () => {
  const body = actionRestoreBody({
    id: 'PA1',
    name: 'Restart web tier',
    description: 'desc',
    action_type: 'script',
    action_data_reference: { script: 'echo hi' },
    runner: 'PR123',
    action_classification: 'diagnostic',
    only_invocable_on_unresolved_incidents: true,
    allow_invocation_manually: false,
    allow_invocation_from_event_orchestration: true,
    map_to_all_services: true,
  })
  assert.equal(body.runner, 'PR123')
  assert.equal(body.action_classification, 'diagnostic')
  assert.equal(body.only_invocable_on_unresolved_incidents, true)
  assert.equal(body.allow_invocation_manually, false)
})

test('actionRestoreBody applies safe defaults when the prior omitted optional flags', () => {
  const body = actionRestoreBody({ id: 'PA1', name: 'Restart web tier', action_type: 'script' })
  assert.equal(body.runner, undefined)
  assert.equal(body.action_classification, undefined)
  assert.equal(body.only_invocable_on_unresolved_incidents, false)
  assert.equal(body.allow_invocation_manually, true)
  assert.equal(body.allow_invocation_from_event_orchestration, false)
  assert.equal(body.map_to_all_services, false)
})

test('findAutomationAction matches by name case-insensitively', () => {
  const live = [{ id: 'PA1', name: 'Restart web tier' }, { id: 'PA2', name: 'Run remediation job' }]
  assert.equal(findAutomationAction(live, 'restart web tier')?.id, 'PA1')
  assert.equal(findAutomationAction(live, 'missing'), null)
})

test('findRunnerId / findTeamId / findServiceId resolve a name to its id case-insensitively', () => {
  assert.equal(findRunnerId([{ id: 'PR1', name: 'Prod Runner' }], 'prod runner'), 'PR1')
  assert.equal(findTeamId([{ id: 'PT1', name: 'SRE Team' }], 'sre team'), 'PT1')
  assert.equal(findServiceId([{ id: 'PS1', name: 'Checkout API' }], 'checkout api'), 'PS1')
  assert.equal(findRunnerId([], 'nope'), null)
})

test('liveTeamIds / liveServiceIds collect only entries with an id', () => {
  const teamIds = liveTeamIds({ teams: [{ id: 'PT1' }, { type: 'team_reference' }] })
  assert.deepEqual([...teamIds], ['PT1'])

  const serviceIds = liveServiceIds({ services: [{ id: 'PS1' }, { id: 'PS2' }] })
  assert.deepEqual([...serviceIds].sort(), ['PS1', 'PS2'])
})

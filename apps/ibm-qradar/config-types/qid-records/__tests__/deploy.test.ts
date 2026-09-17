// deploy for qid-records.
//
// The shared contract covers the pre-flight refusals. What is specific here is
// that this type is APPEND/UPDATE-ONLY — QRadar exposes no delete for a QID
// record or for a DSM event mapping. Every duplicate this deploy creates is
// permanent, so the two identity reads (by the id the last deploy recorded,
// then by name) and the case-insensitive mapping key are what stand between a
// customer and a data-classification table nobody can clean up.

import test from 'node:test'
import assert from 'node:assert/strict'
import deploy from '../deploy'
import {
  assertQRadarHeaders,
  bodyOf,
  created,
  deployContext,
  item,
  leaksToken,
  list,
  notFound,
  ok,
  pathOf,
  qradarError,
  routeFetch,
  writeCalls,
  type CannedResponse,
  type Route,
} from '../../../lib/__tests__/fakeQRadar'
import { registerDeployGuardContract } from '../../../lib/__tests__/qradarContracts'

const QID = '/data_classification/qid_records'
const MAP = '/data_classification/dsm_event_mappings'
const BY_NAME = `${QID}?filter=name%3D%22Failed%20Login%22`

const LINUX_TYPE = { id: 11, name: 'Linux OS' }
const LOGIN_FAILURE = { id: 3117, name: 'User Login Failure' }
const AUTH_FAILED = { id: 3118, name: 'General Authentication Failed' }

const FAILED_LOGIN = item('Failed Login', {
  logSourceType: 'Linux OS',
  name: 'Failed Login',
  description: 'Authentication failure',
  lowLevelCategory: 'User Login Failure',
  severity: 7,
  eventMappings: '[{"eventId":"4625","eventCategory":"Security"}]',
})

registerDeployGuardContract({ label: 'qid-records', handler: deploy, sampleItems: [FAILED_LOGIN] })

interface RouteOverrides {
  types?: CannedResponse
  categories?: CannedResponse
  byId?: CannedResponse
  byName?: CannedResponse
  createRecord?: CannedResponse
  updateRecord?: CannedResponse
  liveMappings?: CannedResponse
  createMapping?: CannedResponse
  repointMapping?: CannedResponse
}

function routes(over: RouteOverrides = {}): Route[] {
  return [
    { url: /\/log_source_types$/, respond: over.types ?? list([LINUX_TYPE]) },
    { url: /\/low_level_categories$/, respond: over.categories ?? list([LOGIN_FAILURE, AUTH_FAILED]) },
    { url: /\/qid_records\?filter=/, method: 'GET', respond: over.byName ?? list([]) },
    { url: /\/qid_records\/\d+$/, method: 'GET', respond: over.byId ?? notFound() },
    { url: /\/qid_records\/\d+$/, method: 'POST', respond: over.updateRecord ?? ok({}) },
    { url: /\/qid_records$/, method: 'POST', respond: over.createRecord ?? created({ id: 7001 }) },
    { url: /\/dsm_event_mappings\?filter=/, method: 'GET', respond: over.liveMappings ?? list([]) },
    { url: /\/dsm_event_mappings\/\d+$/, method: 'POST', respond: over.repointMapping ?? ok({}) },
    { url: /\/dsm_event_mappings$/, method: 'POST', respond: over.createMapping ?? created({ id: 501 }) },
  ]
}

/** A live QID record that matches FAILED_LOGIN field for field. */
function liveRecord(over: Record<string, unknown> = {}) {
  return {
    id: 7001,
    qid: 1000001,
    name: 'Failed Login',
    description: 'Authentication failure',
    severity: 7,
    low_level_category_id: 3117,
    log_source_type_id: 11,
    ...over,
  }
}

function entriesOf(result: { rollbackData?: unknown }): Array<Record<string, unknown>> {
  return (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
}

test('qid-records deploy: creates the record and its mapping when neither exists', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assertQRadarHeaders(assert, calls)
    const lookup = calls.find((c) => c.method === 'GET' && pathOf(c).startsWith(`${QID}?filter=`))
    assert.ok(lookup, 'the record must be looked for before it is created')
    assert.equal(pathOf(lookup), BY_NAME)

    const writes = writeCalls(calls)
    assert.deepEqual(
      writes.map((c) => `${c.method} ${pathOf(c)}`),
      [`POST ${QID}`, `POST ${MAP}`],
      'the record is created first, then the mapping that points at it',
    )
    assert.deepEqual(bodyOf(writes[0]), {
      log_source_type_id: 11,
      name: 'Failed Login',
      low_level_category_id: 3117,
      description: 'Authentication failure',
      severity: 7,
    })
    assert.deepEqual(bodyOf(writes[1]), {
      log_source_type_id: 11,
      log_source_event_id: '4625',
      log_source_event_category: 'Security',
      qid_record_id: 7001,
    })

    assert.equal(result.success, true)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].existed, false)
    assert.equal(entries[0].id, 7001)
    assert.deepEqual(entries[0].mappings, [
      { key: '4625 security', eventId: '4625', eventCategory: 'Security', existed: false, id: 501 },
    ])
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('qid-records deploy: looks the record up by the id the last deploy recorded', async () => {
  // Identity is (log source type, name), so a record renamed in the console is
  // only findable by id. Without this read the deploy creates a second record
  // that no endpoint can ever remove.
  const { calls, restore } = routeFetch(routes({ byId: ok(liveRecord({ name: 'Renamed By Operator' })) }))
  try {
    const result = await deploy(
      deployContext([FAILED_LOGIN], {
        priorRollbackData: {
          entries: [{ name: 'Failed Login', logSourceType: 'Linux OS', existed: true, id: 7001, mappings: [] }],
        },
      }),
    )

    assert.ok(
      calls.some((c) => c.method === 'GET' && pathOf(c) === `${QID}/7001`),
      'the recorded id must be read directly',
    )
    assert.equal(
      calls.some((c) => pathOf(c).startsWith(`${QID}?filter=`)),
      false,
      'a record found by id must not also be searched for by name',
    )
    const writes = writeCalls(calls)
    assert.equal(pathOf(writes[0]), `${QID}/7001`, 'the rename is corrected in place')
    assert.equal(bodyOf(writes[0])?.name, 'Failed Login')
    assert.equal(entriesOf(result)[0].existed, true)
  } finally {
    restore()
  }
})

test('qid-records deploy: falls back to the name filter when the recorded id is gone', async () => {
  // 404 is a known answer — the record was deleted out of band — so searching by
  // name is the right next step rather than creating blind.
  const { calls, restore } = routeFetch(routes({ byId: notFound(), byName: list([liveRecord()]) }))
  try {
    const result = await deploy(
      deployContext([FAILED_LOGIN], {
        priorRollbackData: {
          entries: [{ name: 'Failed Login', logSourceType: 'Linux OS', existed: true, id: 6500, mappings: [] }],
        },
      }),
    )

    const gets = calls.filter((c) => c.method === 'GET').map((c) => pathOf(c))
    assert.ok(gets.includes(`${QID}/6500`))
    assert.ok(gets.includes(BY_NAME), 'the name filter is the fallback identity read')
    assert.equal(
      writeCalls(calls).some((c) => pathOf(c) === QID),
      false,
      'a record found by name must not be created a second time',
    )
    assert.equal(entriesOf(result)[0].id, 7001)
  } finally {
    restore()
  }
})

test('qid-records deploy: the name filter read asks for a bounded page and matches case-insensitively', async () => {
  const { calls, restore } = routeFetch(routes({ byName: list([liveRecord({ name: 'failed login' })]) }))
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    const lookup = calls.find((c) => pathOf(c) === BY_NAME)
    assert.ok(lookup)
    assert.equal(lookup.range, 'items=0-99')
    assert.equal(entriesOf(result)[0].existed, true, 'a differently-cased live name is the same record')
  } finally {
    restore()
  }
})

test('qid-records deploy: updating an existing record records the LIVE prior fields, not the canvas', async () => {
  // Rollback re-posts this state. Recording the desired values would make a
  // rollback a no-op that silently keeps the change it was undoing.
  const live = liveRecord({
    description: 'Auth failure (operator wording)',
    severity: 3,
    low_level_category_id: 3118,
  })
  const { calls, restore } = routeFetch(routes({ byName: list([live]) }))
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    const writes = writeCalls(calls)
    assert.equal(pathOf(writes[0]), `${QID}/7001`)
    assert.deepEqual(bodyOf(writes[0]), {
      name: 'Failed Login',
      low_level_category_id: 3117,
      description: 'Authentication failure',
      severity: 7,
    })

    const entries = entriesOf(result)
    assert.equal(entries[0].existed, true)
    assert.deepEqual(entries[0].prior, {
      name: 'Failed Login',
      description: 'Auth failure (operator wording)',
      severity: 3,
      low_level_category_id: 3118,
    })
  } finally {
    restore()
  }
})

test('qid-records deploy: writes nothing when the live record and mapping already match', async () => {
  // The live mapping's category differs only in CASE. A case-sensitive key would
  // create a duplicate mapping here — and there is no delete to undo it with.
  const liveMapping = {
    id: 501,
    log_source_type_id: 11,
    log_source_event_id: '4625',
    log_source_event_category: 'security',
    qid_record_id: 7001,
  }
  const { calls, restore } = routeFetch(
    routes({ byName: list([liveRecord()]), liveMappings: list([liveMapping]) }),
  )
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assert.equal(writeCalls(calls).length, 0, 'an unchanged record and mapping must not be rewritten')
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'a skipped write still needs a rollback entry')
    assert.deepEqual(entries[0].mappings, [
      { key: '4625 security', eventId: '4625', eventCategory: 'Security', existed: true, id: 501 },
    ])
    assert.equal(result.success, true)
  } finally {
    restore()
  }
})

test('qid-records deploy: re-points a mapping that belongs to another QID record', async () => {
  const stolen = {
    id: 501,
    log_source_type_id: 11,
    log_source_event_id: '4625',
    log_source_event_category: 'Security',
    qid_record_id: 9999,
  }
  const { calls, restore } = routeFetch(routes({ byName: list([liveRecord()]), liveMappings: list([stolen]) }))
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    const writes = writeCalls(calls)
    assert.deepEqual(
      writes.map((c) => `${c.method} ${pathOf(c)}`),
      [`POST ${MAP}/501`],
      'an existing mapping is re-pointed in place, never duplicated',
    )
    assert.equal(bodyOf(writes[0])?.qid_record_id, 7001)
    assert.deepEqual(entriesOf(result)[0].mappings, [
      { key: '4625 security', eventId: '4625', eventCategory: 'Security', existed: true, id: 501 },
    ])
  } finally {
    restore()
  }
})

test('qid-records deploy: an unresolvable log source type fails the item without writing', async () => {
  // log_source_type_id is a foreign key on both the record and every mapping.
  const { calls, restore } = routeFetch(routes({ types: list([{ id: 12, name: 'Some Other Type' }]) }))
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, false)
    assert.match(String(result.message), /Failed Login: unknown log source type "Linux OS"/)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

test('qid-records deploy: an unresolvable low level category fails the item without writing', async () => {
  const { calls, restore } = routeFetch(routes({ categories: list([AUTH_FAILED]) }))
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assert.equal(writeCalls(calls).length, 0, 'a record created with no category cannot be deleted afterwards')
    assert.equal(result.success, false)
    assert.match(String(result.message), /unknown low level category "User Login Failure"/)
  } finally {
    restore()
  }
})

test('qid-records deploy: a rejected create is a failed result, not a thrown error', async () => {
  const { calls, restore } = routeFetch(
    routes({ createRecord: qradarError(422, 'A QID record with this name already exists for this log source type') }),
  )
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /already exists/)
    assert.ok(result.rollbackData, 'a failed deploy still returns what it had captured')
    assert.equal(
      writeCalls(calls).some((c) => pathOf(c) === MAP),
      false,
      'no mapping may be created for a record that was never created',
    )
    assert.equal(leaksToken(result), false)
  } finally {
    restore()
  }
})

test('qid-records deploy: a rejected mapping fails the deploy but keeps the record entry', async () => {
  const { restore } = routeFetch(
    routes({ byName: list([liveRecord()]), createMapping: qradarError(422, 'Event id is already mapped') }),
  )
  try {
    const result = await deploy(deployContext([FAILED_LOGIN]))

    assert.equal(result.success, false)
    assert.match(String(result.message), /\[4625\/Security\]: Event id is already mapped/)
    const entries = entriesOf(result)
    assert.equal(entries.length, 1, 'the record was touched, so rollback must know its prior state')
    assert.equal(entries[0].existed, true)
  } finally {
    restore()
  }
})

test('qid-records deploy: an empty canvas writes nothing', async () => {
  const { calls, restore } = routeFetch(routes())
  try {
    const result = await deploy(deployContext([]))

    assert.equal(writeCalls(calls).length, 0)
    assert.equal(result.success, true)
    assert.deepEqual(entriesOf(result), [])
  } finally {
    restore()
  }
})

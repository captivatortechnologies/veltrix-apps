// =============================================================================
// Shared handler contracts for the two custom-property configuration types.
//
// `custom-event-properties` and `flow-custom-properties` are four-line wrappers
// over one engine in `lib/customProperties.ts`, parameterised only by the base
// path segment (`event_sources` vs `flow_sources`). Their deploy, rollback,
// driftDetect and healthCheck bodies are therefore the SAME code, and hand-
// copying the tests would be two places for one assertion to drift.
//
// Each config type's own `__tests__` invokes these with its base. Everything
// here is driven through the config type's own exported handler, never through
// the lib, so a wrapper that passed the wrong base would still be caught.
//
// The resource this type manages is a regex_property (the named field) plus one
// property_expression per log source type (the regex that actually extracts it).
// The expressions are where the security value lives: a property with no
// matching expression extracts nothing, and an expression pointed at the wrong
// capture group extracts the wrong thing.
//
// This is NOT a test file — the runner only collects `*.test.ts`.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  DeployContext,
  DeployResult,
  DriftContext,
  DriftResult,
  RollbackContext,
  RollbackResult,
} from '@veltrixsecops/app-sdk'
import {
  ACCEPTED,
  bodyOf,
  created,
  deployContext,
  driftContext,
  item,
  leaksToken,
  list,
  notFound,
  ok,
  pathOf,
  qradarError,
  recordFetch,
  rollbackContext,
  routeFetch,
  writeCalls,
  assertQRadarHeaders,
} from './fakeQRadar'
import {
  registerDeployGuardContract,
  registerDriftGuardContract,
  registerRollbackGuardContract,
} from './qradarContracts'

/** Which product's custom properties the configuration type manages. */
export type PropertyBase = 'event_sources' | 'flow_sources'

export function regexPath(base: PropertyBase): string {
  return `/config/${base}/custom_properties/regex_properties`
}

export function exprPath(base: PropertyBase): string {
  return `/config/${base}/custom_properties/property_expressions`
}

/** Log source types are ALWAYS read from the event-sources tree, even for flows. */
const TYPES_PATH = '/config/event_sources/log_source_management/log_source_types'

const CISCO_TYPE_ID = 17
const LINUX_TYPE_ID = 11

/** The log source types both bases resolve expression names against. */
function liveTypes() {
  return list([
    { id: CISCO_TYPE_ID, name: 'Cisco Firewall Threat Defense' },
    { id: LINUX_TYPE_ID, name: 'Linux OS' },
  ])
}

/** The canvas item both suites deploy: one property with one expression. */
export function propertyItem(over: Record<string, unknown> = {}) {
  return item('Session ID', {
    name: 'Session ID',
    propertyType: 'string',
    description: 'Correlates events belonging to one session',
    useForRuleEngine: true,
    expressions: JSON.stringify([
      { logSourceType: 'Cisco Firewall Threat Defense', regex: 'SessionID=(\\w+)', captureGroup: 1, enabled: true },
    ]),
    ...over,
  })
}

/** A live regex_property as the console returns it. */
function liveProperty(over: Record<string, unknown> = {}) {
  return {
    id: 4100,
    identifier: 'ecb1a2f0-session-id',
    name: 'Session ID',
    property_type: 'string',
    description: 'Correlates events belonging to one session',
    use_for_rule_engine: true,
    ...over,
  }
}

/** A live property_expression as the console returns it. */
function liveExpression(over: Record<string, unknown> = {}) {
  return {
    id: 7200,
    identifier: 'a1-expr',
    regex_property_identifier: 'ecb1a2f0-session-id',
    log_source_type_id: CISCO_TYPE_ID,
    regex: 'SessionID=(\\w+)',
    capture_group: 1,
    enabled: true,
    ...over,
  }
}

/** What every contract here needs: which config type, and which base path. */
interface BaseContract {
  /** The configuration type's id, used in test titles. */
  label: string
  base: PropertyBase
}

export interface CustomPropertyDeployContract extends BaseContract {
  handler: (ctx: DeployContext) => Promise<DeployResult>
  /** The noun the engine puts in its result messages, e.g. "custom event property(ies)". */
  noun: RegExp
}

export interface CustomPropertyRollbackContract extends BaseContract {
  handler: (ctx: RollbackContext) => Promise<RollbackResult>
}

export interface CustomPropertyDriftContract extends BaseContract {
  handler: (ctx: DriftContext) => Promise<DriftResult>
}

// --- deploy -------------------------------------------------------------------

/** Register the deploy contract both custom-property configuration types share. */
export function registerCustomPropertyDeployContract(c: CustomPropertyDeployContract): void {
  const REGEX = regexPath(c.base)
  const EXPR = exprPath(c.base)

  registerDeployGuardContract({ label: c.label, handler: c.handler, sampleItems: [propertyItem()] })

  test(`${c.label} deploy: creates a property and its expression, recording both for rollback`, async () => {
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${REGEX}$`), method: 'POST', respond: created(liveProperty()) },
      { url: new RegExp(`${EXPR}$`), method: 'POST', respond: created(liveExpression()) },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem()]))

      assertQRadarHeaders(assert, calls)
      const writes = writeCalls(calls)
      assert.equal(writes.length, 2, 'one parent create and one expression create')
      assert.equal(pathOf(writes[0]), REGEX)
      assert.deepEqual(bodyOf(writes[0]), {
        name: 'Session ID',
        property_type: 'string',
        description: 'Correlates events belonging to one session',
        use_for_rule_engine: true,
      })
      assert.equal(pathOf(writes[1]), EXPR)
      assert.deepEqual(bodyOf(writes[1]), {
        regex_property_identifier: 'ecb1a2f0-session-id',
        log_source_type_id: CISCO_TYPE_ID,
        regex: 'SessionID=(\\w+)',
        capture_group: 1,
        enabled: true,
      })

      assert.equal(result.success, true)
      assert.match(String(result.message), c.noun)
      const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
      assert.equal(entries.length, 1)
      assert.equal(entries[0].existed, false, 'a property this deploy created must be marked not pre-existing')
      assert.equal(entries[0].id, 4100)
      assert.equal(entries[0].identifier, 'ecb1a2f0-session-id')
      assert.deepEqual(entries[0].expressions, [{ logSourceTypeId: CISCO_TYPE_ID, existed: false, id: 7200 }])
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: resolves log source types from the event-sources tree even for flows`, async () => {
    // `listLogSourceTypes` is shared: flow custom properties still name their
    // expressions by LOG SOURCE type. A wrapper that rewrote this path to
    // `flow_sources` would make every expression fail as "unknown".
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'POST', respond: created(liveProperty()) },
      { url: new RegExp(`${EXPR}$`), method: 'POST', respond: created(liveExpression()) },
    ])
    try {
      await c.handler(deployContext([propertyItem()]))

      assert.ok(
        calls.some((call) => pathOf(call) === TYPES_PATH),
        'log source types come from the event-sources tree regardless of base',
      )
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: updating a property records the LIVE prior state, not the desired one`, async () => {
    // The live property differs from the canvas in every mutable field. A
    // handler that recorded the canvas values as "prior" would look correct here
    // and silently discard the operator's edits on rollback.
    const live = liveProperty({
      property_type: 'numeric',
      description: 'description an operator edited in the console',
      use_for_rule_engine: false,
    })
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([live]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([liveExpression()]) },
      { url: new RegExp(`${REGEX}/4100$`), method: 'POST', respond: ok({}) },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem()]))

      const writes = writeCalls(calls)
      assert.equal(writes.length, 1, 'only the parent changed; the expression already matched')
      assert.equal(pathOf(writes[0]), `${REGEX}/4100`)

      const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
      assert.equal(entries[0].existed, true)
      assert.deepEqual(entries[0].priorParent, {
        name: 'Session ID',
        property_type: 'numeric',
        description: 'description an operator edited in the console',
        use_for_rule_engine: false,
      })
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a property that already matches is recorded without being written`, async () => {
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([liveProperty()]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([liveExpression()]) },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem()]))

      assert.equal(writeCalls(calls).length, 0, 'an unchanged property must not be rewritten')
      const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
      assert.equal(entries.length, 1, 'but it is still recorded, so rollback knows its state')
      assert.deepEqual(entries[0].expressions, [
        { logSourceTypeId: CISCO_TYPE_ID, existed: true, id: 7200, prior: { regex: 'SessionID=(\\w+)', capture_group: 1, enabled: true } },
      ])
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a rewritten regex updates the expression and records the live one`, async () => {
    // This is the field the whole configuration type exists to control: the
    // regex that extracts the value. The prior state recorded here is the only
    // way back to the expression the console actually had.
    const liveEdited = liveExpression({ regex: 'session_id=([0-9]+)', capture_group: 2, enabled: false })
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([liveProperty()]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([liveEdited]) },
      { url: new RegExp(`${EXPR}/7200$`), method: 'POST', respond: ok({}) },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem()]))

      const writes = writeCalls(calls)
      assert.equal(writes.length, 1)
      assert.equal(pathOf(writes[0]), `${EXPR}/7200`)
      assert.deepEqual(bodyOf(writes[0]), {
        regex_property_identifier: 'ecb1a2f0-session-id',
        log_source_type_id: CISCO_TYPE_ID,
        regex: 'SessionID=(\\w+)',
        capture_group: 1,
        enabled: true,
      })

      const entries = (result.rollbackData as { entries: Array<Record<string, unknown>> }).entries
      const expr = (entries[0].expressions as Array<Record<string, unknown>>)[0]
      assert.deepEqual(expr.prior, { regex: 'session_id=([0-9]+)', capture_group: 2, enabled: false })
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: an expression naming an unknown log source type is not written`, async () => {
    // Writing it anyway would send `log_source_type_id: undefined` and attach the
    // expression to whatever the console defaults to.
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([liveProperty()]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
    ])
    try {
      const result = await c.handler(
        deployContext([
          propertyItem({
            expressions: JSON.stringify([{ logSourceType: 'A Product Nobody Installed', regex: 'x=(.*)' }]),
          }),
        ]),
      )

      assert.equal(writeCalls(calls).length, 0, 'an unresolvable type must not be written with a blank id')
      assert.equal(result.success, false)
      assert.match(String(result.message), /unknown log source type "A Product Nobody Installed"/)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: only an expression IT created is reconcile-deleted when withdrawn`, async () => {
    // The Linux expression was added by this app in an earlier deploy and is no
    // longer declared; the Cisco one is still declared. An expression the
    // operator wrote by hand must never be swept up here.
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([liveProperty()]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([liveExpression()]) },
      { url: new RegExp(`${EXPR}/7311$`), method: 'DELETE', respond: ACCEPTED },
    ])
    try {
      const result = await c.handler(
        deployContext([propertyItem()], {
          priorRollbackData: {
            entries: [
              {
                name: 'Session ID',
                existed: true,
                id: 4100,
                identifier: 'ecb1a2f0-session-id',
                expressions: [
                  { logSourceTypeId: LINUX_TYPE_ID, existed: false, id: 7311 },
                  { logSourceTypeId: 99, existed: true, id: 7999 },
                ],
              },
            ],
          },
        }),
      )

      const deletes = writeCalls(calls).filter((call) => call.method === 'DELETE').map((call) => pathOf(call))
      assert.deepEqual(deletes, [`${EXPR}/7311`])
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a withdrawn property it created is removed, expressions first`, async () => {
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}/7311$`), method: 'DELETE', respond: ACCEPTED },
      { url: new RegExp(`${REGEX}/4200$`), method: 'DELETE', respond: ACCEPTED },
    ])
    try {
      const result = await c.handler(
        deployContext([], {
          priorRollbackData: {
            entries: [
              {
                name: 'Retired Property',
                existed: false,
                id: 4200,
                identifier: 'retired',
                expressions: [{ logSourceTypeId: LINUX_TYPE_ID, existed: false, id: 7311 }],
              },
              { name: 'Operator Owned', existed: true, id: 4300, identifier: 'owned', expressions: [] },
            ],
          },
        }),
      )

      assert.deepEqual(
        writeCalls(calls).map((call) => `${call.method} ${pathOf(call)}`),
        [`DELETE ${EXPR}/7311`, `DELETE ${REGEX}/4200`],
        'the child goes before the parent, and the pre-existing property is untouched',
      )
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a rejected create is a failed result, not a thrown error`, async () => {
    const { restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      {
        url: new RegExp(`${REGEX}$`),
        method: 'POST',
        respond: qradarError(422, 'A custom property with this name already exists'),
      },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem()]))

      assert.equal(result.success, false)
      assert.match(String(result.message), /already exists/)
      assert.ok(result.rollbackData, 'a failed deploy still hands back what it captured')
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a time property carries its datetime format and locale`, async () => {
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${REGEX}$`), method: 'POST', respond: created(liveProperty()) },
      { url: new RegExp(`${EXPR}$`), method: 'POST', respond: created(liveExpression()) },
    ])
    try {
      await c.handler(
        deployContext([
          propertyItem({
            propertyType: 'time',
            datetimeFormat: 'yyyy-MM-dd HH:mm:ss',
            locale: 'en_GB',
          }),
        ]),
      )

      const body = bodyOf(writeCalls(calls)[0])
      assert.equal(body?.property_type, 'time')
      assert.equal(body?.datetime_format, 'yyyy-MM-dd HH:mm:ss')
      assert.equal(body?.locale, 'en_GB')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: a non-time property omits the datetime format entirely`, async () => {
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${REGEX}$`), method: 'POST', respond: created(liveProperty()) },
      { url: new RegExp(`${EXPR}$`), method: 'POST', respond: created(liveExpression()) },
    ])
    try {
      await c.handler(deployContext([propertyItem({ datetimeFormat: 'yyyy-MM-dd', locale: 'en_GB' })]))

      const body = bodyOf(writeCalls(calls)[0])
      assert.equal('datetime_format' in (body ?? {}), false, 'a string property must not carry a time format')
    } finally {
      restore()
    }
  })

  test(`${c.label} deploy: an expressions blob that is not JSON deploys the property alone`, async () => {
    // validate rejects this shape, but deploy must not crash on a canvas that
    // reached it anyway — the property is still created, with no expressions.
    const { calls, restore } = routeFetch([
      { url: new RegExp(`${TYPES_PATH}$`), method: 'GET', respond: liveTypes() },
      { url: new RegExp(`${REGEX}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${EXPR}$`), method: 'GET', respond: list([]) },
      { url: new RegExp(`${REGEX}$`), method: 'POST', respond: created(liveProperty()) },
    ])
    try {
      const result = await c.handler(deployContext([propertyItem({ expressions: 'not json at all' })]))

      assert.equal(writeCalls(calls).length, 1, 'the parent is written; no expression is invented')
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })
}

// --- rollback -----------------------------------------------------------------

/** Register the rollback contract both custom-property configuration types share. */
export function registerCustomPropertyRollbackContract(c: CustomPropertyRollbackContract): void {
  const REGEX = regexPath(c.base)
  const EXPR = exprPath(c.base)

  registerRollbackGuardContract({ label: c.label, handler: c.handler })

  const CREATED_ENTRY = {
    name: 'Session ID',
    existed: false,
    id: 4100,
    identifier: 'ecb1a2f0-session-id',
    expressions: [{ logSourceTypeId: CISCO_TYPE_ID, existed: false, id: 7200 }],
  }

  const UPDATED_ENTRY = {
    name: 'Session ID',
    existed: true,
    id: 4100,
    identifier: 'ecb1a2f0-session-id',
    priorParent: {
      name: 'Session ID',
      property_type: 'numeric',
      description: 'description an operator edited in the console',
      use_for_rule_engine: false,
    },
    expressions: [
      {
        logSourceTypeId: CISCO_TYPE_ID,
        existed: true,
        id: 7200,
        prior: { regex: 'session_id=([0-9]+)', capture_group: 2, enabled: false },
      },
    ],
  }

  test(`${c.label} rollback: deletes what the deploy created, expression before property`, async () => {
    // Deleting the parent first would orphan the expression, and QRadar has no
    // way to address an expression whose regex_property is gone.
    const { calls, restore } = recordFetch([ACCEPTED, ACCEPTED])
    try {
      const result = await c.handler(rollbackContext({ entries: [CREATED_ENTRY] }))

      assertQRadarHeaders(assert, calls)
      assert.deepEqual(
        calls.map((call) => `${call.method} ${pathOf(call)}`),
        [`DELETE ${EXPR}/7200`, `DELETE ${REGEX}/4100`],
      )
      assert.equal(result.success, true)
      assert.match(String(result.message), /2 deleted/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: restores the prior property and the prior regex`, async () => {
    const { calls, restore } = recordFetch([ok({}), ok({})])
    try {
      const result = await c.handler(rollbackContext({ entries: [UPDATED_ENTRY] }))

      assert.equal(pathOf(calls[0]), `${EXPR}/7200`)
      assert.deepEqual(bodyOf(calls[0]), {
        regex_property_identifier: 'ecb1a2f0-session-id',
        log_source_type_id: CISCO_TYPE_ID,
        regex: 'session_id=([0-9]+)',
        capture_group: 2,
        enabled: false,
      })
      assert.equal(pathOf(calls[1]), `${REGEX}/4100`)
      assert.deepEqual(bodyOf(calls[1]), UPDATED_ENTRY.priorParent)
      assert.equal(result.success, true)
      assert.match(String(result.message), /2 restored/)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: an entry with no recorded id makes no call`, async () => {
    // The deploy's create response carried no id, so there is nothing to
    // address. Guessing one would write over an unrelated property.
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({
          entries: [
            { name: 'Session ID', existed: false, identifier: 'x', expressions: [{ logSourceTypeId: 1, existed: false }] },
          ],
        }),
      )

      assert.equal(calls.length, 0, 'no id means no call, not an invented one')
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: an updated entry with no captured prior state makes no call`, async () => {
    const { calls, restore } = recordFetch([])
    try {
      const result = await c.handler(
        rollbackContext({
          entries: [
            {
              name: 'Session ID',
              existed: true,
              id: 4100,
              identifier: 'x',
              expressions: [{ logSourceTypeId: CISCO_TYPE_ID, existed: true, id: 7200 }],
            },
          ],
        }),
      )

      assert.equal(calls.length, 0, 'nothing was recorded to restore, so nothing is written')
      assert.equal(result.success, true)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: an object already gone is not an error`, async () => {
    const { restore } = recordFetch([notFound(), notFound()])
    try {
      const result = await c.handler(rollbackContext({ entries: [CREATED_ENTRY] }))

      assert.equal(result.success, true, '404 is the state rollback was trying to reach')
      assert.match(String(result.message), /2 deleted/)
    } finally {
      restore()
    }
  })

  test(`${c.label} rollback: a rejected restore is a failed result, not a thrown error`, async () => {
    const { restore } = recordFetch([
      qradarError(409, 'The property expression is in use by an active rule'),
      ok({}),
    ])
    try {
      const result = await c.handler(rollbackContext({ entries: [UPDATED_ENTRY] }))

      assert.equal(result.success, false)
      assert.match(String(result.message), /in use by an active rule/)
      assert.equal(leaksToken(result), false)
    } finally {
      restore()
    }
  })
}

// --- driftDetect --------------------------------------------------------------

/** Register the drift contract both custom-property configuration types share. */
export function registerCustomPropertyDriftContract(c: CustomPropertyDriftContract): void {
  const REGEX = regexPath(c.base)

  registerDriftGuardContract({ label: c.label, handler: c.handler, sampleItems: [propertyItem()] })

  test(`${c.label} driftDetect: reports in sync when the live property matches`, async () => {
    const { calls, restore } = recordFetch([list([liveProperty()])])
    try {
      const result = await c.handler(driftContext([propertyItem()]))

      assert.equal(calls.length, 1)
      assert.equal(pathOf(calls[0]), REGEX)
      assert.equal(calls[0].range, 'items=0-9999')
      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
      assert.equal(result.checked, undefined, 'absent `checked` means "I looked and it matched"')
      assert.equal(writeCalls(calls).length, 0)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: compares the deployed config, not the current canvas`, async () => {
    // `driftContext` puts a decoy item on `ctx.canvas`. A handler reading the
    // canvas would report the real property as missing.
    const { restore } = recordFetch([list([liveProperty()])])
    try {
      const result = await c.handler(driftContext([propertyItem()]))

      assert.equal(result.hasDrift, false)
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a property deleted in the console as critical`, async () => {
    const { restore } = recordFetch([list([liveProperty({ name: 'Something Else' })])])
    try {
      const result = await c.handler(driftContext([propertyItem()]))

      assert.equal(result.hasDrift, true)
      assert.deepEqual(result.diffs, [
        { field: 'Session ID', expected: 'present', actual: 'absent', severity: 'critical' },
      ])
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a property type changed in the console`, async () => {
    // The type decides how QRadar indexes and compares the extracted value, so
    // a silent switch from string to numeric breaks every rule that uses it.
    const { restore } = recordFetch([list([liveProperty({ property_type: 'numeric' })])])
    try {
      const result = await c.handler(driftContext([propertyItem()]))

      assert.equal(result.hasDrift, true)
      const diff = result.diffs.find((d) => d.field === 'Session ID.propertyType')
      assert.ok(diff)
      assert.equal(diff.expected, 'string')
      assert.equal(diff.actual, 'numeric')
      assert.equal(diff.severity, 'warning')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: reports a description edited in the console`, async () => {
    const { restore } = recordFetch([list([liveProperty({ description: 'edited by hand' })])])
    try {
      const result = await c.handler(driftContext([propertyItem()]))

      const diff = result.diffs.find((d) => d.field === 'Session ID.description')
      assert.ok(diff)
      assert.equal(diff.actual, 'edited by hand')
    } finally {
      restore()
    }
  })

  test(`${c.label} driftDetect: an empty deployed config checks nothing`, async () => {
    const { restore } = recordFetch([list([liveProperty()])])
    try {
      const result = await c.handler(driftContext([]))

      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
    } finally {
      restore()
    }
  })

  // NOTE: there is deliberately NO test asserting what this handler does when a
  // declared property's EXPRESSIONS have been rewritten in the console. It reads
  // only `regex_properties` and compares `property_type` and `description`, so a
  // property whose extraction regex was changed reports in sync — a conclusion
  // the run never reached. Asserting it either way would document the gap as
  // intended; it is in the defect report instead.
}

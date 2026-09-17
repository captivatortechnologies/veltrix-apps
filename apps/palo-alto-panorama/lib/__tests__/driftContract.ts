// =============================================================================
// The `driftDetect` contract every Panorama configuration type must satisfy.
//
// Drift reads the DEPLOYED configuration (not the canvas currently being
// edited), lists the collection once, and compares each declared object's
// managed fields to what Panorama holds now. Anything that differs becomes a
// diff; anything that has gone becomes critical drift. It then makes a
// best-effort pass over the PAN-OS config audit log to say WHO changed it.
//
// The things that actually go wrong here:
//
//   * Drift must never write. `hasDrift: true` is a report, not a remediation,
//     and a drift run that commits the candidate config activates whatever else
//     is pending on that Panorama.
//
//   * `hasDrift: false` is a POSITIVE assurance — the platform marks outstanding
//     drift records resolved on the strength of it. A run that could not read
//     the live state must not produce one.
//
//   * Attribution is best-effort and must stay that way: an unreadable audit log
//     may cost the "who", never the drift result itself.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import {
  ADMIN_USER,
  CONFIG_LOG_UNAVAILABLE,
  CREDENTIAL_WITHOUT_KEY,
  COMPONENT_WITHOUT_HOSTNAME,
  assertScopedAndAuthenticated,
  configLog,
  configLogCalls,
  driftContext,
  leaksSecret,
  listOk,
  listSingle,
  mutatingCalls,
  restError,
  withPanorama,
  withUnreachablePanorama,
} from './fakePanorama'
import { bystanderEntry, liveInSyncEntry, livePriorEntry, type ConfigFixture } from './configFixture'

type DriftHandler = (ctx: DriftContext) => Promise<DriftResult>

/** Register the driftDetect contract suite for one configuration type. */
export function describeDriftContract(fx: ConfigFixture, driftDetect: DriftHandler): void {
  const label = `panorama ${fx.id} driftDetect`

  /** An audit-log xpath naming this fixture's object, the way PAN-OS records it. */
  const changePath = `/config/devices/entry/device-group/entry[@name='DG-Edge']${fx.resourcePath.toLowerCase()}/entry[@name='${fx.name}']`

  test(`${label} reports no drift when Panorama matches the deployed configuration`, async () => {
    await withPanorama([listOk([bystanderEntry(fx), liveInSyncEntry(fx)])], async (calls) => {
      const result = await driftDetect(driftContext([fx.item]))

      assertScopedAndAuthenticated(assert, calls)
      assert.equal(calls.length, 1, 'one listing answers the whole check')
      assert.equal(calls[0].method, 'GET')
      assert.equal(calls[0].resourcePath, fx.resourcePath)

      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
    })
  })

  test(`${label} reports exactly the fields that changed`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true)
      assert.deepEqual(
        result.diffs.map((d) => ({ field: d.field, expected: d.expected, actual: d.actual, severity: d.severity })),
        fx.drifts,
        'entering the drift branch and emitting fewer diffs than the object has under-reports the change',
      )
    })
  })

  test(`${label} reports an object that has been deleted as critical drift`, async () => {
    await withPanorama([listOk([bystanderEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true)
      assert.equal(result.diffs.length, 1)
      assert.deepEqual(result.diffs[0], {
        field: fx.name,
        expected: 'exists',
        actual: 'missing',
        severity: 'critical',
      })
    })
  })

  test(`${label} reports a read it could not do as drift, not as "in sync"`, async () => {
    await withPanorama([restError(403, 'User is not authorized for this device group')], async (calls) => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(calls.length, 1)
      assert.equal(
        result.hasDrift,
        true,
        'hasDrift:false here would clear real drift recorded by other means, on the strength of a failed read',
      )
      assert.equal(result.diffs.length, 1)
      assert.equal(result.diffs[0].field, 'panorama')
      assert.equal(result.diffs[0].expected, 'reachable')
      assert.match(String(result.diffs[0].actual), /HTTP 403/)
      assert.equal(result.diffs[0].severity, 'critical')
      assert.equal(leaksSecret(result), false)
    })
  })

  test(`${label} reports an unreachable Panorama rather than throwing`, async () => {
    await withUnreachablePanorama(async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true, 'an unreachable Panorama is surfaced, not swallowed')
      assert.equal(result.diffs[0].field, 'panorama')
      assert.match(result.diffs[0].actual, /unreachable/i)
    })
  })

  test(`${label} says it did not check when there is no usable credential`, async () => {
    // A bare `hasDrift: false` is a positive assurance the platform acts on — it
    // resolves the component's outstanding drift record — so a rotated or
    // revoked key would silently clear real drift on every scheduled run.
    await withPanorama([], async (calls) => {
      const result = await driftDetect(driftContext([fx.item], { credential: null }))

      assert.equal(result.hasDrift, false)
      assert.deepEqual(result.diffs, [])
      assert.equal(result.checked, false)
      assert.equal(calls.length, 0)
    })
  })

  test(`${label} never changes the customer's configuration`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async (calls) => {
      await driftDetect(driftContext([fx.item]))

      assert.equal(mutatingCalls(calls).length, 0, 'drift reports; it must not write and must not commit')
    })
  })

  test(`${label} sees an object Panorama returned in the single-entry shape`, async () => {
    await withPanorama([listSingle(liveInSyncEntry(fx))], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, false, 'a collection of one comes back as a bare object, not a one-element array')
    })
  })

  test(`${label} compares the deployed configuration, not the canvas being edited`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async (calls) => {
      const result = await driftDetect(driftContext([], { deployedItems: [fx.item] }))

      assert.equal(calls.length > 0, true, 'an empty working canvas must not mean "nothing is deployed"')
      assert.equal(result.hasDrift, true)
      assert.equal(result.diffs[0].field, fx.drifts[0].field)
    })
  })

  test(`${label} names the administrator who made the change`, async () => {
    await withPanorama(
      [
        listOk([livePriorEntry(fx)]),
        ...configLog([
          { admin: 'ops-admin', cmd: 'set', timeGenerated: '2026/09/15 14:22:01', path: changePath },
        ]),
      ],
      async (calls) => {
        const result = await driftDetect(driftContext([fx.item]))

        const logCalls = configLogCalls(calls)
        assert.equal(logCalls.length, 2, 'the log API is start-then-poll')
        assert.equal(logCalls[0].xmlParams['log-type'], 'config')
        assert.equal(logCalls[0].xmlParams.query, `(path contains '${fx.name}')`)

        assert.equal(result.diffs.length, fx.drifts.length)
        for (const diff of result.diffs) {
          assert.equal(diff.actor?.name, 'ops-admin', 'every diff for one object shares that object’s attribution')
          assert.equal(diff.actor?.at, '2026/09/15 14:22:01')
          assert.equal(diff.actor?.eventType, 'set')
          assert.equal(diff.actor?.source, 'panorama-audit')
        }
      },
    )
  })

  test(`${label} does not attribute the drift to Veltrix's own deploy`, async () => {
    await withPanorama(
      [
        listOk([livePriorEntry(fx)]),
        ...configLog([
          { admin: ADMIN_USER, cmd: 'set', timeGenerated: '2026/09/15 14:22:01', path: changePath },
        ]),
      ],
      async () => {
        const result = await driftDetect(driftContext([fx.item]))

        assert.equal(result.diffs.length, fx.drifts.length)
        for (const diff of result.diffs) {
          assert.equal(
            diff.actor,
            undefined,
            'the connection admin is how our own deploys are recorded — attributing drift to it says nothing',
          )
        }
      },
    )
  })

  test(`${label} still reports the drift when the audit log cannot be read`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true, 'attribution is best-effort; losing the "who" must not lose the "what"')
      assert.equal(result.diffs.length, fx.drifts.length)
      for (const diff of result.diffs) assert.equal(diff.actor, undefined)
    })
  })

  test(`${label} makes no call when the deployed configuration declares nothing`, async () => {
    await withPanorama([], async (calls) => {
      const result = await driftDetect(driftContext([]))

      assert.equal(calls.length, 0)
      assert.deepEqual(result.diffs, [])
    })
  })

  test(`${label} does not reach Panorama or invent diffs without a credential`, async () => {
    // The VERDICT this returns is deliberately not asserted here: a run that
    // never authenticated cannot have established that the live configuration
    // matches, and the handler reports it as though it had. That is reported as
    // a defect rather than pinned down as correct. What must hold either way is
    // that nothing was sent and nothing was invented.
    await withPanorama([], async (calls) => {
      const result = await driftDetect(driftContext([fx.item], { credential: null }))

      assert.equal(calls.length, 0)
      assert.deepEqual(result.diffs, [])
    })
  })

  test(`${label} does not reach Panorama or invent diffs without a usable key or host`, async () => {
    await withPanorama([], async (calls) => {
      const noKey = await driftDetect(driftContext([fx.item], { credential: CREDENTIAL_WITHOUT_KEY }))
      const noHost = await driftDetect(driftContext([fx.item], { component: COMPONENT_WITHOUT_HOSTNAME }))

      assert.equal(calls.length, 0)
      assert.deepEqual(noKey.diffs, [])
      assert.deepEqual(noHost.diffs, [])
    })
  })

  test(`${label} never puts the API key in a diff`, async () => {
    await withPanorama([listOk([livePriorEntry(fx)]), CONFIG_LOG_UNAVAILABLE], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(leaksSecret(result), false, 'drift diffs are stored by the platform and shown to operators')
    })
  })

  test(`${label} probes the configured device group, not shared`, async () => {
    await withPanorama([listOk([])], async (calls) => {
      await driftDetect(driftContext([fx.item], { deviceGroup: 'DG-Branch' }))

      assert.equal(calls[0].location, 'device-group')
      assert.equal(calls[0].deviceGroup, 'DG-Branch')
    })
  })
}

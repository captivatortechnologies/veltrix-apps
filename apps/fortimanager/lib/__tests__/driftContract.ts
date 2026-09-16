// =============================================================================
// The `driftDetect` contract every FortiManager configuration type must satisfy.
//
// Drift reads and compares; it must never write. `hasDrift: false` is a POSITIVE
// assurance — the platform marks any outstanding drift record for the component
// resolved with `resolvedAction: 'drift_cleared'` — so it may only be returned
// when the handler actually read the live table and found it matching.
//
// Two paths are deliberately NOT asserted here, because asserting them would
// document a defect as the contract:
//
//   * no usable credential — the handler returns a bare `{ hasDrift: false }`;
//   * a listing that failed — likewise.
//
// In both cases the handler did not look, so the honest answer is
// `checked: false` (see docs/HANDLER-CORRECTNESS.md, failure class 3). The tests
// below therefore only assert what those paths unambiguously must do — reach
// the vendor not at all, or write nothing — and leave the conclusion alone. The
// defect is reported separately rather than blessed by a test.
// =============================================================================

import test from 'node:test'
import assert from 'node:assert/strict'
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import {
  ADOM,
  CREDENTIAL_WITHOUT_PASSWORD,
  LOGIN_OK,
  LOGOUT_OK,
  assertLoggedInFirst,
  assertLoggedOut,
  driftContext,
  leaksSecret,
  mutatingCalls,
  rpcError,
  rpcOk,
  withFmg,
  withUnreachableFmg,
} from './fakeFmg'
import { leaksFixtureSecret, urlFor, type ConfigFixture } from './configFixture'

type DriftHandler = (ctx: DriftContext) => Promise<DriftResult>

/** Register the driftDetect contract suite for one configuration type. */
export function describeDriftContract(fx: ConfigFixture, driftDetect: DriftHandler): void {
  const label = `fortimanager ${fx.id} driftDetect`
  const url = urlFor(fx, ADOM)

  test(`${label} does not reach FortiManager without a usable credential`, async () => {
    for (const over of [{ credential: null }, { credential: CREDENTIAL_WITHOUT_PASSWORD }, { settings: {} }]) {
      await withFmg([], async (calls) => {
        await driftDetect(driftContext([fx.item], over))

        assert.equal(calls.length, 0)
      })
    }
  })

  test(`${label} reads the ADOM object table once and writes nothing`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.liveInSync]), LOGOUT_OK], async (calls) => {
      await driftDetect(driftContext([fx.item]))

      const work = assertLoggedInFirst(assert, calls)
      assert.equal(work.length, 1, 'drift is one read')
      assert.equal(work[0].rpcMethod, 'get')
      assert.equal(work[0].rpcUrl, url)
      assert.equal(mutatingCalls(calls).length, 0, 'a drift check that writes has changed what it was measuring')
      assertLoggedOut(assert, calls)
    })
  })

  test(`${label} reports no drift when the live object matches what was deployed`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.liveInSync]), LOGOUT_OK], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.deepEqual(result.diffs, [], 'an in-sync object must produce no diffs')
      assert.equal(result.hasDrift, false)
    })
  })

  test(`${label} reports the field that changed under the operator's feet`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.livePrior]), LOGOUT_OK], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true)
      assert.ok(
        result.diffs.some((d) => d.field === fx.driftField),
        `expected a diff on ${fx.driftField}, got ${JSON.stringify(result.diffs.map((d) => d.field))}`,
      )
      assert.ok(
        result.diffs.length > 0,
        'entering the drift branch and emitting no diff reports in sync for a changed object',
      )
    })
  })

  test(`${label} reports a declared object missing from the ADOM as critical drift`, async () => {
    await withFmg([LOGIN_OK, rpcOk([]), LOGOUT_OK], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(result.hasDrift, true)
      const missing = result.diffs.find((d) => d.field === fx.name)
      assert.ok(missing, `expected a diff naming the absent object, got ${JSON.stringify(result.diffs)}`)
      assert.equal(missing!.expected, 'present')
      assert.equal(missing!.actual, 'absent')
      assert.equal(missing!.severity, 'critical')
    })
  })

  test(`${label} compares the DEPLOYED configuration, not the current canvas`, async () => {
    // The canvas may already have been edited; drift asks whether the vendor
    // still matches what was last DEPLOYED through it. Here the canvas declares
    // nothing and the deployed config declares the object, so a handler reading
    // the wrong snapshot finds nothing to compare and reports in sync.
    await withFmg([LOGIN_OK, rpcOk([]), LOGOUT_OK], async () => {
      const result = await driftDetect(driftContext([], { deployedItems: [fx.item] }))

      assert.equal(result.hasDrift, true)
      assert.ok(
        result.diffs.some((d) => d.field === fx.name),
        'a deployed object that is gone from the ADOM is drift, whatever the canvas now says',
      )
    })
  })

  test(`${label} scopes its read to the configured ADOM`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.liveInSync]), LOGOUT_OK], async (calls) => {
      await driftDetect(driftContext([fx.item], { adom: 'customer-a' }))

      const reads = calls.filter((c) => c.rpcMethod === 'get')
      assert.equal(reads.length, 1)
      assert.equal(reads[0].rpcUrl, urlFor(fx, 'customer-a'))
    })
  })

  test(`${label} never puts a secret in its diffs`, async () => {
    await withFmg([LOGIN_OK, rpcOk([fx.livePrior]), LOGOUT_OK], async () => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.equal(leaksSecret(result), false)
      assert.equal(
        leaksFixtureSecret(fx, result),
        false,
        'a diff is stored and rendered — a write-only secret must never be one side of it',
      )
    })
  })

  test(`${label} writes nothing when the listing is refused`, async () => {
    // The conclusion this path returns is deliberately unasserted: the handler
    // cannot distinguish "no drift" from "could not look" — see the file header.
    await withFmg([LOGIN_OK, rpcError('no permission for the resource', -6), LOGOUT_OK], async (calls) => {
      await driftDetect(driftContext([fx.item]))

      assert.equal(mutatingCalls(calls).length, 0)
    })
  })

  test(`${label} does not throw when FortiManager is unreachable`, async () => {
    await withUnreachableFmg(async (calls) => {
      const result = await driftDetect(driftContext([fx.item]))

      assert.notEqual(result, undefined, 'a throw surfaces as a pipeline crash instead of a drift report')
      assert.equal(mutatingCalls(calls).length, 0)
    })
  })
}

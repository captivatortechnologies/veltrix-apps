// =============================================================================
// What one FortiManager configuration type looks like, for the shared contract
// suites.
//
// All 32 configuration types in this app compile the SAME five handler bodies.
// deploy is list -> upsert -> reconcile-delete; rollback is restore-or-delete;
// healthCheck is one `get` on the ADOM table; driftDetect is one `get` and a
// field-by-field compare; getStatus never leaves the platform. Only four things
// vary: the ADOM object path, the mkey, the canvas fields, and the nouns in the
// messages.
//
// So each configuration type describes ITSELF here and the assertions live once
// in the contract suites next to this file. Thirty-two hand-copied suites would
// assert the same things thirty-two times and drift apart the first time one of
// them changed.
//
// Building a fixture: read the handler's extractor FIRST. More failures in this
// programme have been the fixture's fault than the code's — `fields` must use
// the exact keys `extract*Specs` reads, and `body` must be exactly what
// `build*Body` produces for that item.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'

export interface ConfigFixture {
  /** The configuration type id, used to label every suite. */
  id: string
  /**
   * The object path BELOW the ADOM, e.g. `/obj/firewall/address`. The suites
   * build `/pm/config/adom/<adom>` + this, so they can prove the path is scoped
   * to the configured ADOM rather than hard-coded to root.
   */
  objectPath: string
  /**
   * The FortiManager mkey — the attribute a delete filters on. `name` for every
   * type but shaping profiles, whose table is keyed by `profile-name`.
   */
  mkey?: string
  /** The canvas field carrying the identity. `name` everywhere but shaping profiles. */
  nameField?: string
  /** The `checks[0].name` healthCheck reports. */
  checkName: string
  /** The identity of {@link item} — the mkey value. */
  name: string
  /** One canvas item, with the exact field keys this type's extractor reads. */
  item: CanvasItemSnapshot
  /** Exactly the body deploy must send for {@link item}. */
  body: Record<string, unknown>
  /**
   * The object as FortiManager returns it TODAY: same mkey, deliberately
   * different from {@link item} in at least one managed field. Deploy must
   * record this — not the desired canvas values — as the rollback prior.
   */
  livePrior: Record<string, unknown>
  /** `snapshotLive(livePrior)` — what deploy must write into rollbackData. */
  priorSnapshot: Record<string, unknown>
  /** A live object that matches {@link item} exactly: drift must find nothing. */
  liveInSync: Record<string, unknown>
  /** The diff field drift must report when live is {@link livePrior}. */
  driftField: string
  /**
   * A write-only secret this type's canvas carries (an LDAP bind password, a
   * RADIUS shared secret, an FSSO agent password). It is sent to FortiManager
   * on every deploy and never read back, so it must not turn up in a result
   * message, in rollbackData or in a drift diff — all of which are stored by
   * the platform and shown to operators. Absent for types with no secret field.
   */
  writeOnlySecret?: string
  /** Deploy's success message for one object, verbatim. */
  deploySuccess: string
  /** Deploy's failure-message prefix, up to and including "failed". */
  deployFailurePrefix: string
  /** Rollback's success-message prefix, up to but not including the counts. */
  rollbackPrefix: string
}

/** The ADOM-scoped object path this fixture's handlers build. */
export function urlFor(fx: ConfigFixture, adom: string): string {
  return `/pm/config/adom/${adom}${fx.objectPath}`
}

/** The attribute a delete filters on. */
export function mkeyOf(fx: ConfigFixture): string {
  return fx.mkey ?? 'name'
}

/** True when this type's write-only canvas secret appears anywhere in `value`. */
export function leaksFixtureSecret(fx: ConfigFixture, value: unknown): boolean {
  if (!fx.writeOnlySecret) return false
  return (JSON.stringify(value ?? null) ?? '').includes(fx.writeOnlySecret)
}

/** The same canvas item under a different identity, for multi-item scenarios. */
export function renamed(fx: ConfigFixture, name: string): CanvasItemSnapshot {
  return { ...fx.item, name, fields: { ...fx.item.fields, [fx.nameField ?? 'name']: name } }
}

// =============================================================================
// What one Panorama configuration type looks like, for the shared contract
// suites.
//
// All 23 configuration types in this app compile the SAME five handler bodies:
// every one of them is a three-line call into `lib/pipeline.ts`. deploy is
// list -> POST-or-PUT -> commit; rollback is delete-what-we-created -> commit;
// healthCheck is one REST list plus a presence check per declared object;
// driftDetect is one REST list and a field-by-field compare; getStatus never
// leaves the platform. Only four things vary: the REST resource path, the canvas
// fields, the entry body those fields build, and the nouns in the messages.
//
// So each configuration type describes ITSELF here and the assertions live once
// in the contract suites next to this file. Twenty-three hand-copied suites
// would assert the same things twenty-three times and drift apart the first time
// one of them changed.
//
// Building a fixture: read the handler's extractor FIRST. More failures in this
// programme have been the fixture's fault than the code's — `item.fields` must
// use the exact keys `extract*Specs` reads, and `fields` must be exactly what
// `build*Fields` produces for that item, defaults included.
// =============================================================================

import type { CanvasItemSnapshot, DriftDiff } from '@veltrixsecops/app-sdk'
import { DEVICE_GROUP } from './fakePanorama'

export interface ConfigFixture {
  /** The configuration type id, used to label every suite. */
  id: string
  /**
   * The REST resource path below `/restapi/<version>`, e.g. "/Objects/Addresses".
   * The suites assert it on the wire, together with the device-group scoping.
   */
  resourcePath: string
  /** The noun deploy and rollback use in their messages, e.g. "address object(s)". */
  typeLabel: string
  /** The noun healthCheck prefixes its per-object check names with. */
  healthLabel: string

  /** The identity of {@link item} — the PAN-OS object name. */
  name: string
  /** One canvas item, with the exact field keys this type's extractor reads. */
  item: CanvasItemSnapshot
  /** Exactly the entry fields deploy must send for {@link item}. */
  fields: Record<string, unknown>

  /** The identity of {@link secondItem}. */
  secondName: string
  /** A second, different object — for ordering and partial-failure scenarios. */
  secondItem: CanvasItemSnapshot
  /** Exactly the entry fields deploy must send for {@link secondItem}. */
  secondFields: Record<string, unknown>

  /**
   * The object as Panorama returns it when it matches the canvas exactly.
   * Drift must find nothing against this. Identity attributes are added by
   * {@link liveEntry} — this holds managed fields only.
   */
  liveInSync: Record<string, unknown>
  /**
   * The object as Panorama returns it TODAY: the same name, deliberately
   * different from {@link item}. Deploy must see it as existing (and UPDATE
   * rather than create), and drift must report exactly {@link drifts} against it.
   */
  livePrior: Record<string, unknown>
  /**
   * Every diff drift must report when live is {@link livePrior}, in order. The
   * whole list, not a sample: a comparator that enters the drift branch and
   * emits fewer diffs than the object actually has under-reports the change.
   */
  drifts: Array<Pick<DriftDiff, 'field' | 'expected' | 'actual' | 'severity'>>

  /**
   * A value the CANVAS asks for that the live object does NOT have. Deploy
   * records rollback state before it writes, and that state must describe what
   * was there, never what the operator wanted — so this string must not turn up
   * in rollbackData. The contract also checks the fixture's own honesty: it must
   * appear in {@link fields} and be absent from {@link livePrior}.
   */
  canvasOnlyValue: string
  /**
   * A value the LIVE object has that the canvas does not — the prior state a
   * rollback would have to restore. Named here so the suites can talk about it.
   */
  liveOnlyValue: string
}

/** The object as a REST listing returns it: managed fields plus the identity. */
export function liveEntry(
  fx: ConfigFixture,
  managed: Record<string, unknown>,
  name = fx.name,
  deviceGroup = DEVICE_GROUP,
): Record<string, unknown> {
  return { '@name': name, '@location': 'device-group', '@device-group': deviceGroup, ...managed }
}

/** The live object that matches the canvas. */
export function liveInSyncEntry(fx: ConfigFixture): Record<string, unknown> {
  return liveEntry(fx, fx.liveInSync)
}

/** The live object as it stands before this deploy — one field out of step. */
export function livePriorEntry(fx: ConfigFixture): Record<string, unknown> {
  return liveEntry(fx, fx.livePrior)
}

/** An unrelated object that lives alongside ours and must never be touched. */
export function bystanderEntry(fx: ConfigFixture): Record<string, unknown> {
  return liveEntry(fx, fx.liveInSync, 'not-managed-by-veltrix')
}

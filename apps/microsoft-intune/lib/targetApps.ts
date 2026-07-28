// =============================================================================
// Shared Intune Graph `targetApps` payload builder.
//
// App Protection (MAM) policies and targeted app-config policies bind their
// managed apps via a SEPARATE action, not the create body:
//   POST /deviceAppManagement/<collection>/{id}/targetApps
//   { appGroupType, apps: [{ mobileAppIdentifier: { "@odata.type": …, bundleId|packageId } }] }
// iOS apps are identified by bundleId, Android apps by packageId. This module
// builds and reads back that payload so both MAM types share one code path.
// =============================================================================

export type MamPlatform = 'ios' | 'android'

export type AppGroupType =
  | 'selectedPublicApps'
  | 'allApps'
  | 'allMicrosoftApps'
  | 'allCoreMicrosoftApps'

export interface TargetAppsSpec {
  platform: MamPlatform
  /** Bundle ids (iOS) or package ids (Android). Ignored unless appGroupType is selectedPublicApps. */
  appIds: string[]
  appGroupType: AppGroupType
}

export interface TargetAppsBody {
  appGroupType: AppGroupType
  apps: Array<{ mobileAppIdentifier: Record<string, unknown> }>
  // Index signature keeps it assignable to a Record<string, unknown> request body.
  [key: string]: unknown
}

/** The @odata.type + id key for a managed-app identifier on each platform. */
function appIdentifier(platform: MamPlatform, appId: string): Record<string, unknown> {
  return platform === 'ios'
    ? { '@odata.type': '#microsoft.graph.iosMobileAppIdentifier', bundleId: appId }
    : { '@odata.type': '#microsoft.graph.androidMobileAppIdentifier', packageId: appId }
}

/** Build the `targetApps` action body. Apps are only sent for selectedPublicApps. */
export function buildTargetApps(spec: TargetAppsSpec): TargetAppsBody {
  const apps =
    spec.appGroupType === 'selectedPublicApps'
      ? spec.appIds.map((appId) => ({ mobileAppIdentifier: appIdentifier(spec.platform, appId) }))
      : []
  return { appGroupType: spec.appGroupType, apps }
}

/** Read the targeted bundle/package ids off a live policy's `apps` collection. */
export function readTargetedAppIds(
  platform: MamPlatform,
  apps: Array<{ mobileAppIdentifier?: Record<string, unknown> }> | undefined,
): string[] {
  const key = platform === 'ios' ? 'bundleId' : 'packageId'
  const ids: string[] = []
  for (const app of apps ?? []) {
    const value = app.mobileAppIdentifier?.[key]
    if (typeof value === 'string' && value) ids.push(value)
  }
  return ids
}

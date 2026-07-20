// =============================================================================
// Row mappers — translate raw snake_case Postgres rows from the app's own
// tables into the camelCase shapes the API and client pages already expect.
//
// The app talks to its tables through the platform's raw-query escape hatches
// ($queryRawUnsafe / $executeRawUnsafe); there is no generated Prisma model for
// an app-owned table. These mappers are the single place that shape is defined.
// =============================================================================

import {
  parsePlacement,
  normalizeControlPlaneLayout,
  type ClusterPlacement,
  type ControlPlaneLayout,
} from '../byolPlacement'
import { deriveLicenseStatus, type LicenseStatus } from '../licenseXml'

export type Row = Record<string, any>

export interface SplunkVersionDto {
  id: string
  version: string
  releaseDate: Date
  downloadUrl: string | null
  releaseNotes: string | null
  isActive: boolean
  isLatest: boolean
  features: unknown
  // Owner scope: null customer_id = a system version shown to every tenant;
  // otherwise the owning company. `system` is the convenience flag the UI uses
  // to gate edit/delete (tenants may only manage their own versions).
  customerId: string | null
  system: boolean
  createdAt: Date
  updatedAt: Date
}

export function mapVersion(r: Row): SplunkVersionDto {
  return {
    id: r.id,
    version: r.version,
    releaseDate: r.release_date,
    downloadUrl: r.download_url ?? null,
    releaseNotes: r.release_notes ?? null,
    isActive: r.is_active,
    isLatest: r.is_latest,
    features: r.features ?? null,
    customerId: r.customer_id ?? null,
    system: r.customer_id == null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// --- Recorded Splunk license (migration 013) --------------------------------

export interface SplunkLicenseDto {
  id: string
  label: string
  licenseType: string
  groupId: string
  stackId: string
  quotaBytes: number
  windowPeriod: number
  maxViolations: number
  creationTime: Date | null
  expirationTime: Date | null
  guid: string
  features: string[]
  /** Derived display status (active | expiring-soon | expired | unknown). */
  status: LicenseStatus
  /** Whole days until expiry; negative once expired, null when no expiration. */
  daysToExpiry: number | null
  createdAt: Date
  updatedAt: Date
}

export function mapLicense(r: Row): SplunkLicenseDto {
  // quota is a BIGINT column — the raw driver may hand it back as a BigInt or a
  // string, so normalize through Number. Realistic license quotas fit a double.
  const expirationTime = r.expiration_time ? new Date(r.expiration_time) : null
  const { status, daysToExpiry } = deriveLicenseStatus(expirationTime)
  return {
    id: r.id,
    label: r.label ?? '',
    licenseType: r.license_type ?? '',
    groupId: r.group_id ?? '',
    stackId: r.stack_id ?? '',
    quotaBytes: r.quota_bytes == null ? 0 : Number(r.quota_bytes),
    windowPeriod: r.window_period == null ? 0 : Number(r.window_period),
    maxViolations: r.max_violations == null ? 0 : Number(r.max_violations),
    creationTime: r.creation_time ? new Date(r.creation_time) : null,
    expirationTime,
    guid: r.guid ?? '',
    // JSONB round-trips as a parsed array via the raw driver; be defensive.
    features: Array.isArray(r.features) ? r.features.map(String) : [],
    status,
    daysToExpiry,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface RegionDto {
  id: string
  region: string
  infrastructureId: string
  customerId: string
  createdAt: Date
  updatedAt: Date
}

export function mapRegion(r: Row): RegionDto {
  return {
    id: r.id,
    region: r.region,
    infrastructureId: r.infrastructure_id,
    customerId: r.customer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export interface ByolDto {
  id: string
  name: string
  deploymentType: string
  environmentType: string
  indexerCount: number
  searchHeadCount: number
  status: string
  customerId: string
  cloudProviderId: string | null
  // Kept snake_case to preserve the existing API contract.
  github_deployment_id: string | null
  hosting_type: string
  region: string | null
  // Deployment target (hosted vs BYOC) — see migration 009.
  networkMode: string
  dnsMode: string
  cloudAccountConnectionId: string | null
  // Topology authoring (control-plane consolidation, forwarders, placement) — see migration 010.
  controlPlaneLayout: ControlPlaneLayout
  heavyForwarderCount: number
  indexerPlacement: ClusterPlacement | null
  searchHeadPlacement: ClusterPlacement | null
  /** Compute size override for every node; null = cloud default. See migration 011. */
  instanceType: string | null
  /** Selected Splunk version catalog entry id; null = no selection (deploy uses its own default). See migration 012. */
  versionId: string | null
  createdAt: Date
  updatedAt: Date
  indexerRegions: RegionDto[]
  searchHeadRegions: RegionDto[]
  splunkUpgrade: unknown | null
}

export function mapByol(r: Row): ByolDto {
  return {
    id: r.id,
    name: r.name,
    deploymentType: r.deployment_type,
    environmentType: r.environment_type,
    indexerCount: r.indexer_count,
    searchHeadCount: r.search_head_count,
    status: r.status,
    customerId: r.customer_id,
    cloudProviderId: r.cloud_provider_id ?? null,
    github_deployment_id: r.github_deployment_id ?? null,
    hosting_type: r.hosting_type,
    region: r.region ?? null,
    networkMode: r.network_mode ?? 'shared',
    dnsMode: r.dns_mode ?? 'managed',
    cloudAccountConnectionId: r.cloud_account_connection_id ?? null,
    controlPlaneLayout: normalizeControlPlaneLayout(r.control_plane_layout),
    heavyForwarderCount: Number(r.heavy_forwarder_count ?? 1),
    indexerPlacement: parsePlacement(r.indexer_placement),
    searchHeadPlacement: parsePlacement(r.search_head_placement),
    instanceType: r.instance_type ?? null,
    versionId: r.version_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    indexerRegions: [],
    searchHeadRegions: [],
    splunkUpgrade: null,
  }
}

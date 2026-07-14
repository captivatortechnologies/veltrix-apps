// =============================================================================
// Row mappers — translate raw snake_case Postgres rows from the app's own
// tables into the camelCase shapes the API and client pages already expect.
//
// The app talks to its tables through the platform's raw-query escape hatches
// ($queryRawUnsafe / $executeRawUnsafe); there is no generated Prisma model for
// an app-owned table. These mappers are the single place that shape is defined.
// =============================================================================

export type Row = Record<string, any>

export interface IndexDefaultDto {
  id: string
  name: string
  maxEventSize: number
  enableCompression: boolean
  retentionPeriod: number
  searchablePeriod: number
  enableTsidx: boolean
  frozenTimePeriod: number
  requireApproval: boolean
  customerId: string
  createdAt: Date
  updatedAt: Date
  environments: unknown[]
}

export function mapIndexDefault(r: Row): IndexDefaultDto {
  return {
    id: r.id,
    name: r.name,
    maxEventSize: r.max_event_size,
    enableCompression: r.enable_compression,
    retentionPeriod: r.retention_period,
    searchablePeriod: r.searchable_period,
    enableTsidx: r.enable_tsidx,
    frozenTimePeriod: r.frozen_time_period,
    requireApproval: r.require_approval,
    customerId: r.customer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Environment tags reference the PLATFORM Tag entity; the app stores only
    // tag_id and never joins across the boundary, so this is populated by the
    // (future) tag-management path, empty until then.
    environments: [],
  }
}

export interface RoleDefaultDto {
  id: string
  name: string
  description: string | null
  defaultPermissions: string[]
  requireApproval: boolean
  customerId: string
  createdAt: Date
  updatedAt: Date
  environments: unknown[]
}

export function mapRoleDefault(r: Row): RoleDefaultDto {
  return {
    id: r.id,
    name: r.name,
    description: r.description ?? null,
    defaultPermissions: r.default_permissions ?? [],
    requireApproval: r.require_approval,
    customerId: r.customer_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    environments: [],
  }
}

export interface SplunkVersionDto {
  id: string
  version: string
  releaseDate: Date
  downloadUrl: string | null
  releaseNotes: string | null
  isActive: boolean
  isLatest: boolean
  features: unknown
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    indexerRegions: [],
    searchHeadRegions: [],
    splunkUpgrade: null,
  }
}

// ========================================================================
// App manifest types
//
// Self-contained copy of the platform's manifest contract so the SDK can
// be published and consumed outside the platform monorepo. The platform
// keeps its own copy in shared/types/app.ts — changes to the manifest
// contract must be applied to both files.
// ========================================================================

export type AppSource = 'BUILT_IN' | 'MARKETPLACE' | 'CUSTOM'
export type AppStatusType = 'AVAILABLE' | 'DEPRECATED' | 'REMOVED'
export type AppInstallationStatus =
  | 'INSTALLING'
  | 'INSTALLED'
  | 'ENABLED'
  | 'DISABLED'
  | 'FAILED'
  | 'UNINSTALLING'

// --- Manifest Types (parsed from manifest.yaml) ---

export interface AppManifest {
  id: string
  name: string
  version: string
  vendor: string
  description: string
  category: string
  license?: string
  homepage?: string
  icon?: string
  logo?: string

  platform: {
    minVersion: string
  }

  permissions: {
    platform: string[] // Platform permissions the app needs
    app: AppPermissionDeclaration[] // Permissions the app exposes
  }

  database?: {
    migrations: string
    tablePrefix: string
  }

  pipeline: {
    configurationTypes: AppConfigurationTypeManifest[]
    pipelineEvents?: string[]
  }

  server: {
    entry: string
    routes?: {
      prefix: string
    }
  }

  client?: {
    entry: string
    pages?: AppPageDeclaration[]
  }

  hooks?: {
    onInstall?: string
    onUninstall?: string
    onEnable?: string
    onDisable?: string
    onUpgrade?: string
  }

  events?: string[] // Platform events this app subscribes to

  settings?: AppSettingDeclaration[]
}

export interface AppConfigurationTypeManifest {
  id: string
  name: string
  description?: string
  canvasTemplate: string // Path to canvas template YAML
  defaultConfig?: string // Path to default config YAML

  handlers: {
    validate: string
    deploy: string
    rollback: string
    healthCheck: string
    driftDetect?: string | null
    getStatus: string
  }

  targets: {
    componentTypes: string[]
    requiresCredential: boolean
    requiresConnectivity: boolean
  }
}

export interface AppPermissionDeclaration {
  resource: string
  actions: string[]
  description?: string
}

export interface AppPageDeclaration {
  path: string
  component: string
  label: string
  icon?: string
  sidebar?: boolean
  parent?: string
}

export interface AppSettingDeclaration {
  key: string
  type: 'string' | 'number' | 'boolean' | 'select'
  label: string
  description?: string
  default?: string | number | boolean
  required?: boolean
  options?: Array<{ label: string; value: string }>
}

// --- API Response Types ---

export interface AppListItem {
  id: string
  appId: string
  name: string
  version: string
  vendor: string
  description: string
  category: string
  icon?: string
  logo?: string
  source: AppSource
  isDefault: boolean
  status: AppStatusType
  installed?: boolean
  enabled?: boolean
}

export interface AppDetail extends AppListItem {
  license?: string
  homepage?: string
  repository?: string
  configurationTypes: Array<{
    id: string
    name: string
    description?: string
    componentTypes: string[]
  }>
  permissions: AppPermissionDeclaration[]
  settings: AppSettingDeclaration[]
}

export interface AppInstallationDetail {
  id: string
  appId: string
  customerId: string
  version: string
  enabled: boolean
  installedBy: string
  installedAt: string
  settings: Record<string, unknown>
  status: AppInstallationStatus
  app: AppListItem
}

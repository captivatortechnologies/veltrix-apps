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
    /**
     * How the platform lays out this app's navigation (its client pages and
     * one entry per configuration type):
     *   - 'tabs' (default): a horizontal tab strip — best for a few items.
     *   - 'sidebar': an embedded left rail, grouped into Pages and
     *     Configurations — scales to many configuration types without the
     *     tab strip overflowing.
     */
    navLayout?: 'tabs' | 'sidebar'
  }

  /**
   * Vendor brand identity, applied by the platform in defined slots only —
   * the app navbar (logo, accent) and scoped CSS variables. The platform,
   * not the app, decides where brand color appears, so one vendor's palette
   * never overwhelms the product shell.
   */
  branding?: AppBrandingDeclaration

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

/**
 * App brand identity. The platform renders it in a per-app navbar above the
 * app's pages and exposes the colors to app pages as scoped CSS variables
 * (--veltrix-app-primary, --veltrix-app-accent).
 */
export interface AppBrandingDeclaration {
  /** Brand accent color as #RGB or #RRGGBB hex (e.g. CrowdStrike red). */
  primaryColor?: string
  /** Optional secondary color as #RGB or #RRGGBB hex. */
  accentColor?: string
  /**
   * Vendor logo shown in the app navbar. Repo-relative .svg (preferred) or
   * .png, at most 128 KB; rendered at 28px height, so use a wide/landscape
   * mark with transparent background.
   */
  logo?: string
  /** Optional logo variant for dark backgrounds; same constraints as logo. */
  logoDark?: string
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

// --- App UI & navigation contract ---
//
// The platform owns the chrome: breadcrumb, app header, navigation, permission
// gating, error boundary and loading states are rendered identically for every
// app. Apps own the page body and compose it from @veltrixsecops/ui.
// Predictable shell, flexible body.

/**
 * How the platform frames an app page.
 * - `standard`   — page header + padded content area (default; use for most pages)
 * - `full-bleed` — content area with no padding/toolbar (custom canvases, maps)
 * - `canvas`     — Configuration Canvas chrome (section rail + save/validate bar)
 */
export type AppPageLayout = 'standard' | 'full-bleed' | 'canvas'
export const APP_PAGE_LAYOUTS = ['standard', 'full-bleed', 'canvas'] as const

/**
 * Where the page surfaces in navigation.
 * - `sidebar` — an entry beneath the app in the sidebar
 * - `tab`     — a tab within its `parent` page
 * - `hidden`  — routable but not linked (details/drill-down pages)
 */
export type AppPageNav = 'sidebar' | 'tab' | 'hidden'
export const APP_PAGE_NAV = ['sidebar', 'tab', 'hidden'] as const

/** An app-scoped permission (declared in `permissions.app`) required to see a page. */
export interface AppPagePermission {
  resource: string
  action: string
}

export interface AppPageDeclaration {
  /** Route beneath the app, e.g. `/indexes` → `/apps/<app-id>/indexes` */
  path: string
  /** Exported component name from the app's client entry */
  component: string
  label: string
  description?: string
  /** Icon name from the platform icon set; falls back to the app icon */
  icon?: string
  /** @deprecated use `nav: 'sidebar' | 'hidden'` — kept for backward compatibility */
  sidebar?: boolean
  /** Navigation placement. Defaults to `sidebar` when `sidebar: true`, else `hidden`. */
  nav?: AppPageNav
  /** Parent page `path` — required for `nav: 'tab'`, optional nesting for sidebar entries */
  parent?: string
  /** Optional sidebar section label, for apps with many pages */
  group?: string
  /** Deterministic ordering within its group/parent (ascending; ties break on label) */
  order?: number
  /** Layout preset the platform renders around the page body */
  layout?: AppPageLayout
  /** Hide the page (and its nav entry) unless the user holds this app permission */
  requiresPermission?: AppPagePermission
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

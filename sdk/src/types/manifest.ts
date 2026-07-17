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
    /**
     * How the app's tables are namespaced in Postgres.
     *   - 'shared' (default): prefixed tables in the shared `public` schema.
     *     Reserved for trusted first-party apps whose SQL the platform ships.
     *   - 'schema': the app gets its own Postgres schema (+ least-privilege
     *     role); its migrations run with search_path pinned to it.
     *   - 'database': the app gets its own Postgres database — hard,
     *     cross-database-query-proof isolation.
     *   - 'external': the app owns its datastore entirely; the platform manages
     *     no schema for it (connection supplied at runtime via app settings).
     * The platform forces at least 'schema' for marketplace and customer-
     * authored (self-managed) apps, which may opt up to 'database'/'external'.
     */
    isolation?: 'shared' | 'schema' | 'database' | 'external'
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
    /** Handler the platform invokes for inbound webhooks routed to this app. */
    onWebhook?: string
    /** Handler the platform invokes for inbound message-bus events routed to this app. */
    onEvent?: string
  }

  events?: string[] // Platform events this app subscribes to

  /**
   * Connection-level connectivity testing. `testHandler` is an extensionless path
   * to a module whose default export is a `testConnection` handler — the platform
   * runs it in-process (with the decrypted credential) to verify a Connection's
   * endpoint + credentials. Optional: apps without it report "test not supported".
   */
  connectivity?: {
    testHandler?: string
  }

  /**
   * Connection lifecycle declarations. `onboarding` opts the app into the
   * platform's one-click connection onboarding: the app declares what it needs
   * (a named onboarding adapter + parameters) and the platform drives it.
   * Microsoft Entra admin-consent (`provider: 'entra-admin-consent'`) is the
   * first adapter; nothing here is provider-specific to the platform core.
   */
  connection?: AppConnectionDeclaration

  settings?: AppSettingDeclaration[]
}

/** App-declared connection lifecycle capabilities. */
export interface AppConnectionDeclaration {
  onboarding?: ConnectionOnboardingDescriptor
}

/**
 * Declarative "one-click connect" descriptor. The platform reads it to render a
 * "Connect …" button and to drive a named onboarding adapter; the app supplies
 * only data, never platform code.
 */
export interface ConnectionOnboardingDescriptor {
  /** Names a platform onboarding adapter (e.g. `entra-admin-consent`). */
  provider: string
  /** Button label in the Connections UI (e.g. "Connect Microsoft Defender"). */
  label: string
  params?: ConnectionOnboardingParams
  /**
   * Optional app-provided finalize hook (extensionless path). Run in-process
   * after a successful onboarding, exactly like `connectivity.testHandler`.
   */
  onboardingHandler?: string
}

export interface ConnectionOnboardingParams {
  /** App-setting key whose value selects the sovereign cloud (e.g. `azure_cloud`). */
  cloudSetting?: string
  /**
   * App permissions this connection needs — for display + audience selection.
   * The effective grant is fixed on the connector app registration, not here.
   */
  requiredResourceAccess?: OnboardingRequiredResource[]
  /** What the flow captures and where it maps back onto the connection. */
  capture?: OnboardingCapture
  /** True → the connection uses the platform token broker and stores NO secret. */
  brokered?: boolean
  /**
   * App settings the admin must supply BEFORE the consent click (they cannot be
   * derived from consent), e.g. Sentinel's subscription/resource-group/workspace.
   */
  requiredSettings?: string[]
  /** Post-consent provisioning steps the adapter runs (e.g. Sentinel ARM RBAC). */
  provisioning?: OnboardingProvisioningStep[]
}

export interface OnboardingRequiredResource {
  /** Well-known resource name or appId (e.g. `WindowsDefenderATP`, `Graph`). */
  resource: string
  /** Application permissions requested on that resource (display only). */
  appPermissions: string[]
}

export interface OnboardingCapture {
  /**
   * Where to write the consented tenant id. `setting:<key>` writes it into the
   * named app setting (the app libs read it as their `tenant_id`).
   */
  tenantId?: string
}

/** A post-consent provisioning step. Only ARM role assignment exists today. */
export interface OnboardingProvisioningStep {
  type: 'arm-role-assignment'
  /** Well-known built-in role name (resolved to a role-definition id by the adapter). */
  role: string
  /** ARM scope granularity for the assignment. */
  scope: 'resourceGroup' | 'subscription'
  /**
   * How the ARM token for the assignment is obtained:
   *   - `manual` (default): show a portal deep-link/CLI + a verify probe. No
   *     extra platform privilege — consent does not grant ARM RBAC.
   *   - `delegated`: opt-in second delegated-ARM leg (requires the admin to hold
   *     Owner / User Access Administrator). Not implemented in the first cut.
   */
  armToken?: 'manual' | 'delegated'
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
   * Vendor logo shown in the app navbar and on the marketplace card. Either a
   * repo-relative .svg (preferred) or .png at most 128 KB, OR an absolute
   * https:// URL to an externally hosted asset. Rendered at ~28px height, so
   * use a wide/landscape mark with a transparent background.
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

// ========================================================================
// @veltrixsecops/app-sdk
//
// The official SDK for building Veltrix Security-as-Code apps.
//
// This root entry is REACT-FREE and safe to load in a bare Node process.
// Pipeline handlers execute inside the platform's sandbox runner — a child
// process with a scrubbed environment and no React — so the contract they
// import must never pull in a UI dependency. (Before 2.0 this entry
// re-exported the React hooks, which made `require('@veltrixsecops/app-sdk')`
// load React.) The platform can therefore import HANDLER_NAMES and the
// handler contracts directly, instead of mirroring them server-side.
//
// Usage:
//   import type { PipelineContext, DeployContext } from '@veltrixsecops/app-sdk'
//   import { HANDLER_NAMES, conventionalPaths } from '@veltrixsecops/app-sdk'
//   import { defineValidator, defineDeployer } from '@veltrixsecops/app-sdk/pipeline'
//   import { useAppContext, usePipelineStatus } from '@veltrixsecops/app-sdk/hooks'   // React
//   import { authFetch } from '@veltrixsecops/app-sdk/client'                          // browser
// ========================================================================

// Pipeline handler helpers (React-free)
export {
  defineValidator,
  defineDeployer,
  defineRollbackHandler,
  defineHealthChecker,
  defineDriftDetector,
} from './pipeline'

// NOTE: React hooks are NOT re-exported here. Import them from
// '@veltrixsecops/app-sdk/hooks'; browser client helpers live in
// '@veltrixsecops/app-sdk/client'. Keeping them off the root is what makes
// this entry loadable in the sandbox runner's bare Node child process.

// Pipeline types
export type {
  PipelineContext,
  DeployContext,
  RollbackContext,
  HealthCheckContext,
  DriftContext,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  DeployResult,
  RollbackResult,
  HealthCheckResult,
  HealthCheck,
  DriftResult,
  DriftDiff,
  ConfigStatus,
  ComponentConfigStatus,
  CanvasSnapshot,
  CanvasSectionSnapshot,
  DeploymentStrategy,
  EnvironmentRef,
  UserRef,
  ComponentRef,
  CredentialRef,
  ConnectivityRef,
  PlatformDataApi,
  DeploymentSummary,
  ValidateHandler,
  DeployHandler,
  RollbackHandler,
  HealthCheckHandler,
  DriftDetectHandler,
  GetStatusHandler,
} from './types/pipeline'

// Platform types
export type {
  Component,
  InventoryItem,
  InventoryItemInput,
  ConnectivityProviderRef,
  Credential,
  CredentialSummary,
  CredentialInput,
  Connectivity,
  Tag,
  User,
  Customer,
  PlatformDatabaseClient,
  AppHookContext,
  AppRouteContext,
  PermissionEntry,
  PermissionCheckOptions,
  AppPermissionsApi,
} from './types/platform'

// App UI & navigation contract
export { APP_PAGE_LAYOUTS, APP_PAGE_NAV } from './types/manifest'
export type { AppPageLayout, AppPageNav, AppPagePermission } from './types/manifest'

// Manifest types
export type {
  AppManifest,
  AppBrandingDeclaration,
  AppConfigurationTypeManifest,
  AppPermissionDeclaration,
  AppPageDeclaration,
  AppSettingDeclaration,
  AppSource,
  AppStatusType,
  AppInstallationStatus,
  AppListItem,
  AppDetail,
  AppInstallationDetail,
} from './types/manifest'

// Canonical app layout
export { APP_LAYOUT, HANDLER_NAMES, conventionalPaths } from './structure'
export type { HandlerName } from './structure'

// Hooks types
export type { AppContextValue, PipelineStatusData } from './hooks'

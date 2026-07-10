// ========================================================================
// @veltrixsecops/app-sdk
//
// The official SDK for building Veltrix Security-as-Code apps.
// Import pipeline helpers, hooks, and types to build your app.
//
// Usage:
//   import { defineValidator, defineDeployer } from '@veltrixsecops/app-sdk/pipeline'
//   import { useAppContext, usePipelineStatus } from '@veltrixsecops/app-sdk/hooks'
//   import type { PipelineContext, DeployContext } from '@veltrixsecops/app-sdk'
// ========================================================================

// Pipeline handler helpers
export {
  defineValidator,
  defineDeployer,
  defineRollbackHandler,
  defineHealthChecker,
  defineDriftDetector,
} from './pipeline'

// React hooks
export {
  useAppContext,
  AppContext,
  usePipelineStatus,
  useAppBranding,
} from './hooks'

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
  ConnectivityProviderRef,
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
  Credential,
  Connectivity,
  Tag,
  User,
  Customer,
  PlatformDatabaseClient,
  AppHookContext,
  AppRouteContext,
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

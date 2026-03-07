// ========================================================================
// @veltrix/app-sdk
//
// The official SDK for building Veltrix Security-as-Code apps.
// Import pipeline helpers, hooks, and types to build your app.
//
// Usage:
//   import { defineValidator, defineDeployer } from '@veltrix/app-sdk/pipeline'
//   import { useAppContext, usePipelineStatus } from '@veltrix/app-sdk/hooks'
//   import type { PipelineContext, DeployContext } from '@veltrix/app-sdk'
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
  DeploymentStrategy,
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
} from './types/platform'

// Hooks types
export type { AppContextValue, PipelineStatusData } from './hooks'

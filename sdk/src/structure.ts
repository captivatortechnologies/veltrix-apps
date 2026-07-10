// ========================================================================
// Canonical app layout
//
// Every Veltrix app follows one predictable folder structure so apps are
// easy to set up, review, and load. The `veltrix` CLI scaffolds it,
// `veltrix validate` (and repo CI) warn on deviations, and the platform's
// app engine resolves manifest references against it.
// ========================================================================

/** Canonical locations inside an app directory. */
export const APP_LAYOUT = {
  /** The app contract. Always at the app root. */
  manifest: 'manifest.yaml',
  /** Pipeline handlers: handlers/<configTypeId>/<handlerName> (extensionless in the manifest). */
  handlersDir: 'handlers',
  /** Canvas form schemas: templates/<configTypeId>-canvas.yaml */
  templatesDir: 'templates',
  /** Default field values: defaults/<configTypeId>.yaml */
  defaultsDir: 'defaults',
  /** Lifecycle hooks (camelCase): hooks/onInstall, hooks/onUninstall, ... */
  hooksDir: 'hooks',
  /** SQL migrations (requires manifest `database.tablePrefix`). */
  migrationsDir: 'migrations',
  /** Fastify route module receiving (fastify, AppRouteContext). */
  serverEntry: 'server/index',
  /** Client entry registering pages/sidebar items (optional). */
  clientEntry: 'client/index',
  /** Icons and logos (optional). */
  assetsDir: 'assets',
} as const

/** The six pipeline handler names, in lifecycle order. */
export const HANDLER_NAMES = [
  'validate',
  'deploy',
  'rollback',
  'healthCheck',
  'driftDetect',
  'getStatus',
] as const

export type HandlerName = (typeof HANDLER_NAMES)[number]

/**
 * Conventional manifest paths for one configuration type — handy when
 * generating or checking a manifest programmatically.
 *
 * @example
 * conventionalPaths('indexes').handlers.deploy // 'handlers/indexes/deploy'
 */
export function conventionalPaths(configTypeId: string): {
  canvasTemplate: string
  defaultConfig: string
  handlers: Record<HandlerName, string>
} {
  const handlers = {} as Record<HandlerName, string>
  for (const name of HANDLER_NAMES) {
    handlers[name] = `${APP_LAYOUT.handlersDir}/${configTypeId}/${name}`
  }
  return {
    canvasTemplate: `${APP_LAYOUT.templatesDir}/${configTypeId}-canvas.yaml`,
    defaultConfig: `${APP_LAYOUT.defaultsDir}/${configTypeId}.yaml`,
    handlers,
  }
}

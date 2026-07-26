// =============================================================================
// Example App Dashboard Page
//
// Use platform shared components for consistent UI.
// Access pipeline data through the platform's hooks and APIs.
// =============================================================================

import React from 'react'

// These would be imported from @veltrixsecops/app-sdk in production:
// import { useAppContext, useAppSettings, usePipelineStatus } from '@veltrixsecops/app-sdk'

export default function Dashboard() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">
        My App Dashboard
      </h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {/* Stats cards */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Configurations</h3>
          <p className="text-3xl font-bold text-gray-900 dark:text-white mt-2">0</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Deployed</h3>
          <p className="text-3xl font-bold text-green-600 mt-2">0</p>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">Drift Alerts</h3>
          <p className="text-3xl font-bold text-red-600 mt-2">0</p>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          Getting Started
        </h2>
        <p className="text-gray-600 dark:text-gray-300">
          This is your app dashboard. Customize it to show relevant data
          from your tool integration.
        </p>
        <ul className="mt-4 space-y-2 text-gray-600 dark:text-gray-300">
          <li>1. Configure remote connectivity (Settings tab)</li>
          <li>2. Add components (hosts/servers) for your tool</li>
          <li>3. Add credentials for authentication</li>
          <li>4. Create a configuration canvas</li>
          <li>5. Submit for approval and deploy through the pipeline</li>
        </ul>
      </div>

      {/*
        REMOTE CONNECTIVITY:
        To add a Settings page with connectivity provider configuration,
        import the shared component:

          import { ConnectivityProvidersView } from '@/features/connectivity-providers'

        Then render it in your app's settings/config area:
          <ConnectivityProvidersView />

        Supported providers: Tailscale, SSH, WireGuard, Cloudflare Tunnel,
        ZeroTier, Nebula, OpenVPN, AWS SSM, HashiCorp Boundary.

        In pipeline handlers, access the configured provider via:
          ctx.connectivityProvider?.providerType  // 'tailscale', 'ssh', etc.
          ctx.connectivityProvider?.config         // Provider-specific config
      */}
    </div>
  )
}

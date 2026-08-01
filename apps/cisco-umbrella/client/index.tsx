// =============================================================================
// App Client Entry Point
//
// Export one component per page declared in manifest.yaml (`client.pages[].component`).
// The platform renders the chrome around them — breadcrumb, app header, sidebar
// entry / tabs, permission gating, loading and error states. Build page bodies
// from @veltrixsecops/app-sdk/ui so they inherit the tenant's theme.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cisco-umbrella',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cisco-umbrella/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cisco-umbrella/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/cisco-umbrella/connections', label: 'Connections', icon: 'link' },
  ],
}

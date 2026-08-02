import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'authentik',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/authentik/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/authentik/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/authentik/connections', label: 'Connections', icon: 'link' },
  ],
}

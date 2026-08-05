import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'aqua-security',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/aqua-security/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/aqua-security/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/aqua-security/connections', label: 'Connections', icon: 'link' },
  ],
}

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'defender-endpoint',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/defender-endpoint/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/defender-endpoint/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/defender-endpoint/connections', label: 'Connections', icon: 'link' },
  ],
}

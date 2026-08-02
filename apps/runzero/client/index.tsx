import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'runzero',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/runzero/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/runzero/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/runzero/connections', label: 'Connections', icon: 'link' },
  ],
}

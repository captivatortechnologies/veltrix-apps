import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'imperva',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/imperva/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/imperva/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/imperva/connections', label: 'Connections', icon: 'link' },
  ],
}

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'greenbone',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/greenbone/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/greenbone/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/greenbone/connections', label: 'Connections', icon: 'link' },
  ],
}

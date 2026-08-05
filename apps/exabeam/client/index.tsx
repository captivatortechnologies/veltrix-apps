import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'exabeam',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/exabeam/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/exabeam/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/exabeam/connections', label: 'Connections', icon: 'link' },
  ],
}

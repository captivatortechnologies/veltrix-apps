import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'palo-alto-panorama',
  pages: { OverviewPage, SetupGuidePage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/palo-alto-panorama/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/palo-alto-panorama/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/palo-alto-panorama/connections', label: 'Connections', icon: 'link' },
  ],
}

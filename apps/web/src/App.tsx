import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';
import { LibraryPage } from './features/library/LibraryPage';
import { MemoryPage } from './features/memory/MemoryPage';
import { ReviewPage } from './features/review/ReviewPage';
import { SearchPage } from './features/search/SearchPage';
import { StatsPage } from './features/stats/StatsPage';
import { TrashPage } from './features/library/TrashPage';
import { ReaderPage } from './features/reader/ReaderPage';
import { SettingsPage } from './features/settings/SettingsPage';
import { useApplyTheme } from './lib/theme';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'library/t/:topicId', element: <LibraryPage /> },
      { path: 'library/trash', element: <TrashPage /> },
      { path: 'read/:documentId', element: <ReaderPage /> },
      { path: 'memory', element: <MemoryPage /> },
      { path: 'review', element: <ReviewPage /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'stats', element: <StatsPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export function App() {
  useApplyTheme();
  return <RouterProvider router={router} />;
}

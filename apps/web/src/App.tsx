import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppShell } from './components/AppShell';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';
import { LibraryPage } from './features/library/LibraryPage';
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
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

export function App() {
  useApplyTheme();
  return <RouterProvider router={router} />;
}

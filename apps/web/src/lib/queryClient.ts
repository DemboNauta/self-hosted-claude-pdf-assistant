import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** App-wide query cache (also used outside React, e.g. by the chat socket). */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

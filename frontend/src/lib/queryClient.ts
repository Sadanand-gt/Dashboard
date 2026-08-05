import { QueryClient } from '@tanstack/react-query'

// Single app-wide QueryClient. Lives in its own module so the auth store can
// clear it on login/logout — cached report data must NEVER survive a user
// switch (different users have different data scopes and report access).
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
})

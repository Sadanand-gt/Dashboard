import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../api/types'
import { queryClient } from '../lib/queryClient'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  setAuth: (user: User, token: string) => void
  clearAuth: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      setAuth: (user, token) => {
        // A different user (or a fresh login) must never see the previous
        // user's cached report data — their data scope / report access differ.
        const prev = get().user
        if (!prev || prev.id !== user.id) {
          queryClient.clear()
        }
        localStorage.setItem('access_token', token)
        set({ user, token, isAuthenticated: true })
      },
      clearAuth: () => {
        queryClient.clear()
        localStorage.removeItem('access_token')
        set({ user: null, token: null, isAuthenticated: false })
      },
    }),
    {
      name: 'ananya-auth',
      partialize: (state) => ({ user: state.user, token: state.token, isAuthenticated: state.isAuthenticated }),
    },
  ),
)

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '../api/types'
import { queryClient } from '../lib/queryClient'

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  sessionExpiresAt: number | null
  sessionValidated: boolean
  setAuth: (user: User, token: string) => void
  touchSession: () => void
  clearAuth: () => void
}

const configuredMinutes = Number(import.meta.env.VITE_SESSION_TIMEOUT_MINUTES ?? 15)
export const SESSION_TIMEOUT_MS =
  (Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes : 15) * 60 * 1000

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      sessionExpiresAt: null,
      sessionValidated: false,
      setAuth: (user, token) => {
        // A different user (or a fresh login) must never see the previous
        // user's cached report data — their data scope / report access differ.
        const prev = get().user
        if (!prev || prev.id !== user.id) {
          queryClient.clear()
        }
        localStorage.setItem('access_token', token)
        set({
          user,
          token,
          isAuthenticated: true,
          sessionExpiresAt: Date.now() + SESSION_TIMEOUT_MS,
          sessionValidated: true,
        })
      },
      touchSession: () => {
        if (get().isAuthenticated && get().token) {
          set({ sessionExpiresAt: Date.now() + SESSION_TIMEOUT_MS })
        }
      },
      clearAuth: () => {
        queryClient.clear()
        localStorage.removeItem('access_token')
        set({
          user: null,
          token: null,
          isAuthenticated: false,
          sessionExpiresAt: null,
          sessionValidated: false,
        })
      },
    }),
    {
      name: 'ananya-auth',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
        sessionExpiresAt: state.sessionExpiresAt,
      }),
    },
  ),
)

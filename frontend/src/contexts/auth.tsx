import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import type { User } from '../lib/api'
import { api, ApiError } from '../lib/api'

interface AuthContextType {
  user: User | null
  token: string | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextType>(null!)

const TOKEN_KEY = 'spark_token'
const USER_KEY = 'spark_user'

function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const storedToken = localStorage.getItem(TOKEN_KEY)
  const storedUser = readStoredUser()
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  )

  // Restore user from cache immediately — no loading flash on refresh
  const [user, setUser] = useState<User | null>(() => storedUser)

  // isLoading is only true on first mount when we have a token but no cached user
  const [isLoading, setIsLoading] = useState<boolean>(
    () => !!storedToken && !storedUser,
  )

  const persistUser = useCallback((u: User | null) => {
    if (u) {
      localStorage.setItem(USER_KEY, JSON.stringify(u))
    } else {
      localStorage.removeItem(USER_KEY)
    }
    setUser(u)
  }, [])

  const clearAuth = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setToken(null)
    setUser(null)
  }, [])

  const isAuthenticated = !!token && !!user

  // Background validation: only clears auth on explicit 401, not on network errors
  const validateToken = useCallback(
    async (t: string) => {
      try {
        const me = await api.auth.me(t)
        persistUser(me)
      } catch (err) {
        // Only force logout when the server explicitly rejects the token
        if (
          err instanceof ApiError &&
          (err.status === 401 || err.status === 403)
        ) {
          clearAuth()
        } else if (!readStoredUser()) {
          // No cached session to fall back to, so avoid getting stuck in a
          // token-only state that routes to protected pages without a user.
          clearAuth()
        }
        // Network errors / 5xx → keep the cached user, user stays logged in
      } finally {
        setIsLoading(false)
      }
    },
    [persistUser, clearAuth],
  )

  // On mount: if we have a token, silently re-validate in the background
  useEffect(() => {
    const storedToken = localStorage.getItem(TOKEN_KEY)
    if (storedToken) {
      void validateToken(storedToken)
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const login = async (username: string, password: string) => {
    const { access_token } = await api.auth.login(username, password)
    localStorage.setItem(TOKEN_KEY, access_token)
    setToken(access_token)
    const me = await api.auth.me(access_token)
    persistUser(me)
  }

  const register = async (username: string, password: string) => {
    await api.auth.register(username, password)
    await login(username, password)
  }

  const logout = () => {
    clearAuth()
  }

  const refreshUser = useCallback(async () => {
    if (token) await validateToken(token)
  }, [token, validateToken])

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAuthenticated,
        login,
        register,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext)

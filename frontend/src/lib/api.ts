const API_URL = 'http://198.96.88.142:3010'

export interface User {
  id: string
  username: string
  balance: number
  cardUid: string | null
  timeRemaining: number
  lastPortConnected: number
  activePort: number
  pendingAction: 'start' | 'resume' | null
  pendingPort: number
  pendingDurationMs: number
  pendingMessage: string | null
}

export interface PortStatus {
  p1_active: boolean
  p2_active: boolean
  p1_remaining?: number
  p2_remaining?: number
  availablePorts: number[]
  availableCount: number
  brokerConnected: boolean
  deviceOnline: boolean
  statusReceived: boolean
  statusAgeMs?: number
  lastUpdatedAt?: string
}

export interface StartSessionResponse {
  success: boolean
  pending: boolean
  port: number
  minutes: number
  cost: number
  message: string
}

export interface ResumeSessionResponse {
  success: boolean
  pending: boolean
  port: number
  remainingMs: number
  message: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${API_URL}${path}`, { ...options, headers })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }))
    throw new ApiError(
      (err as { message?: string }).message ?? 'Request failed',
      res.status,
    )
  }

  return res.json() as Promise<T>
}

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<{ access_token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),

    register: (username: string, password: string) =>
      request<User>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),

    me: (token: string) => request<User>('/auth/me', {}, token),
  },

  users: {
    updateCard: (token: string, cardUid: string) =>
      request<User>(
        '/users/card',
        {
          method: 'PATCH',
          body: JSON.stringify({ cardUid }),
        },
        token,
      ),
  },

  payment: {
    createTopup: (
      token: string,
      amount: number,
      successUrl: string,
      cancelUrl: string,
    ) =>
      request<{ checkoutUrl: string; referenceNumber: string }>(
        '/payment/topup',
        {
          method: 'POST',
          body: JSON.stringify({ amount, successUrl, cancelUrl }),
        },
        token,
      ),
  },

  sessions: {
    getStatus: (token: string) =>
      request<PortStatus>('/sessions/status', {}, token),

    start: (token: string, port: number, minutes: number) =>
      request<StartSessionResponse>(
        '/sessions/start',
        {
          method: 'POST',
          body: JSON.stringify({ port, minutes }),
        },
        token,
      ),

    pause: (token: string) =>
      request<{ success: boolean }>(
        '/sessions/pause',
        {
          method: 'POST',
        },
        token,
      ),

    resume: (token: string, port: number) =>
      request<ResumeSessionResponse>(
        '/sessions/resume',
        {
          method: 'POST',
          body: JSON.stringify({ port }),
        },
        token,
      ),
  },
}

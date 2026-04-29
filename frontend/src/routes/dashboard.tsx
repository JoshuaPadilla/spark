import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../contexts/auth'
import type { PortStatus } from '../lib/api'
import { api } from '../lib/api'

export const Route = createFileRoute('/dashboard')({
  component: DashboardPage,
})

const DURATIONS = [
  { minutes: 1, label: '1 min', cost: 1 },
  { minutes: 5, label: '5 min', cost: 5 },
  { minutes: 10, label: '10 min', cost: 10 },
  { minutes: 20, label: '20 min', cost: 20 },
]

const currencyFormatter = new Intl.NumberFormat('en-PH', {
  style: 'currency',
  currency: 'PHP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

function formatMs(ms: number) {
  const totalSecs = Math.floor(ms / 1000)
  const m = Math.floor(totalSecs / 60)
  const s = totalSecs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatPeso(amount: number) {
  return currencyFormatter.format(amount)
}

function getOwnedPorts(activePort: number | undefined): Array<1 | 2> {
  const ports: Array<1 | 2> = []
  const activeMask = activePort ?? 0

  if ((activeMask & 1) !== 0) {
    ports.push(1)
  }

  if ((activeMask & 2) !== 0) {
    ports.push(2)
  }

  return ports
}

function userOwnsPort(activePort: number | undefined, port: 1 | 2) {
  return ((activePort ?? 0) & port) !== 0
}

function getLiveRemainingMs(
  remainingMs: number | undefined,
  isActive: boolean,
  syncedAtMs: number,
  nowMs: number,
) {
  if (remainingMs === undefined) {
    return undefined
  }

  if (!isActive) {
    return remainingMs
  }

  return Math.max(0, remainingMs - Math.max(0, nowMs - syncedAtMs))
}

function formatStatusAge(statusAgeMs?: number) {
  if (statusAgeMs === undefined) {
    return null
  }

  const seconds = Math.max(1, Math.round(statusAgeMs / 1000))
  return `${seconds}s ago`
}

function DashboardPage() {
  const { user, token, isLoading, isAuthenticated, logout, refreshUser } =
    useAuth()
  const navigate = useNavigate()
  const [portStatus, setPortStatus] = useState<PortStatus>({
    p1_active: false,
    p2_active: false,
    availablePorts: [],
    availableCount: 0,
    brokerConnected: false,
    deviceOnline: false,
    statusReceived: false,
  })
  const [sessionModal, setSessionModal] = useState<{
    open: boolean
    port: 1 | 2
    minutes: number
  }>({ open: false, port: 1, minutes: 1 })
  const [actionError, setActionError] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [cardUid, setCardUid] = useState('')
  const [cardLoading, setCardLoading] = useState(false)
  const [tapOverlayDismissed, setTapOverlayDismissed] = useState(false)
  const [statusSyncedAtMs, setStatusSyncedAtMs] = useState(() => Date.now())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const availablePorts = portStatus.availablePorts ?? []
  const isDeviceReady = !!portStatus.deviceOnline

  const fetchStatus = useCallback(async () => {
    if (!token) return
    try {
      const s = await api.sessions.getStatus(token)
      setPortStatus(s)
      setStatusSyncedAtMs(Date.now())
    } catch {
      // silently ignore — broker might be offline
    }
  }, [token])

  const syncDashboard = useCallback(async () => {
    await fetchStatus()
    await refreshUser()
  }, [fetchStatus, refreshUser])

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void navigate({ to: '/login' })
    }
  }, [isAuthenticated, isLoading, navigate])

  useEffect(() => {
    setCardUid(user?.cardUid ?? '')
  }, [user?.cardUid])

  useEffect(() => {
    if (!token) return

    void syncDashboard()
    pollRef.current = setInterval(() => void syncDashboard(), 2000)

    const handleFocus = () => {
      void syncDashboard()
    }

    window.addEventListener('focus', handleFocus)

    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
      window.removeEventListener('focus', handleFocus)
    }
  }, [token, syncDashboard])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const activePorts = getOwnedPorts(user?.activePort)
  const hasSavedTime = (user?.timeRemaining ?? 0) > 0
  const isAwaitingCard =
    user?.pendingAction === 'start' &&
    user.pendingPort > 0 &&
    user.pendingDurationMs > 0

  useEffect(() => {
    setTapOverlayDismissed(false)
  }, [isAwaitingCard, user?.pendingPort, user?.pendingDurationMs])

  const handleStartSession = async () => {
    if (!token || !user) return

    if (userOwnsPort(user.activePort, sessionModal.port)) {
      setActionError(
        `You already have an active session on Port ${sessionModal.port}.`,
      )
      return
    }

    if (user.timeRemaining > 0) {
      setActionError(
        'You already have saved charging time. Resume it on any available port instead of starting a new session.',
      )
      return
    }

    if (!portStatus.brokerConnected) {
      setActionError('MQTT broker is offline.')
      return
    }

    if (!portStatus.statusReceived || !portStatus.deviceOnline) {
      setActionError('Waiting for a fresh device status update.')
      return
    }

    if (!(portStatus.availablePorts ?? []).includes(sessionModal.port)) {
      setActionError(
        `Port ${sessionModal.port} is busy right now. Choose another available port.`,
      )
      return
    }

    const selectedDuration = DURATIONS.find(
      (option) => option.minutes === sessionModal.minutes,
    )

    if (!selectedDuration) {
      setActionError('Invalid duration selected')
      return
    }

    if (user.balance < selectedDuration.cost) {
      setActionError(
        `Insufficient balance. Need ${formatPeso(selectedDuration.cost)} to start this session.`,
      )
      return
    }

    setActionError('')
    setActionLoading(true)
    try {
      await api.sessions.start(token, sessionModal.port, sessionModal.minutes)
      await syncDashboard()
      setSessionModal((p) => ({ ...p, open: false }))
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to start session')
    } finally {
      setActionLoading(false)
    }
  }

  const handlePause = async (port: 1 | 2) => {
    if (!token) return
    setActionError('')
    setActionLoading(true)
    try {
      await api.sessions.pause(token, port)
      await syncDashboard()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to pause session')
    } finally {
      setActionLoading(false)
    }
  }

  const handleResume = async (port: 1 | 2) => {
    if (!token || !user) return

    if (userOwnsPort(user.activePort, port)) {
      setActionError(
        `You already have an active session on Port ${port}.`,
      )
      return
    }

    if (user.timeRemaining <= 0) {
      setActionError('No paused session is available to resume.')
      return
    }

    if (!portStatus.brokerConnected) {
      setActionError('MQTT broker is offline.')
      return
    }

    if (!portStatus.statusReceived || !portStatus.deviceOnline) {
      setActionError('Waiting for a fresh device status update.')
      return
    }

    if (!(portStatus.availablePorts ?? []).includes(port)) {
      setActionError(
        `Port ${port} is busy right now. Choose another available port.`,
      )
      return
    }

    setActionError('')
    setActionLoading(true)
    try {
      await api.sessions.resume(token, port)
      await syncDashboard()
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'Failed to resume the session',
      )
    } finally {
      setActionLoading(false)
    }
  }

  const handleCardSave = async () => {
    if (!token) return
    setActionError('')
    setCardLoading(true)
    try {
      await api.users.updateCard(token, cardUid)
      await refreshUser()
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : 'Failed to update card UID',
      )
    } finally {
      setCardLoading(false)
    }
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (!user) {
    return null
  }

  const hasActivePorts = activePorts.length > 0
  const ownsBothPorts = activePorts.length === 2
  const selectedDuration =
    DURATIONS.find((option) => option.minutes === sessionModal.minutes) ??
    DURATIONS[0]
  const canAffordSelectedDuration = user.balance >= selectedDuration.cost
  const statusAgeLabel = formatStatusAge(portStatus.statusAgeMs)
  const mqttStatusLabel = !portStatus.brokerConnected
    ? 'MQTT Offline'
    : isDeviceReady
      ? 'MQTT Live'
      : 'MQTT Stale'
  const statusTone = /insufficient|busy|offline|failed|no saved/i.test(
    user.pendingMessage ?? '',
  )
    ? 'border-red-700 bg-red-900/30 text-red-300'
    : 'border-amber-500/30 bg-amber-400/10 text-amber-100'
  const showTapOverlay = isAwaitingCard && !tapOverlayDismissed

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg
              className="w-6 h-6 text-amber-400"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span className="font-bold text-white">Spark</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-400">{user.username}</span>
            <button
              onClick={logout}
              className="text-sm text-gray-500 hover:text-white transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Balance card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <p className="text-sm text-gray-400 mb-1">Wallet Balance</p>
          <p className="text-4xl font-bold text-amber-400">
            {formatPeso(Number(user.balance))}
          </p>
          <div className="mt-4">
            <a
              href="/topup"
              onClick={(e) => {
                e.preventDefault()
                void navigate({ to: '/topup' })
              }}
              className="inline-flex items-center gap-1.5 bg-amber-400 hover:bg-amber-300 text-gray-900 font-semibold text-sm px-4 py-2 rounded-lg transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 4v16m8-8H4"
                />
              </svg>
              Top Up
            </a>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-gray-400 mb-1">Linked RFID Card</p>
              <p className="text-lg font-semibold text-white">
                {user.cardUid ?? 'No card linked yet'}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Link the card UID you will use only for device-initiated
                sessions. Dashboard starts and resumes use your logged-in
                balance directly, while card taps on the charger let you pick a
                port from the device itself.
              </p>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                user.cardUid
                  ? 'bg-emerald-400/15 text-emerald-300'
                  : 'bg-gray-800 text-gray-400'
              }`}
            >
              {user.cardUid ? 'Card Linked' : 'Card Needed'}
            </span>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={cardUid}
              onChange={(e) => setCardUid(e.target.value.toUpperCase())}
              placeholder="Enter RFID card UID"
              className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition"
            />
            <button
              onClick={() => void handleCardSave()}
              disabled={cardLoading}
              className="bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors"
            >
              {cardLoading ? 'Saving…' : 'Save Card UID'}
            </button>
          </div>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-gray-400 mb-1">Available Devices</p>
              <p className="text-4xl font-bold text-white">
                {isDeviceReady ? (portStatus.availableCount ?? 0) : '--'}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                {!portStatus.brokerConnected
                  ? 'MQTT broker offline'
                  : isDeviceReady
                    ? 'Live device availability from MQTT'
                    : portStatus.statusReceived
                      ? 'Last device update is stale'
                      : 'Waiting for device status'}
              </p>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                !portStatus.brokerConnected
                  ? 'bg-red-400/15 text-red-300'
                  : isDeviceReady
                    ? 'bg-emerald-400/15 text-emerald-300'
                    : 'bg-amber-400/15 text-amber-300'
              }`}
            >
              {mqttStatusLabel}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {([1, 2] as const).map((port) => {
              const isActive =
                port === 1 ? portStatus.p1_active : portStatus.p2_active
              const snapshotRemaining =
                port === 1 ? portStatus.p1_remaining : portStatus.p2_remaining
              const remaining = getLiveRemainingMs(
                snapshotRemaining,
                isActive,
                statusSyncedAtMs,
                nowMs,
              )

              return (
                <div
                  key={`overview-${port}`}
                  className={`rounded-xl border px-4 py-3 ${
                    !portStatus.statusReceived
                      ? 'border-gray-800 bg-gray-950'
                      : isActive
                        ? 'border-amber-400/40 bg-amber-400/10'
                        : 'border-emerald-400/30 bg-emerald-400/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-white">
                      Port {port}
                    </p>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        !portStatus.statusReceived
                          ? 'bg-gray-800 text-gray-400'
                          : isActive
                            ? 'bg-amber-400/20 text-amber-300'
                            : 'bg-emerald-400/15 text-emerald-300'
                      }`}
                    >
                      {!portStatus.statusReceived
                        ? 'Waiting'
                        : isActive
                          ? 'In Use'
                          : 'Available'}
                    </span>
                  </div>
                  <p className="mt-3 text-2xl font-semibold text-white">
                    {!portStatus.statusReceived
                      ? '--:--'
                      : isActive
                        ? formatMs(remaining ?? 0)
                        : 'Ready'}
                  </p>
                  <p className="mt-1 text-sm text-gray-400">
                    {!portStatus.statusReceived
                      ? 'Awaiting the first MQTT status update.'
                      : isActive
                        ? 'Live time remaining on this port.'
                        : 'Open for a new balance-paid session.'}
                  </p>
                </div>
              )
            })}
          </div>

          {statusAgeLabel && (
            <p className="mt-3 text-xs text-gray-500">
              Last MQTT update received {statusAgeLabel}.
            </p>
          )}

          {!!portStatus.statusReceived && availablePorts.length === 0 && (
            <p className="mt-2 text-sm text-gray-500">
              All charging ports are currently in use.
            </p>
          )}
        </div>

        {(user.pendingMessage ||
          actionError ||
          isAwaitingCard ||
          hasActivePorts ||
          hasSavedTime) && (
          <div className="space-y-3">
            {user.pendingMessage && (
              <div
                className={`rounded-2xl border px-4 py-3 text-sm ${statusTone}`}
              >
                {user.pendingMessage}
              </div>
            )}

            {actionError && (
              <div className="rounded-2xl border border-red-700 bg-red-900/30 px-4 py-3 text-sm text-red-300">
                {actionError}
              </div>
            )}

            {activePorts.map((port) => {
              const remaining = getLiveRemainingMs(
                port === 1 ? portStatus.p1_remaining : portStatus.p2_remaining,
                true,
                statusSyncedAtMs,
                nowMs,
              )

              return (
                <div
                  key={`active-session-${port}`}
                  className="bg-gray-900 border border-emerald-400/30 rounded-2xl p-5"
                >
                  <p className="text-xs font-medium uppercase tracking-wider text-emerald-300">
                    Current Connection
                  </p>
                  <h2 className="mt-2 text-xl font-semibold text-white">
                    Connected to Port {port}
                  </h2>
                  <p className="mt-3 text-2xl font-mono font-semibold text-emerald-200">
                    {remaining !== undefined ? formatMs(remaining) : 'Syncing timer...'}
                  </p>
                  <p className="mt-2 text-sm text-gray-400">
                    This port is assigned to your account right now. Pause it
                    from the matching port card below if you want to save the
                    remaining time.
                  </p>
                </div>
              )
            })}

            {hasSavedTime && !isAwaitingCard && !ownsBothPorts && (
              <div className="bg-gray-900 border border-sky-400/30 rounded-2xl p-5">
                <p className="text-xs font-medium uppercase tracking-wider text-sky-300">
                  Saved Time
                </p>
                <h2 className="mt-2 text-xl font-semibold text-white">
                  {formatMs(user.timeRemaining)} ready to resume
                </h2>
                <p className="mt-2 text-sm text-gray-400">
                  Connect to any available port below, then select that port to
                  resume your saved charging time.
                </p>
              </div>
            )}
          </div>
        )}

        {/* Charging Ports */}
        <div>
          <h2 className="text-sm font-medium text-gray-400 mb-3 uppercase tracking-wider">
            Charging Ports
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {([1, 2] as const).map((port) => {
              const isActive =
                port === 1 ? portStatus.p1_active : portStatus.p2_active
              const snapshotRemaining =
                port === 1 ? portStatus.p1_remaining : portStatus.p2_remaining
              const remaining = getLiveRemainingMs(
                snapshotRemaining,
                isActive,
                statusSyncedAtMs,
                nowMs,
              )
              const isMyActivePort = activePorts.includes(port)
              const canResumeHere =
                !isActive &&
                !isMyActivePort &&
                hasSavedTime &&
                isDeviceReady
              const canStartHere =
                !isActive &&
                !isMyActivePort &&
                !hasSavedTime &&
                isDeviceReady
              const canSelectHere = canStartHere || canResumeHere
              const isQueuedHere = isAwaitingCard && user.pendingPort === port
              const portActionLabel = canResumeHere
                ? 'Resume Here'
                : isQueuedHere
                  ? 'Change Plan'
                  : 'Choose Plan'

              return (
                <div
                  key={port}
                  className={`bg-gray-900 border rounded-2xl p-5 ${
                    isActive ? 'border-amber-400/60' : 'border-gray-800'
                  }`}
                >
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="font-semibold text-white">Port {port}</p>
                      <span
                        className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-amber-400/20 text-amber-400'
                            : 'bg-emerald-400/15 text-emerald-300'
                        }`}
                      >
                        {isActive
                          ? isMyActivePort
                            ? 'Your Session'
                            : 'Busy'
                          : 'Available'}
                      </span>
                    </div>
                    <svg
                      className={`w-8 h-8 ${isActive ? 'text-amber-400' : 'text-gray-700'}`}
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                  </div>

                  <div className="mb-4 min-h-14">
                    {isActive && remaining !== undefined ? (
                      <>
                        <p className="text-2xl font-mono font-bold text-white">
                          {formatMs(remaining)}
                        </p>
                        <p className="text-sm text-gray-400 mt-1">
                          {isMyActivePort
                            ? 'Live countdown from your charging session.'
                            : 'This port is currently occupied.'}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-2xl font-semibold text-white">
                          Ready
                        </p>
                        <p className="text-sm text-gray-400 mt-1">
                          {canStartHere
                            ? 'Connect to this port, choose time, and pay with balance.'
                            : canResumeHere
                              ? 'Resume your saved time immediately on this port.'
                              : !portStatus.brokerConnected
                                ? 'MQTT broker is offline.'
                                : !isDeviceReady
                                  ? 'Waiting for a fresh MQTT status update.'
                                  : hasSavedTime
                                    ? 'Saved time is ready. Select an available port to resume.'
                                    : isAwaitingCard
                                      ? 'Card tap is pending. Select another free port to replace the queued start request.'
                                      : isMyActivePort
                                        ? 'This port is already assigned to your account.'
                                        : ownsBothPorts
                                          ? 'You already occupy both charging ports.'
                                        : 'Port is available.'}
                        </p>
                      </>
                    )}
                  </div>

                  <div className="flex gap-2">
                    {!isActive ? (
                      <button
                        onClick={() => {
                          if (canResumeHere) {
                            void handleResume(port)
                            return
                          }

                          setSessionModal({ open: true, port, minutes: 1 })
                        }}
                        disabled={!canSelectHere || actionLoading}
                        className="flex-1 bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed text-gray-900 text-sm font-semibold py-2 rounded-lg transition-colors"
                      >
                        {actionLoading && canResumeHere
                          ? 'Resuming…'
                          : portActionLabel}
                      </button>
                    ) : (
                      <>
                        {isMyActivePort ? (
                          <button
                            onClick={() => void handlePause(port)}
                            disabled={actionLoading}
                            className="flex-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-white text-sm font-medium py-2 rounded-lg transition-colors"
                          >
                            Pause
                          </button>
                        ) : (
                          <button
                            disabled
                            className="flex-1 bg-gray-800/70 text-gray-500 text-sm font-medium py-2 rounded-lg cursor-not-allowed"
                          >
                            Busy
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </main>

      {/* Start Session Modal */}
      {sessionModal.open && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 px-4 pb-4 sm:pb-0">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h3 className="font-semibold text-white mb-1">
              Choose Plan — Port {sessionModal.port}
            </h3>
            <p className="text-sm text-gray-400 mb-5">
              Pick a price and charging time. Starting from the dashboard uses
              your wallet balance immediately and starts the selected port
              without another card tap.
            </p>

            <p className="text-sm text-gray-400 mb-5">
              Balance:{' '}
              <span className="text-amber-400 font-medium">
                {formatPeso(Number(user.balance))}
              </span>
            </p>

            <p className="text-xs text-gray-400 mb-2 font-medium uppercase tracking-wider">
              Pick Price And Time
            </p>
            <div className="grid grid-cols-2 gap-2 mb-5">
              {DURATIONS.map((d) => (
                <button
                  key={d.minutes}
                  onClick={() =>
                    setSessionModal((p) => ({ ...p, minutes: d.minutes }))
                  }
                  disabled={user.balance < d.cost}
                  className={`flex flex-col items-center py-3 rounded-xl border text-sm font-medium transition-colors ${
                    sessionModal.minutes === d.minutes
                      ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                      : 'border-gray-700 text-gray-300 hover:border-gray-600'
                  } ${
                    user.balance < d.cost ? 'cursor-not-allowed opacity-40' : ''
                  }`}
                >
                  <span className="text-base font-bold">{d.label}</span>
                  <span className="text-xs opacity-70">
                    {formatPeso(d.cost)} wallet
                  </span>
                </button>
              ))}
            </div>

            <div className="mb-5 rounded-xl border border-gray-800 bg-gray-950 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500">
                Selected Session
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">
                    Port {sessionModal.port} · {selectedDuration.label}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    Estimated balance after start:{' '}
                    {formatPeso(
                      Math.max(0, Number(user.balance) - selectedDuration.cost),
                    )}
                  </p>
                </div>
                <p className="text-lg font-semibold text-amber-300">
                  {formatPeso(selectedDuration.cost)}
                </p>
              </div>
            </div>

            {!canAffordSelectedDuration && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-sm text-red-400 mb-4">
                You need at least {formatPeso(selectedDuration.cost)} in your
                wallet to use this plan.
              </div>
            )}

            {actionError && (
              <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-sm text-red-400 mb-4">
                {actionError}
              </div>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setSessionModal((p) => ({ ...p, open: false }))
                  setActionError('')
                }}
                className="flex-1 bg-gray-800 hover:bg-gray-700 text-white py-2.5 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleStartSession()}
                disabled={actionLoading || !canAffordSelectedDuration}
                className="flex-1 bg-amber-400 hover:bg-amber-300 disabled:opacity-50 text-gray-900 py-2.5 rounded-lg text-sm font-semibold transition-colors"
              >
                {actionLoading
                  ? 'Starting…'
                  : `Use ${formatPeso(selectedDuration.cost)} Balance`}
              </button>
            </div>
          </div>
        </div>
      )}

      {showTapOverlay && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 px-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-3xl border border-amber-400/30 bg-gray-950/95 p-6 shadow-2xl">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-amber-300">
              Awaiting Card Tap
            </p>
            <h2 className="mt-3 text-2xl font-semibold text-white">
              Start Port {user.pendingPort}
            </h2>
            <p className="mt-3 text-sm leading-6 text-gray-300">
              Tap your linked RFID card on the charger to start this new
              session. Resume requests do not need a card tap.
            </p>
            <div className="mt-5 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4">
              <p className="text-xs uppercase tracking-wider text-amber-200/80">
                Accepted Card
              </p>
              <p className="mt-2 text-lg font-semibold text-amber-100">
                {user.cardUid ?? 'No linked card'}
              </p>
              <p className="mt-2 text-sm text-amber-100/80">
                Other users cannot use their cards to start this queued session.
              </p>
            </div>
            <div className="mt-5 inline-flex items-center gap-2 rounded-full bg-amber-400/10 px-3 py-1 text-sm text-amber-300">
              <span className="h-2 w-2 rounded-full bg-amber-300 animate-pulse" />
              Waiting for your card
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setTapOverlayDismissed(true)}
                className="flex-1 rounded-xl bg-gray-800 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-gray-700"
              >
                Hide Overlay
              </button>
              <button
                onClick={() => void syncDashboard()}
                className="flex-1 rounded-xl bg-amber-400 px-4 py-2.5 text-sm font-semibold text-gray-900 transition-colors hover:bg-amber-300"
              >
                Refresh Status
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

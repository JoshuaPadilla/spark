import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/auth'
import { api } from '../lib/api'

export const Route = createFileRoute('/topup')({
  component: TopupPage,
})

const PRESET_AMOUNTS = [50, 100, 200, 500]

function TopupPage() {
  const { user, token, isLoading, isAuthenticated, refreshUser } = useAuth()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<number | null>(null)
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      void navigate({ to: '/login' })
    }
  }, [isAuthenticated, isLoading, navigate])

  useEffect(() => {
    if (!token) return
    void refreshUser()
  }, [token, refreshUser])

  const amount = selected ?? (custom ? Number(custom) : null)

  const handleTopup = async () => {
    if (!token || !amount) return
    setError('')
    setLoading(true)
    try {
      const successUrl = `${window.location.origin}/dashboard`
      const cancelUrl = `${window.location.origin}/topup`
      const { checkoutUrl } = await api.payment.createTopup(
        token,
        amount,
        successUrl,
        cancelUrl,
      )
      window.location.href = checkoutUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create payment link')
      setLoading(false)
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

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
          <button
            onClick={() => void navigate({ to: '/dashboard' })}
            className="text-gray-400 hover:text-white transition-colors"
            aria-label="Back"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 19l-7-7 7-7"
              />
            </svg>
          </button>
          <div className="flex items-center gap-2">
            <svg
              className="w-5 h-5 text-amber-400"
              fill="currentColor"
              viewBox="0 0 24 24"
            >
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
            <span className="font-bold text-white">Spark</span>
          </div>
        </div>
      </header>

      <main className="max-w-sm mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-white mb-1">Top Up Wallet</h1>
        <p className="text-sm text-gray-400 mb-6">
          Current balance:{' '}
          <span className="text-amber-400 font-medium">
            ₱{Number(user.balance).toFixed(2)}
          </span>
        </p>

        <div className="mb-6 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-300">
            Payment Method
          </p>
          <div className="mt-3 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-400/15 text-lg font-bold text-emerald-300">
              G
            </div>
            <div>
              <p className="font-semibold text-white">GCash only</p>
              <p className="text-sm text-gray-400">
                Spark top-ups now open a GCash-only PayMongo checkout.
              </p>
            </div>
          </div>
        </div>

        {/* Preset amounts */}
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">
          Select Amount
        </p>
        <div className="grid grid-cols-2 gap-3 mb-4">
          {PRESET_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => {
                setSelected(amt)
                setCustom('')
              }}
              className={`py-4 rounded-xl border text-lg font-bold transition-colors ${
                selected === amt && !custom
                  ? 'border-amber-400 bg-amber-400/10 text-amber-400'
                  : 'border-gray-700 text-white hover:border-gray-600'
              }`}
            >
              ₱{amt}
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="mb-6">
          <label className="block text-xs font-medium text-gray-400 mb-1.5">
            Or enter custom amount
          </label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 font-medium">
              ₱
            </span>
            <input
              type="number"
              min={20}
              step={1}
              placeholder="e.g. 150"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value)
                setSelected(null)
              }}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-7 pr-3 py-2.5 text-white text-sm placeholder-gray-500 focus:outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400 transition"
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">Minimum top-up: ₱20</p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700 rounded-lg px-3 py-2 text-sm text-red-400 mb-4">
            {error}
          </div>
        )}

        <button
          onClick={() => void handleTopup()}
          disabled={!amount || amount < 20 || loading}
          className="w-full bg-amber-400 hover:bg-amber-300 disabled:opacity-40 disabled:cursor-not-allowed text-gray-900 font-semibold py-3 rounded-xl text-sm transition-colors"
        >
          {loading
            ? 'Redirecting to GCash…'
            : amount && amount >= 20
              ? `Continue with GCash for ₱${amount}`
              : 'Select an amount'}
        </button>

        <p className="text-xs text-gray-600 text-center mt-4">
          You'll be redirected to PayMongo's secure GCash checkout.
          <br />
          After payment, your balance will be updated automatically.
        </p>
      </main>
    </div>
  )
}

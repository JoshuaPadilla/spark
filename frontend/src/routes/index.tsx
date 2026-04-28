import { createFileRoute, Navigate } from '@tanstack/react-router'
import { useAuth } from '../contexts/auth'

export const Route = createFileRoute('/')({ component: IndexRedirect })

function IndexRedirect() {
  const { isAuthenticated, isLoading } = useAuth()
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  return <Navigate to={isAuthenticated ? '/dashboard' : '/login'} />
}

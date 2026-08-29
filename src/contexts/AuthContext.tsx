'use client'
import { createContext, useContext, useState, ReactNode } from 'react'
import { signOut as signOutAction } from '@/actions/auth'
import { Employee } from '@/types'

interface ImpersonationInfo {
  id: string
  name: string
  role: string
}

interface AuthContextType {
  user: Employee | null
  realUser: Employee | null
  impersonating: ImpersonationInfo | null
  loading: boolean
  signOut: () => Promise<void>
  updateUser: (patch: Partial<Employee>) => void
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  realUser: null,
  impersonating: null,
  loading: false,
  signOut: async () => {},
  updateUser: () => {},
})

interface AuthProviderProps {
  children: ReactNode
  initialEmployee: Employee | null
  initialRealUser: Employee | null
  initialImpersonation: ImpersonationInfo | null
}

export function AuthProvider({
  children,
  initialEmployee,
  initialRealUser,
  initialImpersonation,
}: AuthProviderProps) {
  // Начальное состояние приходит с сервера — никаких клиентских запросов при инициализации.
  //
  // Подписки на onAuthStateChange больше нет: сессия живёт в httpOnly-cookie,
  // клиент её не видит и события смены состояния получать неоткуда. Единственный
  // выход из системы — signOut() ниже, он же и чистит локальное состояние.
  const [user, setUser]         = useState<Employee | null>(initialEmployee)
  const [realUser, setRealUser] = useState<Employee | null>(initialRealUser)
  const [impersonating, setImp] = useState<ImpersonationInfo | null>(initialImpersonation)

  const signOut = async () => {
    await signOutAction()
    setUser(null)
    setRealUser(null)
    setImp(null)
  }

  const updateUser = (patch: Partial<Employee>) => {
    setUser(prev => (prev ? { ...prev, ...patch } : prev))
  }

  return (
    <AuthContext.Provider value={{ user, realUser, impersonating, loading: false, signOut, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

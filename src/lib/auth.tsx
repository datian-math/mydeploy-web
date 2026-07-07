import React, { createContext, useContext, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'

interface AuthState {
  user: User | null
  loading: boolean
  allowed: boolean
  signIn: (email: string, password: string) => Promise<{ error: any }>
  signUp: (email: string, password: string) => Promise<{ error: any }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null, loading: true, allowed: false,
  signIn: async () => ({ error: null }),
  signUp: async () => ({ error: null }),
  signOut: async () => {},
})

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [allowed, setAllowed] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null)
      if (session?.user) checkAllowed(session.user.id)
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (session?.user) checkAllowed(session.user.id)
      else setAllowed(false)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function checkAllowed(userId: string) {
    console.log('Auth: checking allowed for', userId)
    const { data, error } = await supabase
      .from('math_allowed_users')
      .select('user_id')
      .eq('user_id', userId)
      .single()
    console.log('Auth: allowed result', !!data, error ? error.message : '')
    setAllowed(!!data)
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  async function signUp(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password })
    return { error }
  }

  async function signOut() {
    await supabase.auth.signOut()
    setAllowed(false)
  }

  return (
    <AuthContext.Provider value={{ user, loading, allowed, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

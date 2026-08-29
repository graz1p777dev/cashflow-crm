'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, Eye, EyeOff, Lock } from 'lucide-react'
import { confirmPasswordReset } from '@/actions/auth'
import { PASSWORD_MIN_LENGTH, validatePassword, passwordStrength } from '@/lib/auth-validation'

// Страница открывается по ссылке из письма: /auth/reset-password?token=...
// Токен — единственное доказательство личности, сессии здесь нет и не должно
// быть (раньше её ставил /auth/callback, обменивая recovery-код Supabase).

export default function ResetPasswordPage() {
  const router = useRouter()

  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState(false)
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const pwErr = validatePassword(password)
    if (pwErr) { setError(pwErr); return }
    if (password !== confirm) { setError('Пароли не совпадают'); return }

    // Токен читаем из адресной строки на месте, а не через useSearchParams:
    // тот требует Suspense-границы вокруг страницы, а здесь значение нужно
    // ровно один раз, в момент отправки.
    const token = new URLSearchParams(window.location.search).get('token') ?? ''

    setLoading(true)
    const result = await confirmPasswordReset(token, password)
    setLoading(false)

    if (result.success) {
      setSuccess(true)
      // Сброс пароля сессию не создаёт — отправляем на вход, а не в кабинет.
      setTimeout(() => router.push('/auth/login'), 2000)
    } else {
      setError(result.error)
    }
  }

  const strength = password.length > 0 ? passwordStrength(password) : null
  const strengthMap = {
    weak:   { label: 'Слабый',  color: '#430c61', width: '33%' },
    medium: { label: 'Средний', color: '#b45309', width: '66%' },
    strong: { label: 'Сильный', color: '#15803d', width: '100%' },
  }

  if (success) {
    return (
      <div
        className="min-h-screen flex items-center justify-center p-6"
        style={{ backgroundColor: '#faf8f7' }}
      >
        <div
          className="w-full max-w-sm rounded-2xl p-8 text-center space-y-3"
          style={{ backgroundColor: '#ffffff', border: '1px solid #ece5e5', boxShadow: '0 1px 2px rgba(28,20,22,0.04), 0 24px 60px -34px rgba(28,20,22,0.22)' }}
        >
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
            style={{ backgroundColor: '#dcfce7' }}
          >
            <CheckCircle2 style={{ width: 24, height: 24, color: '#22c55e' }} />
          </div>
          <h1 className="text-xl font-bold" style={{ color: '#1b1517' }}>Пароль обновлён</h1>
          <p className="text-sm" style={{ color: '#7d7174' }}>
            Перенаправляем на страницу входа...
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{ backgroundColor: '#faf8f7' }}
    >
      <div
        className="w-full max-w-sm rounded-2xl p-8"
        style={{ backgroundColor: '#ffffff', border: '1px solid #ece5e5', boxShadow: '0 1px 2px rgba(28,20,22,0.04), 0 24px 60px -34px rgba(28,20,22,0.22)' }}
      >
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
          style={{ backgroundColor: 'rgba(67, 12, 97,0.4)' }}
        >
          <Lock style={{ width: 18, height: 18, color: '#7d7174' }} />
        </div>
        <h1 className="text-2xl font-bold mb-1" style={{ color: '#1b1517' }}>Новый пароль</h1>
        <p className="text-sm mb-6" style={{ color: '#7d7174' }}>
          Придумайте надёжный пароль для вашего аккаунта.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: '#7d7174' }}>
              Новый пароль
            </label>
            <div className="relative">
              <input
                type={showPass ? 'text' : 'password'}
                placeholder={`Мин. ${PASSWORD_MIN_LENGTH} символов`}
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full pl-4 pr-10 h-11 rounded-xl text-sm text-[#1b1517] placeholder:text-[#a19698] focus:outline-none transition-all"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.08)',
                  border: '1px solid rgba(255,255,255,0.1)',
                }}
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: '#7d7174' }}
                tabIndex={-1}
              >
                {showPass
                  ? <EyeOff style={{ width: 15, height: 15 }} />
                  : <Eye style={{ width: 15, height: 15 }} />
                }
              </button>
            </div>

            {strength && (
              <div className="space-y-1 pt-1">
                <div className="h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'rgba(255,255,255,0.1)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: strengthMap[strength].width,
                      backgroundColor: strengthMap[strength].color,
                    }}
                  />
                </div>
                <p className="text-[11px]" style={{ color: strengthMap[strength].color }}>
                  {strengthMap[strength].label}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium uppercase tracking-wide" style={{ color: '#7d7174' }}>
              Подтверждение
            </label>
            <input
              type={showPass ? 'text' : 'password'}
              placeholder="Повторите пароль"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              required
              className="w-full px-4 h-11 rounded-xl text-sm text-[#1b1517] placeholder:text-[#a19698] focus:outline-none transition-all"
              style={{
                backgroundColor: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            />
          </div>

          <p className="text-[11px]" style={{ color: '#7d7174' }}>
            Мин. {PASSWORD_MIN_LENGTH} символов, одна заглавная буква, одна цифра.
          </p>

          {error && (
            <div
              className="flex items-center gap-2 text-sm px-4 py-3 rounded-xl"
              style={{ backgroundColor: '#fdeaea', border: '1px solid #f5c9c9', color: '#b91c1c' }}
            >
              ⚠ {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full h-11 rounded-xl font-semibold text-sm text-white transition-all"
            style={{ backgroundColor: '#430c61', opacity: loading ? 0.6 : 1 }}
          >
            {loading ? 'Сохраняем...' : 'Сохранить пароль'}
          </button>
        </form>
      </div>
    </div>
  )
}

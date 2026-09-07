'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { getSalaries, type SalaryRow } from '@/actions/salary'
import { Button } from '@/components/ui/button'

const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

export default function SalaryPage() {
  const [current, setCurrent] = useState(() => new Date())
  const [rows, setRows] = useState<SalaryRow[]>([])
  const [loading, setLoading] = useState(true)
  const year = current.getFullYear()
  const month = current.getMonth() + 1
  const load = useCallback(async () => {
    setLoading(true)
    const data = await getSalaries(year, month)
    setRows(data)
    setLoading(false)
  }, [year, month])
  useEffect(() => { void load() }, [load])
  const total = rows.reduce((sum, row) => sum + Number(row.total_amount), 0)
  return <div className="p-5 md:p-8">
    <div className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-bold text-[#1b1517]">Учёт зарплаты</h1><p className="mt-1 text-sm text-[#7d7174]">Фактические начисления сотрудников за выбранный месяц.</p></div><div className="flex items-center gap-2"><Button variant="outline" size="icon" onClick={() => setCurrent(new Date(year, month - 2, 1))} aria-label="Предыдущий месяц"><ChevronLeft className="size-4" /></Button><span className="min-w-40 text-center font-semibold capitalize">{months[month - 1]} {year}</span><Button variant="outline" size="icon" onClick={() => setCurrent(new Date(year, month, 1))} aria-label="Следующий месяц"><ChevronRight className="size-4" /></Button></div></div>
    <div className="mt-6 rounded-2xl border border-[#ece5e5] bg-white p-5"><p className="text-sm text-[#7d7174]">Фонд оплаты труда</p><p className="mt-1 text-3xl font-bold text-[#430c61]">{total.toLocaleString('ru-RU')} сом</p></div>
    <div className="mt-5 overflow-x-auto rounded-2xl border border-[#ece5e5] bg-white"><table className="w-full text-sm"><thead className="bg-[#faf8f7] text-left text-xs uppercase text-[#6b6063]"><tr><th className="px-4 py-3">Сотрудник</th><th className="px-4 py-3 text-right">Оклад</th><th className="px-4 py-3 text-right">KPI и бонусы</th><th className="px-4 py-3 text-right">Аванс</th><th className="px-4 py-3 text-right">Итого</th><th className="px-4 py-3">Статус</th></tr></thead><tbody>{rows.map((row) => <tr key={row.employee_id} className="border-t border-[#f0eaea]"><td className="px-4 py-3 font-medium">{row.employees?.name ?? 'Сотрудник'}<span className="ml-2 text-xs text-[#7d7174]">{row.employees?.role}</span></td><td className="px-4 py-3 text-right">{Number(row.base_salary).toLocaleString('ru-RU')}</td><td className="px-4 py-3 text-right text-emerald-700">+{(Number(row.kpi_bonus) + Number(row.bonuses)).toLocaleString('ru-RU')}</td><td className="px-4 py-3 text-right">{Number(row.advance_amount).toLocaleString('ru-RU')}</td><td className="px-4 py-3 text-right font-semibold">{Number(row.total_amount).toLocaleString('ru-RU')} сом</td><td className="px-4 py-3"><span className="rounded-full bg-[#f6f2f2] px-2 py-1 text-xs text-[#574d4f]">{row.status === 'paid' ? 'Выплачено' : row.status === 'calculated' ? 'Рассчитано' : 'Черновик'}</span></td></tr>)}{!loading && rows.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-[#7d7174]">За этот месяц пока нет начислений</td></tr>}</tbody></table>{loading && <p className="p-6 text-center text-[#7d7174]">Загрузка…</p>}</div>
  </div>
}

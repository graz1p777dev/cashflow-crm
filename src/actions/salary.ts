'use server'

// Данные для src/app/dashboard/salary/page.tsx — единственный потребитель.

import { query } from '@/lib/db'

export interface SalaryRow {
  employee_id: string
  base_salary: number
  kpi_bonus: number
  bonuses: number
  deductions: number
  total_amount: number
  advance_amount: number
  status: string
  employees: { name: string; role: string } | null
}

export async function getSalaries(year: number, month: number): Promise<SalaryRow[]> {
  const rows = await query<{
    employee_id: string
    base_salary: number
    kpi_bonus: number
    bonuses: number
    deductions: number
    total_amount: number
    advance_amount: number
    status: string
    employee_name: string | null
    employee_role: string | null
  }>(
    `SELECT s.employee_id, s.base_salary, s.kpi_bonus, s.bonuses, s.deductions,
            s.total_amount, s.advance_amount, s.status,
            e.name AS employee_name, e.role AS employee_role
       FROM public.salaries s
       LEFT JOIN public.employees e ON e.id = s.employee_id
      WHERE s.period_year = $1 AND s.period_month = $2
      ORDER BY s.total_amount DESC`,
    [year, month],
  )

  return rows.map((row) => ({
    employee_id: row.employee_id,
    base_salary: row.base_salary,
    kpi_bonus: row.kpi_bonus,
    bonuses: row.bonuses,
    deductions: row.deductions,
    total_amount: row.total_amount,
    advance_amount: row.advance_amount,
    status: row.status,
    employees: row.employee_name ? { name: row.employee_name, role: row.employee_role ?? '' } : null,
  }))
}

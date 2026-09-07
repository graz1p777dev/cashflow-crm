'use server'

import { revalidatePath } from 'next/cache'
import { query, queryOne, transaction } from '@/lib/db'
import { getActor, isOwner } from '@/lib/auth/actor'

export type ActionResult = { success: true } | { success: false; error: string }

export interface RoleOption { name: string; label: string }

export interface BonusTier {
  id: string
  tier_from: number
  tier_to: number | null
  bonus_amount: number
  sort_order: number
}

export interface BonusBlock {
  id: string
  name: string
  block_type: 'plan' | 'daily' | 'custom'
  value_label_from: string
  value_label_to: string
  sort_order: number
  tiers: BonusTier[]
}

export interface KpiItem {
  id: string
  name: string
  description: string | null
  bonus_amount: number
  sort_order: number
  is_active: boolean
}

export interface KpiRoleSetting {
  id: string
  role_name: string
  is_active: boolean
  salary_type: 'fixed' | 'per_shift'
  salary_amount: number
  rate_per_shift: number
  bonus_blocks: BonusBlock[]
  kpi_items: KpiItem[]
}

// ─── Роли ─────────────────────────────────────────────────────────────────────

export async function getRolesForKpi(): Promise<RoleOption[]> {
  const actor = await getActor()
  if (!actor) return []
  return query<RoleOption>(
    `SELECT name, label FROM public.roles
      WHERE deleted_at IS NULL
      ORDER BY created_at`,
  )
}

// ─── Получить или создать настройки KPI для роли ──────────────────────────────

interface KpiRoleSettingRow {
  id: string
  role_name: string
  is_active: boolean
  salary_type: 'fixed' | 'per_shift' | null
  salary_amount: number | null
  rate_per_shift: number | null
}

export async function getOrCreateKpiRoleSetting(roleName: string): Promise<KpiRoleSetting | null> {
  const actor = await getActor()
  if (!actor) return null

  let setting = await queryOne<KpiRoleSettingRow>(
    `SELECT id, role_name, is_active, salary_type, salary_amount, rate_per_shift
       FROM public.kpi_role_settings
      WHERE role_name = $1
      LIMIT 1`,
    [roleName],
  )

  if (!setting) {
    const created = await transaction(async (client) => {
      const res = await client.query<KpiRoleSettingRow>(
        `INSERT INTO public.kpi_role_settings (role_name, is_active)
         VALUES ($1, TRUE)
         RETURNING id, role_name, is_active, salary_type, salary_amount, rate_per_shift`,
        [roleName],
      )
      const row = res.rows[0]
      if (!row) return null

      // Создаём два базовых блока для новой роли
      await client.query(
        `INSERT INTO public.kpi_bonus_blocks
           (role_setting_id, name, block_type, value_label_from, value_label_to, sort_order)
         VALUES
           ($1, 'Бонус за выполнение плана', 'plan', '%', '%', 0),
           ($1, 'Ежедневный бонус', 'daily', 'сом', 'сом', 1)`,
        [row.id],
      )
      return row
    })
    if (!created) return null
    setting = created
  }

  // Загружаем блоки с их тирами
  const blocks = await query<Omit<BonusBlock, 'tiers'>>(
    `SELECT id, name, block_type, value_label_from, value_label_to, sort_order
       FROM public.kpi_bonus_blocks
      WHERE role_setting_id = $1
      ORDER BY sort_order`,
    [setting.id],
  )

  const blocksWithTiers: BonusBlock[] = await Promise.all(
    blocks.map(async (b) => {
      const tiers = await query<BonusTier>(
        `SELECT id, tier_from, tier_to, bonus_amount, sort_order
           FROM public.kpi_bonus_tiers
          WHERE block_id = $1
          ORDER BY sort_order`,
        [b.id],
      )
      return { ...b, tiers }
    })
  )

  const kpiItems = await query<KpiItem>(
    `SELECT id, name, description, bonus_amount, sort_order, is_active
       FROM public.kpi_items
      WHERE role_setting_id = $1 AND is_active = TRUE
      ORDER BY sort_order`,
    [setting.id],
  )

  return {
    id:             setting.id,
    role_name:      setting.role_name,
    is_active:      setting.is_active,
    salary_type:    setting.salary_type ?? 'fixed',
    salary_amount:  setting.salary_amount ?? 0,
    rate_per_shift: setting.rate_per_shift ?? 0,
    bonus_blocks:   blocksWithTiers,
    kpi_items:      kpiItems,
  }
}

// ─── Сохранить настройки оклада ───────────────────────────────────────────────

export async function saveSalarySettings(
  roleSettingId: string,
  salaryType: 'fixed' | 'per_shift',
  salaryAmount: number,
  ratePerShift: number,
): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }
  try {
    await query(
      `UPDATE public.kpi_role_settings
          SET salary_type = $2, salary_amount = $3, rate_per_shift = $4
        WHERE id = $1`,
      [roleSettingId, salaryType, salaryAmount, ratePerShift],
    )
  } catch (e) {
    const err = e as { message?: string }
    return { success: false, error: err.message ?? 'Ошибка сохранения' }
  }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

// ─── Сохранить тиры одного блока ─────────────────────────────────────────────

export async function saveBonusTiers(
  blockId: string,
  tiers: { tier_from: number; tier_to: number | null; bonus_amount: number }[],
): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  try {
    await transaction(async (client) => {
      await client.query('DELETE FROM public.kpi_bonus_tiers WHERE block_id = $1', [blockId])
      for (const [i, t] of tiers.entries()) {
        await client.query(
          `INSERT INTO public.kpi_bonus_tiers (block_id, tier_from, tier_to, bonus_amount, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [blockId, t.tier_from, t.tier_to, t.bonus_amount, i],
        )
      }
    })
  } catch (e) {
    const err = e as { message?: string }
    return { success: false, error: err.message ?? 'Ошибка сохранения' }
  }

  revalidatePath('/dashboard/settings')
  return { success: true }
}

// ─── Создать новый блок бонусов ───────────────────────────────────────────────

export async function createBonusBlock(
  roleSettingId: string,
  name: string,
  valueLabelFrom: string,
  valueLabelTo: string,
  sortOrder: number,
): Promise<{ success: true; id: string } | { success: false; error: string }> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  let created: { id: string } | null
  try {
    created = await queryOne<{ id: string }>(
      `INSERT INTO public.kpi_bonus_blocks
         (role_setting_id, name, block_type, value_label_from, value_label_to, sort_order)
       VALUES ($1, $2, 'custom', $3, $4, $5)
       RETURNING id`,
      [roleSettingId, name, valueLabelFrom, valueLabelTo, sortOrder],
    )
  } catch (e) {
    const err = e as { message?: string }
    return { success: false, error: err.message ?? 'Ошибка создания блока' }
  }
  if (!created) return { success: false, error: 'Ошибка создания блока' }
  revalidatePath('/dashboard/settings')
  return { success: true, id: created.id }
}

// ─── Удалить блок бонусов (CASCADE удалит тиры) ───────────────────────────────

export async function deleteBonusBlock(blockId: string): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }
  try {
    await query('DELETE FROM public.kpi_bonus_blocks WHERE id = $1', [blockId])
  } catch (e) {
    const err = e as { message?: string }
    return { success: false, error: err.message ?? 'Ошибка удаления блока' }
  }
  revalidatePath('/dashboard/settings')
  return { success: true }
}

// ─── Сохранение KPI-пунктов ───────────────────────────────────────────────────

export async function saveKpiItems(
  roleSettingId: string,
  items: { name: string; description: string | null; bonus_amount: number }[],
): Promise<ActionResult> {
  if (!await isOwner()) return { success: false, error: 'Недостаточно прав' }

  const validItems = items.filter(it => it.name.trim())

  try {
    await transaction(async (client) => {
      await client.query('DELETE FROM public.kpi_items WHERE role_setting_id = $1', [roleSettingId])
      for (const [i, it] of validItems.entries()) {
        await client.query(
          `INSERT INTO public.kpi_items
             (role_setting_id, name, description, bonus_amount, sort_order, is_active)
           VALUES ($1, $2, $3, $4, $5, TRUE)`,
          [roleSettingId, it.name.trim(), it.description?.trim() || null, it.bonus_amount, i],
        )
      }
    })
  } catch (e) {
    const err = e as { message?: string }
    return { success: false, error: err.message ?? 'Ошибка сохранения KPI-пунктов' }
  }

  revalidatePath('/dashboard/settings')
  return { success: true }
}

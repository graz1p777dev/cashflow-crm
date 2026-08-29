-- =============================================================================
-- seed_permissions.sql — матрица прав role × resource × scope.
--
-- ЗАПУСКАТЬ ПОСЛЕ db/schema.sql (нужны строки в public.roles).
-- Порядок bootstrap: schema.sql → 002_auth_phase2.sql → 003_password_changed_at.sql
--                    → seed_permissions.sql
--
-- Держится отдельным файлом, а не внутри schema.sql, намеренно: schema.sql
-- описывает структуру, а это — данные, которые владелец правит из интерфейса
-- настроек. Отдельный файл можно не накатывать на инстанс, где матрицу уже
-- редактировали, и видно по имени, что это seed, а не DDL.
--
-- Перенос supabase/migrations/020_seed_permissions.sql один в один: те же 5
-- системных ролей × 13 ресурсов = 65 строк, те же флаги и scope.
--
-- Отличие от 020 только в форме записи: там значения раскладывались по
-- переменным DO-блока (SELECT id INTO v_owner_id ...), здесь роль
-- подставляется JOIN'ом по имени. Результат тот же, но ошибка «роли нет» не
-- проходит молча: в 020 отсутствующая роль давала v_*_id = NULL, вставка
-- падала бы на NOT NULL; здесь строка просто не соберётся, поэтому итоговый
-- COUNT сверяется ниже явно.
--
-- ON CONFLICT DO NOTHING как в 020: повторный запуск ничего не перетирает,
-- правки владельца через настройки переживают накат.
--
-- ─── Про две системы прав ────────────────────────────────────────────────────
-- Эта таблица — одна из двух параллельных осей авторизации (db/AUTH_DESIGN.md
-- §5, открытый вопрос 3): рядом живёт permission_level из
-- supabase/migrations/025_custom_roles.sql. 025 таблицу permissions не трогает
-- вообще — это независимый механизм. Здесь мы только восстанавливаем данные,
-- как в проде; какая ось остаётся источником истины — отдельное решение.

INSERT INTO public.permissions (role_id, resource, can_view, can_create, can_edit, can_delete, scope)
SELECT r.id, m.resource, m.can_view, m.can_create, m.can_edit, m.can_delete, m.scope
  FROM (VALUES
    -- ─── OWNER: полный доступ ко всему ──────────────────────────────────────
    ('owner',      'dashboard',     true,  true,  true,  true,  'all'),
    ('owner',      'consultations', true,  true,  true,  true,  'all'),
    ('owner',      'decomposition', true,  true,  true,  true,  'all'),
    ('owner',      'employees',     true,  true,  true,  true,  'all'),
    ('owner',      'finances',      true,  true,  true,  true,  'all'),
    ('owner',      'salaries',      true,  true,  true,  true,  'all'),
    ('owner',      'calendar',      true,  true,  true,  true,  'all'),
    ('owner',      'documents',     true,  true,  true,  true,  'all'),
    ('owner',      'notifications', true,  true,  true,  true,  'all'),
    ('owner',      'settings',      true,  true,  true,  true,  'all'),
    ('owner',      'integrations',  true,  true,  true,  true,  'all'),
    ('owner',      'investors',     true,  true,  true,  true,  'all'),
    ('owner',      'kpi_settings',  true,  true,  true,  true,  'all'),

    -- ─── РОП: команда, без финансов и инвесторов ────────────────────────────
    ('rop',        'dashboard',     true,  false, false, false, 'team'),
    ('rop',        'consultations', true,  true,  true,  true,  'team'),
    ('rop',        'decomposition', true,  true,  true,  false, 'team'),
    ('rop',        'employees',     true,  false, false, false, 'team'),
    ('rop',        'finances',      false, false, false, false, 'team'),
    ('rop',        'salaries',      true,  false, false, false, 'team'),
    ('rop',        'calendar',      true,  true,  true,  false, 'team'),
    ('rop',        'documents',     true,  false, false, false, 'team'),
    ('rop',        'notifications', true,  false, true,  false, 'own'),
    ('rop',        'settings',      true,  false, false, false, 'all'),
    ('rop',        'integrations',  false, false, false, false, 'all'),
    ('rop',        'investors',     false, false, false, false, 'all'),
    ('rop',        'kpi_settings',  true,  false, false, false, 'all'),

    -- ─── МП: только своё ────────────────────────────────────────────────────
    ('mp',         'dashboard',     true,  false, false, false, 'own'),
    ('mp',         'consultations', true,  true,  true,  false, 'own'),
    ('mp',         'decomposition', true,  false, false, false, 'own'),
    ('mp',         'employees',     true,  false, false, false, 'own'),
    ('mp',         'finances',      false, false, false, false, 'own'),
    ('mp',         'salaries',      true,  false, false, false, 'own'),
    ('mp',         'calendar',      true,  false, false, false, 'own'),
    ('mp',         'documents',     true,  false, false, false, 'own'),
    ('mp',         'notifications', true,  false, true,  false, 'own'),
    ('mp',         'settings',      true,  false, false, false, 'all'),
    ('mp',         'integrations',  false, false, false, false, 'all'),
    ('mp',         'investors',     false, false, false, false, 'all'),
    ('mp',         'kpi_settings',  true,  false, false, false, 'all'),

    -- ─── LMAI: только своё; документы недоступны даже на просмотр ───────────
    ('lmai',       'dashboard',     true,  false, false, false, 'own'),
    ('lmai',       'consultations', true,  true,  true,  false, 'own'),
    ('lmai',       'decomposition', true,  false, false, false, 'own'),
    ('lmai',       'employees',     true,  false, false, false, 'own'),
    ('lmai',       'finances',      false, false, false, false, 'own'),
    ('lmai',       'salaries',      true,  false, false, false, 'own'),
    ('lmai',       'calendar',      true,  false, false, false, 'own'),
    ('lmai',       'documents',     false, false, false, false, 'own'),
    ('lmai',       'notifications', true,  false, true,  false, 'own'),
    ('lmai',       'settings',      true,  false, false, false, 'all'),
    ('lmai',       'integrations',  false, false, false, false, 'all'),
    ('lmai',       'investors',     false, false, false, false, 'all'),
    ('lmai',       'kpi_settings',  true,  false, false, false, 'all'),

    -- ─── Бухгалтер: финансы и зарплаты ──────────────────────────────────────
    ('accountant', 'dashboard',     false, false, false, false, 'all'),
    ('accountant', 'consultations', false, false, false, false, 'all'),
    ('accountant', 'decomposition', false, false, false, false, 'all'),
    ('accountant', 'employees',     true,  false, false, false, 'all'),
    ('accountant', 'finances',      true,  true,  true,  false, 'all'),
    ('accountant', 'salaries',      true,  true,  true,  false, 'all'),
    ('accountant', 'calendar',      false, false, false, false, 'all'),
    ('accountant', 'documents',     true,  true,  true,  false, 'all'),
    ('accountant', 'notifications', true,  false, true,  false, 'own'),
    ('accountant', 'settings',      true,  false, false, false, 'all'),
    ('accountant', 'integrations',  false, false, false, false, 'all'),
    ('accountant', 'investors',     false, false, false, false, 'all'),
    ('accountant', 'kpi_settings',  true,  false, false, false, 'all')
  ) AS m(role_name, resource, can_view, can_create, can_edit, can_delete, scope)
  JOIN public.roles r
    ON r.name = m.role_name
   AND r.deleted_at IS NULL
ON CONFLICT (role_id, resource) DO NOTHING;


-- Страховка: 5 системных ролей × 13 ресурсов. Если роль не нашлась по имени,
-- её 13 строк тихо выпали бы из INSERT — здесь это станет ошибкой наката.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
    FROM public.permissions p
    JOIN public.roles r ON r.id = p.role_id
   WHERE r.name IN ('owner','rop','mp','lmai','accountant');

  IF v_count <> 65 THEN
    RAISE EXCEPTION 'seed_permissions: ожидалось 65 строк для системных ролей, получено %', v_count;
  END IF;
END;
$$;

-- Добавляет тип 'bot_message' в notifications.type — ответы бота идут в CRM
-- как обычные (не важные) уведомления, отдельно от важных game_booking.
-- Применено вручную на Railway 2026-09-07; файл — для воспроизводимости схемы.

ALTER TABLE public.notifications DROP CONSTRAINT notifications_type_check;

ALTER TABLE public.notifications ADD CONSTRAINT notifications_type_check CHECK (
  type = ANY (ARRAY[
    'kpi_alert', 'kpi_success', 'plan_100', 'absence', 'salary_ready',
    'finance_alert', 'system', 'sale', 'consultation_booked',
    'consultation_reminder', 'sale_lead', 'server_load', 'deploy',
    'security', 'audit', 'game_booking', 'bot_message'
  ])
);

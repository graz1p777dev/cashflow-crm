// Прогон SQL из перенесённых на Postgres действий по ЖИВОЙ схеме.
//
// Всё идёт в одной транзакции, которая в конце всегда откатывается, а каждый
// запрос ещё и обёрнут в свой SAVEPOINT: упавший запрос не обрывает прогон, и
// видно сразу все расхождения, а не первое.
//
// Смысл — не проверить бизнес-логику (её проверяет приложение), а поймать
// расхождение SQL со схемой: опечатку в имени колонки, промах по числу
// параметров, несуществующую функцию, неверное имя constraint в ON CONFLICT.
// Компилятор такое не ловит: строка запроса для него просто строка.
//
//   DATABASE_URL=... node scripts/verify-migrated-sql.mjs
//
// Запросы здесь скопированы из src/actions/* и src/app/api/*. При правке SQL
// в тех файлах правьте и здесь — иначе проверка тихо перестанет что-либо
// значить.
import pg from 'pg'
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect(); await c.query('BEGIN')
let fail = 0
let sp = 0
const run = async (name, sql, params) => {
  const s = `sp${++sp}`
  await c.query(`SAVEPOINT ${s}`)
  try { const r = await c.query(sql, params); await c.query(`RELEASE SAVEPOINT ${s}`); console.log('OK  ', name, r.rowCount); return r }
  catch (e) { fail++; await c.query(`ROLLBACK TO SAVEPOINT ${s}`); console.log('FAIL', name, '::', e.message); return null }
}
// Ожидаем, что запрос упадёт с конкретной ошибкой (проверка триггеров).
const runFails = async (name, needle, sql, params) => {
  const s = `sp${++sp}`
  await c.query(`SAVEPOINT ${s}`)
  try { await c.query(sql, params); await c.query(`RELEASE SAVEPOINT ${s}`); fail++; console.log('FAIL', name, ':: ошибки не было'); }
  catch (e) {
    await c.query(`ROLLBACK TO SAVEPOINT ${s}`)
    const ok = e.message.includes(needle)
    if (!ok) fail++
    console.log(ok ? 'OK   ' : 'FAIL ', name, '::', e.message)
  }
}
try {
  const email = `smoke-${Date.now()}@example.invalid`
  const { rows: [u] } = await c.query(`INSERT INTO users (email,password_hash) VALUES ($1,'x') RETURNING id`, [email])
  const { rows: [e] } = await c.query(`INSERT INTO employees (name,email,role,user_id) VALUES ('Smoke',$1,'owner',$2) RETURNING id`, [email, u.id])
  const me = e.id
  const V = `(SELECT e.user_id FROM public.employees e WHERE e.id = $1)`

  // deals
  await run('deals.select', `SELECT d.* FROM public.deals d WHERE d.deleted_at IS NULL AND public.can_see_deal(${V}, d.responsible_employee_id) ORDER BY d.created_at DESC`, [me])
  const { rows: [st] } = await c.query('SELECT id FROM deal_stages WHERE is_default LIMIT 1')
  const ins = await run('deals.insert', `INSERT INTO public.deals (title,stage_id,amount,currency,customer_name,customer_phone,customer_username,city,address,source,responsible_employee_id,note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    ['T', st.id, 100, 'KGS', null, null, null, null, null, 'manual', null, null])
  const did = ins.rows[0].id
  await run('deals.update', `UPDATE public.deals AS t SET title=$3, stage_id=$4, amount=$5, currency=$6, customer_name=$7, customer_phone=$8, customer_username=$9, city=$10, address=$11, responsible_employee_id=$12, note=$13 WHERE t.id=$2 AND t.deleted_at IS NULL AND public.can_see_deal(${V}, t.responsible_employee_id) RETURNING t.id`,
    [me, did, 'T2', st.id, 1, 'KGS', null, null, null, null, null, null, null])
  await run('deals.move', `UPDATE public.deals AS t SET stage_id=$3 WHERE t.id=$2 AND t.deleted_at IS NULL AND public.can_see_deal(${V}, t.responsible_employee_id) RETURNING t.id`, [me, did, st.id])
  await run('deals.softdelete', `UPDATE public.deals AS t SET deleted_at=NOW() WHERE t.id=$2 AND t.deleted_at IS NULL AND public.can_see_deal(${V}, t.responsible_employee_id) RETURNING t.id`, [me, did])
  await run('deals.conversation', `SELECT d.external_key FROM public.deals d WHERE d.id=$2 AND public.can_see_deal(${V}, d.responsible_employee_id) LIMIT 1`, [me, did])
  await run('bot_messages', `SELECT id,direction,sender,text,created_at FROM public.bot_messages WHERE chat_id=$1 ORDER BY created_at,id LIMIT 200`, ['1'])
  await run('auto-create.insert', `INSERT INTO public.deals (title,stage_id,source,external_key,customer_name,customer_phone,customer_username,city,address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (external_key) DO NOTHING RETURNING id`, ['X', st.id, 'telegram', 'tg:1', null, null, null, null, null])

  // tasks
  const CST = `public.can_see_task(${V}, t.visibility, t.department_id, t.created_by, t.assignee_id, t.id)`
  await run('tasks.select', `SELECT t.* FROM public.tasks t WHERE ${CST} ORDER BY t.position ASC, t.created_at DESC`, [me])
  await run('task_members.select', `SELECT m.task_id, m.employee_id FROM public.task_members m JOIN public.tasks t ON t.id=m.task_id WHERE ${CST}`, [me])
  const t1 = await run('tasks.insert', `INSERT INTO public.tasks (title,description,status,priority,visibility,assignee_id,department_id,due_date,created_by,position) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9, COALESCE(MAX(t.position),-1)+1 FROM public.tasks t WHERE t.status=$3 RETURNING id`,
    ['T', null, 'todo', 'medium', 'private', null, null, null, me])
  const tid = t1.rows[0].id
  await run('task_members.insert', `INSERT INTO public.task_members (task_id, employee_id) SELECT $1, employee_id FROM unnest($2::uuid[]) AS employee_id`, [tid, [me]])
  await run('tasks.update', `UPDATE public.tasks AS t SET title=$3, description=$4, status=$5, priority=$6, assignee_id=$7, due_date=$8, visibility=$9, department_id=$10 WHERE t.id=$2 AND ${CST} RETURNING t.id`,
    [me, tid, 'T2', null, 'todo', 'high', null, null, 'all', null])
  await run('tasks.reorder', `UPDATE public.tasks AS t SET position = ord.idx - 1 FROM unnest($1::uuid[]) WITH ORDINALITY AS ord(id, idx) WHERE t.id = ord.id`, [[tid]])
  await run('tasks.delete', `DELETE FROM public.tasks AS t WHERE t.id=$1 AND (t.created_by=$2 OR $3='owner') RETURNING t.id`, [tid, me, 'owner'])

  // games / bookings
  await run('games.select', `SELECT * FROM public.games WHERE deleted_at IS NULL ORDER BY starts_at DESC`)
  const g1 = await run('games.insert', `INSERT INTO public.games (title,starts_at,duration_min,venue,price,currency,seats_total,host_employee_id,note,is_published,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    ['G', new Date().toISOString(), 60, 'V', 100, 'KGS', 5, null, null, true, 'planned'])
  const gid = g1.rows[0].id
  await run('games.update', `UPDATE public.games SET title=$2, starts_at=$3, duration_min=$4, venue=$5, price=$6, currency=$7, seats_total=$8, host_employee_id=$9, note=$10, is_published=$11, status=$12 WHERE id=$1 AND deleted_at IS NULL RETURNING id`,
    [gid, 'G2', new Date().toISOString(), 60, 'V', 100, 'KGS', 5, null, null, true, 'planned'])
  await run('bookings.manual', `INSERT INTO public.game_bookings (game_id,name,phone,seats,source,note) VALUES ($1,$2,$3,$4,'manual',$5)`, [gid, 'A', null, 2, null])
  const b1 = await run('bookings.bot-upsert', `INSERT INTO public.game_bookings (game_id,name,phone,telegram_chat_id,telegram_username,seats,source,status,deal_id) VALUES ($1,$2,$3,$4,$5,$6,'bot','booked',$7) ON CONFLICT (game_id, telegram_chat_id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, telegram_username=EXCLUDED.telegram_username, seats=EXCLUDED.seats, source=EXCLUDED.source, status=EXCLUDED.status, deal_id=EXCLUDED.deal_id RETURNING id`,
    [gid, 'B', null, 555, null, 2, null])
  await run('bookings.bot-upsert-again', `INSERT INTO public.game_bookings (game_id,name,phone,telegram_chat_id,telegram_username,seats,source,status,deal_id) VALUES ($1,$2,$3,$4,$5,$6,'bot','booked',$7) ON CONFLICT (game_id, telegram_chat_id) DO UPDATE SET name=EXCLUDED.name, phone=EXCLUDED.phone, telegram_username=EXCLUDED.telegram_username, seats=EXCLUDED.seats, source=EXCLUDED.source, status=EXCLUDED.status, deal_id=EXCLUDED.deal_id RETURNING id`,
    [gid, 'B2', null, 555, null, 1, null])
  await runFails('триггер перебронирования', 'Свободных мест нет',
    `INSERT INTO public.game_bookings (game_id,name,seats,source,status) VALUES ($1,'C',4,'manual','booked')`, [gid])
  await run('bookings.status', `UPDATE public.game_bookings SET status=$2 WHERE id=$1 RETURNING id`, [b1.rows[0].id, 'confirmed'])
  await run('bookings.delete', `DELETE FROM public.game_bookings WHERE id = $1`, [b1.rows[0].id])
  await run('public.games list', `SELECT g.id,g.title,g.starts_at,g.duration_min,g.venue,g.price,g.currency,g.seats_total, GREATEST(0, g.seats_total - public.game_seats_taken(g.id)) AS seats_free FROM public.games g WHERE g.is_published=TRUE AND g.status='planned' AND g.deleted_at IS NULL AND g.starts_at >= $1 ORDER BY g.starts_at LIMIT 20`, [new Date(Date.now()-3600e3).toISOString()])
  await run('game_seats_taken', `SELECT public.game_seats_taken($1) AS taken`, [gid])
  await run('bookings.list', `SELECT b.id,b.seats,b.status,g.id AS game_id,g.title AS game_title,g.starts_at AS game_starts_at,g.venue AS game_venue,g.price AS game_price,g.currency AS game_currency FROM public.game_bookings b JOIN public.games g ON g.id=b.game_id WHERE b.telegram_chat_id=$1 AND b.status IN ('booked','confirmed','attended') ORDER BY b.created_at DESC LIMIT 20`, [555])
  await run('bookings.patch', `UPDATE public.game_bookings SET status=$3 WHERE id=$1 AND telegram_chat_id=$2 RETURNING id`, ['00000000-0000-0000-0000-000000000000', 1, 'cancelled'])
  await run('games.softdelete', `UPDATE public.games SET deleted_at=NOW(), is_published=FALSE WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [gid])

  // notifications
  await run('notify.insert', `INSERT INTO public.notifications (employee_id,type,title,body,action_url,is_important,source_type,source_id) SELECT employee_id,$2,$3,$4,$5,$6,$7,$8 FROM unnest($1::uuid[]) AS employee_id`, [[me],'system','t',null,null,false,null,null])
  await run('notify.owners', `SELECT id FROM public.employees WHERE role = 'owner'`)
  const VIS = `(n.employee_id = $1 OR $2 = 'owner')`
  await run('notif.select', `SELECT n.* FROM public.notifications n WHERE ${VIS} AND ($3::boolean IS FALSE OR n.is_important = TRUE) ORDER BY n.created_at DESC LIMIT 100`, [me,'owner',false])
  await run('notif.read', `UPDATE public.notifications AS n SET is_read=TRUE WHERE n.id=$3 AND ${VIS}`, [me,'owner','00000000-0000-0000-0000-000000000000'])
  await run('notif.readall', `UPDATE public.notifications AS n SET is_read=TRUE WHERE n.is_read=FALSE AND ${VIS}`, [me,'owner'])

  // audit
  await run('audit.insert', `INSERT INTO public.audit_logs (employee_id,action,resource_type,resource_id,new_data) VALUES ($1,$2,$3,$4,$5)`, [me,'update','employee',null,JSON.stringify({summary:'s'})])
  await run('audit.select', `SELECT a.id,a.action,a.resource_type,a.new_data,a.created_at,e.name AS employee_name FROM public.audit_logs a LEFT JOIN public.employees e ON e.id=a.employee_id WHERE a.action IN ('create','update','delete') ORDER BY a.created_at DESC LIMIT $1`, [15])

  // employees
  await run('emp.list', `SELECT * FROM public.employees WHERE ($1::boolean OR deleted_at IS NULL) ORDER BY name`, [true])
  await run('emp.roles', `SELECT name,label FROM public.roles WHERE deleted_at IS NULL ORDER BY created_at`)
  await run('emp.sched', `SELECT name,description FROM public.work_schedules WHERE is_active=TRUE ORDER BY created_at`)
  const e2 = await run('emp.insert', `INSERT INTO public.employees (name,email,phone,role,department_id,hire_date,birth_date,base_salary,kpi_coefficient,schedule_type,work_start_time,work_end_time,status,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
    ['E2', `e2-${Date.now()}@x.invalid`, null, 'mp', null, null, null, 0, 1, '5/2', '09:00', '18:00', 'active', null])
  const e2id = e2.rows[0].id
  await run('emp.update', `UPDATE public.employees SET name=$2,email=$3,phone=$4,role=$5,department_id=$6,hire_date=$7,birth_date=$8,base_salary=$9,kpi_coefficient=$10,schedule_type=$11,work_start_time=$12,work_end_time=$13,status=$14,notes=$15 WHERE id=$1 AND deleted_at IS NULL`,
    [e2id,'E3',`e3-${Date.now()}@x.invalid`,null,'mp',null,null,null,0,1,'5/2','09:00','18:00','active',null])
  await run('emp.archive', `UPDATE public.employees SET deleted_at=NOW(), status='archived' WHERE id=$1 AND deleted_at IS NULL`, [e2id])
  await run('emp.restore', `UPDATE public.employees SET deleted_at=NULL, status='active' WHERE id=$1 AND deleted_at IS NOT NULL`, [e2id])
  await run('kpi.upsert', `INSERT INTO public.employee_kpi (employee_id,period_year,period_month,plan_fv,plan_sales,plan_revenue,plan_appeals,plan_leads,plan_nv,plan_work_days,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL) ON CONFLICT (employee_id,period_year,period_month) DO UPDATE SET plan_fv=EXCLUDED.plan_fv, plan_sales=EXCLUDED.plan_sales, plan_revenue=EXCLUDED.plan_revenue, plan_appeals=EXCLUDED.plan_appeals, plan_leads=EXCLUDED.plan_leads, plan_nv=EXCLUDED.plan_nv, plan_work_days=EXCLUDED.plan_work_days, created_by=EXCLUDED.created_by`,
    [e2id, 2026, 8, 1,2,3,4,5,6,20])
  await run('kpi.recalc', `SELECT public.recalculate_decomposition($1, $2::smallint, $3::smallint)`, [e2id, 2026, 8])
  await run('kpi.get', `SELECT plan_fv,plan_sales,plan_revenue,plan_appeals,plan_leads,plan_nv,plan_work_days FROM public.employee_kpi WHERE employee_id=$1 AND period_year=$2 AND period_month=$3 LIMIT 1`, [e2id,2026,8])
} finally {
  await c.query('ROLLBACK'); await c.end()
}
console.log(fail === 0 ? '\nВсе запросы прошли.' : `\nПровалено: ${fail}`)
process.exit(fail ? 1 : 0)

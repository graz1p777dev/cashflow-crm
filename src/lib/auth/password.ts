import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

// Хеширование паролей. bcryptjs, а не bcrypt: чистый JS без нативной сборки —
// на Railway это снимает целый класс проблем с деплоем (db/AUTH_DESIGN.md §1).

const BCRYPT_COST = 12

/**
 * Заглушка для сравнения, когда пользователь не найден.
 *
 * Без неё ветка «нет такого email» отвечала бы заметно быстрее ветки «неверный
 * пароль», и по времени ответа можно было бы перебирать существующие адреса.
 *
 * Хеш считается на месте от случайной строки, а не вписан константой: так он
 * гарантированно валиден и имеет тот самый cost-фактор, а подойти под него
 * нельзя — исходной строки не существует нигде за пределами этого вызова.
 * Считается один раз на процесс, при первом обращении.
 */
let dummyHashPromise: Promise<string> | null = null

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_COST)
  return dummyHashPromise
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST)
}

/**
 * Проверяет пароль против хеша из users.password_hash.
 *
 * Пустой хеш означает «пароль не задан» — так выглядят строки, залитые по
 * пути B из db/MIGRATION_PLAN.md §3 (перенос без парольного материала).
 * Такой аккаунт войти не может и обязан пройти сброс пароля.
 */
export async function verifyPassword(
  password: string,
  hash: string | null | undefined,
): Promise<boolean> {
  if (!hash) {
    // Всё равно тратим время на сравнение — ради постоянного времени ответа.
    await burnTime(password)
    return false
  }
  return bcrypt.compare(password, hash)
}

/** Холостое сравнение для ветки «пользователь не найден». */
export async function burnTime(password: string): Promise<void> {
  await bcrypt.compare(password, await getDummyHash())
}

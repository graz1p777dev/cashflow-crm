'use server'

import { revalidatePath } from 'next/cache'
import { query, queryOne } from '@/lib/db'
import { getActor } from '@/lib/auth/actor'
import type { Document, DocumentFolder, DocumentCategory } from '@/types'

// ─── Результат действия ──────────────────────────────────────────────────────

export type ActionResult<T = undefined> =
  | { success: true; data?: T }
  | { success: false; error: string }

const BUCKET = 'documents'

// ─── Просмотр папки ──────────────────────────────────────────────────────────

export interface FolderContents {
  folders: DocumentFolder[]
  documents: Document[]
  breadcrumb: DocumentFolder[]
}

async function buildBreadcrumb(folderId: string | null): Promise<DocumentFolder[]> {
  const path: DocumentFolder[] = []
  let currentId = folderId
  // Небольшая иерархия папок — обход по одной без риска зависнуть.
  for (let i = 0; i < 50 && currentId; i++) {
    const data = await queryOne<DocumentFolder>(
      `SELECT id, name, parent_id, created_by, created_at
         FROM public.document_folders
        WHERE id = $1`,
      [currentId],
    )
    if (!data) break
    path.unshift(data)
    currentId = data.parent_id
  }
  return path
}

interface DocumentRow extends Omit<Document, 'uploader'> {
  uploader_id: string | null
  uploader_name: string | null
}

function toDocument(row: DocumentRow): Document {
  const { uploader_id, uploader_name, ...rest } = row
  return {
    ...rest,
    uploader: uploader_id ? { id: uploader_id, name: uploader_name as string } : undefined,
  }
}

export async function listFolder(folderId: string | null): Promise<ActionResult<FolderContents>> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }

  const [folders, docRows] = await Promise.all([
    query<DocumentFolder>(
      `SELECT id, name, parent_id, created_by, created_at
         FROM public.document_folders
        WHERE parent_id IS NOT DISTINCT FROM $1
        ORDER BY name`,
      [folderId],
    ),
    query<DocumentRow>(
      `SELECT d.*, e.id AS uploader_id, e.name AS uploader_name
         FROM public.documents d
         LEFT JOIN public.employees e ON e.id = d.uploaded_by
        WHERE d.deleted_at IS NULL
          AND d.folder_id IS NOT DISTINCT FROM $1
        ORDER BY d.created_at DESC`,
      [folderId],
    ),
  ])

  const breadcrumb = await buildBreadcrumb(folderId)

  return {
    success: true,
    data: {
      folders,
      documents: docRows.map(toDocument),
      breadcrumb,
    },
  }
}

// ─── Папки ───────────────────────────────────────────────────────────────────

export async function createFolder(name: string, parentId: string | null): Promise<ActionResult<DocumentFolder>> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }
  const trimmed = name.trim()
  if (!trimmed) return { success: false, error: 'Название не может быть пустым' }

  const data = await queryOne<DocumentFolder>(
    `INSERT INTO public.document_folders (name, parent_id, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, name, parent_id, created_by, created_at`,
    [trimmed, parentId, actor.employeeId],
  )

  revalidatePath('/dashboard/documents')
  return { success: true, data: data as DocumentFolder }
}

export async function deleteFolder(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }

  const [subfolderRow, docRow] = await Promise.all([
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM public.document_folders WHERE parent_id = $1`,
      [id],
    ),
    queryOne<{ count: string }>(
      `SELECT COUNT(*) AS count FROM public.documents WHERE folder_id = $1 AND deleted_at IS NULL`,
      [id],
    ),
  ])

  const subfolderCount = Number(subfolderRow?.count ?? 0)
  const docCount = Number(docRow?.count ?? 0)

  if (subfolderCount > 0 || docCount > 0) {
    return { success: false, error: 'Папка не пуста — сначала удалите файлы и подпапки' }
  }

  await query(`DELETE FROM public.document_folders WHERE id = $1`, [id])
  revalidatePath('/dashboard/documents')
  return { success: true }
}

// ─── Документы ───────────────────────────────────────────────────────────────

export async function uploadDocument(formData: FormData): Promise<ActionResult<Document>> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }

  const file = formData.get('file') as File | null
  if (!file || file.size === 0) return { success: false, error: 'Файл не выбран' }

  const folderId = (formData.get('folderId') as string | null) || null
  const category = ((formData.get('category') as string | null) || 'other') as DocumentCategory

  const safeName = file.name.replace(/[^\w.\-А-Яа-яёЁ ]/g, '_')
  const storagePath = `${folderId ?? 'root'}/${crypto.randomUUID()}-${safeName}`

  // TODO(storage): Supabase Storage (`supabase.storage.from(BUCKET).upload(...)`)
  // is not available post-migration, and there is no established replacement
  // (no S3/R2/local-filesystem writer exists anywhere in this repo yet —
  // db/schema.sql explicitly calls storage buckets "out of scope" for now,
  // see the comment above `documents` table). Uploading the actual file bytes
  // is blocked until a storage backend is chosen and wired up. This action
  // still records the row (`storage_path` is populated so the schema/consumers
  // don't need to change) but the file itself is NOT persisted anywhere.
  void BUCKET

  try {
    const row = await queryOne<DocumentRow>(
      `INSERT INTO public.documents
         (name, original_name, category, storage_path, mime_type, size_bytes, uploaded_by, folder_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING documents.*,
         (SELECT id FROM public.employees WHERE id = documents.uploaded_by) AS uploader_id,
         (SELECT name FROM public.employees WHERE id = documents.uploaded_by) AS uploader_name`,
      [
        file.name,
        file.name,
        category,
        storagePath,
        file.type || null,
        file.size,
        actor.employeeId,
        folderId,
      ],
    )

    revalidatePath('/dashboard/documents')
    return { success: true, data: toDocument(row as DocumentRow) }
  } catch (e) {
    const err = e as { code?: string; message: string }
    console.error('[uploadDocument] insert:', err.code, err.message)
    return { success: false, error: err.message }
  }
}

export async function deleteDocument(id: string): Promise<ActionResult> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }

  await query(
    `UPDATE public.documents SET deleted_at = NOW() WHERE id = $1`,
    [id],
  )

  revalidatePath('/dashboard/documents')
  return { success: true }
}

export async function getSignedUrl(storagePath: string): Promise<ActionResult<string>> {
  const actor = await getActor()
  if (!actor) return { success: false, error: 'Не авторизован' }

  // TODO(storage): Supabase Storage signed URLs (`supabase.storage.from(BUCKET)
  // .createSignedUrl(...)`) have no replacement yet — see the TODO in
  // uploadDocument above. Blocked until a storage backend (S3/R2/local) is
  // chosen; there is nothing to sign a URL for since files are not being
  // persisted anywhere post-migration.
  void storagePath
  return { success: false, error: 'Хранилище файлов недоступно: перенос со Supabase Storage ещё не выполнен' }
}

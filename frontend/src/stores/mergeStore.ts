import { createStore } from 'zustand/vanilla'
import { db } from '@/hooks/usePersistentStore'
import { uid } from '@/utils/id'
import {
  buildStaging,
  changeDecision as applyDecision,
  deriveBlockers,
  ENTITY_ORDER,
  parseCollectionPack,
  pendingItems,
  planWrites,
  type CollectionPack,
  type CompatNote,
  type Decision,
  type EntityKind,
  type StagedItem
} from '@/utils/merge'

export type MergeStatus = 'reviewing' | 'writing' | 'done' | 'failed'

export interface MergeSession {
  id: string
  filename: string
  createdAt: string
  updatedAt: string
  status: MergeStatus
  formatVersion: number
  sourceName: string
  compat: CompatNote[]
  items: StagedItem[]
  /** 检查点：已确认写入正式数据的暂存行 key */
  checkpoint: string[]
  error: string
}

export interface MergeStoreState {
  sessions: MergeSession[]
  loaded: boolean
  hydrate: () => Promise<void>
  importPack: (filename: string, text: string) => Promise<{ ok: boolean; message: string; fatal: string[] }>
  decide: (sessionId: string, key: string, decision: Decision) => Promise<void>
  runMerge: (sessionId: string) => Promise<{ ok: boolean; message: string }>
  removeSession: (sessionId: string) => Promise<void>
}

function rowToSession(row: {
  id: string
  filename: string
  createdAt: string
  updatedAt: string
  status: MergeStatus
  formatVersion: number
  sourceName: string
  compat: unknown
  items: unknown[]
  checkpoint: string[]
  error: string
}): MergeSession {
  return {
    id: row.id,
    filename: row.filename,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    formatVersion: row.formatVersion,
    sourceName: row.sourceName,
    compat: (row.compat as CompatNote[]) ?? [],
    items: row.items as StagedItem[],
    checkpoint: row.checkpoint ?? [],
    error: row.error ?? ''
  }
}

function sessionToRow(session: MergeSession) {
  return {
    id: session.id,
    filename: session.filename,
    createdAt: session.createdAt,
    updatedAt: new Date().toISOString(),
    status: session.status,
    formatVersion: session.formatVersion,
    sourceName: session.sourceName,
    compat: session.compat,
    items: session.items,
    checkpoint: session.checkpoint,
    error: session.error
  }
}

async function persist(session: MergeSession): Promise<void> {
  await db.mergeSessions.put(sessionToRow(session))
}

/** 读取本地图谱快照用于比对（直接读库，保证是最新正式数据） */
async function readSnapshot() {
  const [points, records, spores, identifies] = await Promise.all([
    db.points.toArray(),
    db.records.toArray(),
    db.spores.toArray(),
    db.identifies.toArray()
  ])
  return { points, records, spores, identifies }
}

async function hydrateOfficialStores(): Promise<void> {
  const { pointStore } = await import('@/stores/pointStore')
  const { recordStore } = await import('@/stores/recordStore')
  const { sporeStore } = await import('@/stores/sporeStore')
  const { identifyStore } = await import('@/stores/identifyStore')
  await pointStore.getState().hydrate()
  await recordStore.getState().hydrate()
  await sporeStore.getState().hydrate()
  await identifyStore.getState().hydrate()
}

const tables: Record<EntityKind, string> = {
  points: 'points',
  records: 'records',
  spores: 'spores',
  identifies: 'identifies'
}

export const mergeStore = createStore<MergeStoreState>((set, get) => ({
  sessions: [],
  loaded: false,

  hydrate: async () => {
    const rows = await db.mergeSessions.toArray()
    const sessions = rows.map(rowToSession).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    set({ sessions, loaded: true })
  },

  /** 第一步：校验并暂存采集包（不写正式数据），生成逐项确认清单 */
  importPack: async (filename, text) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: '文件不是合法 JSON', fatal: ['JSON 解析失败，请确认导出文件未损坏'] }
    }
    const result = parseCollectionPack(parsed)
    if (!result.pack || result.errors.some((e) => e.includes('未在文件中找到') || e.includes('不是 JSON 对象'))) {
      return { ok: false, message: '无法识别为采集包', fatal: result.errors }
    }
    const pack: CollectionPack = result.pack
    const local = await readSnapshot()
    const items = buildStaging(pack.data, local)
    const session: MergeSession = {
      id: uid('mrg'),
      filename,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'reviewing',
      formatVersion: pack.formatVersion,
      sourceName: pack.source?.collector || filename.replace(/\.json$/i, ''),
      compat: result.compat,
      items,
      checkpoint: [],
      error: ''
    }
    await persist(session)
    await get().hydrate()
    return {
      ok: true,
      fatal: result.errors,
      message: `已校验并暂存：采集点 ${pack.data.points.length}、条目 ${pack.data.records.length}、孢子印 ${pack.data.spores.length}、鉴定 ${pack.data.identifies.length}`
    }
  },

  /** 逐项确认：更新某一行的并入决定（已过检查点的行已落正式数据，不可改） */
  decide: async (sessionId, key, decision) => {
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session || session.status === 'writing' || session.status === 'done') return
    if (session.checkpoint.includes(key)) return
    const items = applyDecision(session.items, key, decision, uid)
    const next = { ...session, items, updatedAt: new Date().toISOString() }
    await persist(next)
    await get().hydrate()
  },

  /**
   * 第二步：按「采集点 → 菌物条目 → 孢子印 → 鉴定结论」顺序写入。
   * 每行在独立事务里与检查点同进同退；中断后再次调用会从检查点恢复，
   * 已确认写入的行不会重复写入。
   */
  runMerge: async (sessionId) => {
    const current = get().sessions.find((item) => item.id === sessionId)
    if (!current) return { ok: false, message: '合并会话不存在' }
    if (current.status === 'done') return { ok: false, message: '该采集包已并入完成' }

    if (pendingItems(current.items).length > 0) {
      return { ok: false, message: '仍有未确认或被阻断的项目，不能开始写入' }
    }

    const planned = planWrites(current.items)
    const done = new Set(current.checkpoint)
    let session: MergeSession = { ...current, status: 'writing', error: '', updatedAt: new Date().toISOString() }
    await persist(session)
    await get().hydrate()

    let written = 0
    try {
      for (const kind of ENTITY_ORDER) {
        for (const write of planned.filter((item) => item.kind === kind)) {
          if (done.has(write.key)) continue // 检查点恢复：跳过已确认写入的部分
          // 单行 + 检查点放在同一事务：要么都生效，要么都回滚，杜绝重复写入
          const table = db.table(tables[kind])
          await db.transaction('rw', table, db.mergeSessions, async () => {
            await table.put(write.row)
            done.add(write.key)
            await db.mergeSessions.update(session.id, {
              checkpoint: [...done],
              status: 'writing',
              updatedAt: new Date().toISOString()
            })
          })
          written += 1
        }
      }
      session = {
        ...session,
        status: 'done',
        checkpoint: [...done],
        error: '',
        updatedAt: new Date().toISOString()
      }
      await persist(session)
      await hydrateOfficialStores()
      await get().hydrate()
      return { ok: true, message: written === 0 ? '没有需要新写入的内容（此前已完成）' : `并入完成，本次写入 ${written} 项，共确认 ${done.size} 项` }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      session = {
        ...session,
        status: 'failed',
        checkpoint: [...done],
        error: reason,
        updatedAt: new Date().toISOString()
      }
      await persist(session)
      await get().hydrate()
      return { ok: false, message: `写入中断（${reason}），已保留检查点，可从检查点恢复继续，不会重复写入` }
    }
  },

  removeSession: async (sessionId) => {
    await db.mergeSessions.delete(sessionId)
    await get().hydrate()
  }
}))

/** 页面用：实时阻断原因（未消除阻断的行不能进入正式数据） */
export function blockersOf(items: StagedItem[]): Map<string, string[]> {
  return deriveBlockers(items)
}

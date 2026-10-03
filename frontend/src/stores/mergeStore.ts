import { createStore } from 'zustand/vanilla'
import type { ApplyResult, CollectionPackage, LocalSnapshot, MergeSession } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import {
  applyConfirmedItems,
  buildMergePlan,
  createSession,
  parsePackage
} from '@/utils/merge'

export interface MergeState {
  sessions: MergeSession[]
  activeId: string | null
  loaded: boolean
  hydrate: () => Promise<void>
  /** 校验并暂存采集包，返回可恢复的合并会话；duplicated=true 表示同指纹会话已存在 */
  stageFile: (fileName: string, text: string, local: LocalSnapshot) => Promise<{ session: MergeSession; duplicated: boolean }>
  select: (id: string | null) => Promise<void>
  setItemConfirmed: (itemKey: string, confirmed: boolean) => Promise<void>
  /** 一键勾选本阶段/整批的新增项（冲突项必须逐项确认） */
  confirmAllNew: (stage?: MergeSession['items'][number]['stage']) => Promise<void>
  /** 从检查点继续写入已确认条目，不重复写入已确认部分 */
  applyActive: () => Promise<ApplyResult | null>
  discard: (id: string) => Promise<void>
  activeSession: () => MergeSession | undefined
}

function sortSessions(sessions: MergeSession[]): MergeSession[] {
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export const mergeStore = createStore<MergeState>((set, get) => ({
  sessions: [],
  activeId: null,
  loaded: false,

  hydrate: async () => {
    const sessions = sortSessions(await db.mergeSessions.toArray())
    const activeId = get().activeId
    const nextActive = activeId && sessions.some((item) => item.id === activeId)
      ? activeId
      : sessions.find((item) => item.status !== 'done')?.id ?? null
    set({ sessions, activeId: nextActive, loaded: true })
  },

  stageFile: async (fileName, text, local) => {
    const parsed = parsePackage(text)
    // 同一内容指纹的采集包不重复暂存，直接激活已有会话（检查点可继续）
    const existing = get().sessions.find((item) => item.packageHash === parsed.hash)
    if (existing) {
      set({ activeId: existing.id })
      return { session: existing, duplicated: true }
    }
    const { items } = buildMergePlan(parsed.pkg as CollectionPackage, local)
    const session = createSession(fileName, parsed, items)
    await db.mergeSessions.put(session)
    await get().hydrate()
    set({ activeId: session.id })
    return { session, duplicated: false }
  },

  select: async (id) => {
    set({ activeId: id })
  },

  setItemConfirmed: async (itemKey, confirmed) => {
    const session = get().activeSession()
    if (!session) return
    const item = session.items.find((candidate) => candidate.itemKey === itemKey)
    if (!item) return
    // 已写入与自动跳过项不可变更；校验失败项不能勾选进入正式数据
    if (item.state === 'written' || item.state === 'skipped') return
    if (confirmed) {
      if (item.kind === 'error' || !item.resolved) return
      item.state = 'confirmed'
    } else {
      item.state = 'pending'
    }
    item.failReason = undefined
    if (session.status === 'failed' || session.status === 'partial') session.status = 'staged'
    session.updatedAt = new Date().toISOString()
    await db.mergeSessions.put(session)
    await get().hydrate()
  },

  confirmAllNew: async (stage) => {
    const session = get().activeSession()
    if (!session) return
    let changed = false
    for (const item of session.items) {
      if (stage && item.stage !== stage) continue
      // 只批量勾选「新增」；同一编号内容不同的冲突项必须逐项确认
      if (item.kind === 'new' && item.state === 'pending') {
        item.state = 'confirmed'
        changed = true
      }
    }
    if (changed) {
      if (session.status === 'failed' || session.status === 'partial') session.status = 'staged'
      session.updatedAt = new Date().toISOString()
      await db.mergeSessions.put(session)
      await get().hydrate()
    }
  },

  applyActive: async () => {
    const session = get().activeSession()
    if (!session) return null
    const result = await applyConfirmedItems(session, {
      points: db.points,
      records: db.records,
      spores: db.spores,
      identifies: db.identifies
    })
    await db.mergeSessions.put(session)
    await get().hydrate()
    set({ activeId: session.id })
    return result
  },

  discard: async (id) => {
    await db.mergeSessions.delete(id)
    if (get().activeId === id) set({ activeId: null })
    await get().hydrate()
  },

  activeSession: () => {
    const { sessions, activeId } = get()
    return sessions.find((item) => item.id === activeId)
  }
}))

import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from './index'

/** 合并写入顺序：采集点 → 菌物条目 → 孢子印 → 鉴定结论 */
export type MergeStage = 'points' | 'records' | 'spores' | 'identifies'

export const MERGE_STAGES: MergeStage[] = ['points', 'records', 'spores', 'identifies']

export const STAGE_LABELS: Record<MergeStage, string> = {
  points: '采集点',
  records: '菌物条目',
  spores: '孢子印',
  identifies: '鉴定结论'
}

/**
 * 暂存条目与本地正式数据的对照关系：
 * - new：本地不存在，待新增
 * - conflict：同一自然键（菌物条目看采集编号，其余看 id）内容不同，保留两边版本
 * - identical：内容一致，无需写入，自动跳过
 * - error：校验未通过（含引用缺失），不能进入正式数据
 */
export type ItemKind = 'new' | 'conflict' | 'identical' | 'error'

/** 条目流转状态 */
export type ItemState = 'pending' | 'confirmed' | 'written' | 'skipped' | 'failed'

/** 冲突逐项对照 */
export interface FieldDiff {
  key: string
  label: string
  local: string
  incoming: string
}

export type StageRow = CollectPoint | FungusRecord | SporePrint | IdentifyLog

/** 一条暂存记录 */
export interface MergeItem {
  /** 会话内唯一：stage#序号 */
  itemKey: string
  stage: MergeStage
  /** 自然键：采集点/孢子印/鉴定结论取 id，菌物条目取采集编号 */
  naturalKey: string
  kind: ItemKind
  state: ItemState
  /** 校验错误（kind=error 时不可勾选确认） */
  errors: string[]
  /** 兼容读写补齐字段、忽略字段等提示 */
  warnings: string[]
  /** 冲突字段明细 */
  diffs: FieldDiff[]
  /** 采集包内归一化后的行（外键尚未重映射） */
  incoming: StageRow | Record<string, unknown>
  /** 匹配到的本地行 */
  local?: StageRow
  /** 实际写入用的行（外键已解析、冲突版本已换新 id） */
  resolved: StageRow | null
  /** 最近一次写入失败原因 */
  failReason?: string
}

export type SessionStatus = 'staged' | 'writing' | 'partial' | 'done' | 'failed'

/** 写入检查点：保证中断恢复后不重复写入已确认部分 */
export interface MergeCheckpoint {
  /** 最近一次成功写入的条目 itemKey，null 表示尚未写入 */
  lastItemKey: string | null
  writtenCount: number
  updatedAt: string
  lastError?: string
}

/** 离线合并会话（整体持久化到 mergeSessions 表） */
export interface MergeSession {
  id: string
  status: SessionStatus
  fileName: string
  packageHash: string
  group: string
  exportedAt: string
  /** 采集包级别的提示（旧版本、忽略字段等） */
  packageWarnings: string[]
  items: MergeItem[]
  checkpoint: MergeCheckpoint
  createdAt: string
  updatedAt: string
}

/** 采集包文件结构（野外分组离线导出） */
export interface CollectionPackage {
  kind: string
  packageVersion: number
  exportedAt: string
  group: string
  points: unknown[]
  records: unknown[]
  spores: unknown[]
  identifies: unknown[]
}

export interface LocalSnapshot {
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

export interface ApplyResult {
  written: number
  failed: MergeItem | null
  remaining: number
}

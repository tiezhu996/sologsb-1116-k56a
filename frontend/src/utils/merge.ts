import {
  CAP_MARGINS,
  CAP_SHAPES,
  CAP_TEXTURES,
  FLESH_REACTIONS,
  GILL_ATTACHMENTS,
  GILL_DENSITIES,
  ID_BASES,
  ID_CONFIDENCES,
  RING_TYPES,
  SPORE_COLORS,
  SUBSTRATES,
  VEGETATIONS,
  VOLVA_TYPES
} from '@/types'
import type { CollectPoint, FungusRecord, IdentifyLog, SporePrint } from '@/types'

/** 采集包实体类型，写入顺序即数组顺序：采集点 → 菌物条目 → 孢子印 → 鉴定结论 */
export type EntityKind = 'points' | 'records' | 'spores' | 'identifies'

export const ENTITY_ORDER: EntityKind[] = ['points', 'records', 'spores', 'identifies']

export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  points: '采集点',
  records: '菌物条目',
  spores: '孢子印',
  identifies: '鉴定结论'
}

export type AnyEntity = CollectPoint | FungusRecord | SporePrint | IdentifyLog
export type EntityRecord = Record<string, unknown>

export const PACKAGE_KIND = 'gbfungiguide-collection-pack'
/** 采集包格式版本：与本地数据结构版本对齐，旧包缺字段时走兼容读写 */
export const CURRENT_FORMAT_VERSION = 2
export const PACKAGE_SUFFIX = '（并入）'

export interface PackSource {
  collector?: string
  note?: string
}

export interface CollectionPackData {
  points: CollectPoint[]
  records: FungusRecord[]
  spores: SporePrint[]
  identifies: IdentifyLog[]
}

export interface CollectionPack {
  kind: string
  formatVersion: number
  exportedAt?: string
  source?: PackSource
  data: CollectionPackData
}

/** 兼容读写留痕：旧版本采集包缺了哪个新字段、补了什么默认值 */
export interface CompatNote {
  kind: EntityKind | ''
  entityId: string
  fields: string[]
  reason: string
}

/** 暂存实体上携带的校验问题内部标记（解析时写入，暂存后从实体上剥离） */
export const ISSUE_MARKER = '__issue'

export interface ParseResult {
  pack: CollectionPack | null
  /** 致命错误：文件无法识别为采集包（标识不符等警告也放这里） */
  errors: string[]
  compat: CompatNote[]
}

/* ------------------------------ 字段元数据 ------------------------------ */

export const FIELD_LABELS: Record<EntityKind, Record<string, string>> = {
  points: {
    name: '地点名',
    longitude: '经度',
    latitude: '纬度',
    altitude: '海拔',
    vegetation: '植被类型',
    substrate: '基物',
    companionTrees: '伴生树种',
    collectDate: '采集日期',
    collector: '采集人'
  },
  records: {
    code: '采集编号',
    tempName: '暂定名',
    fruitBodyCount: '子实体数量',
    pointId: '所属采集点',
    capDiameter: '菌盖直径',
    capShape: '菌盖形状',
    capMargin: '菌盖边缘',
    capTexture: '表面质地',
    fleshThickness: '菌肉厚度',
    fleshReaction: '菌肉变色反应',
    attachment: '着生方式',
    gillDensity: '菌褶密度',
    stipeLength: '菌柄长度',
    stipeDiameter: '菌柄直径',
    ring: '菌环',
    volva: '菌托',
    odor: '气味',
    hostTree: '关联树种',
    collectDate: '采集日期',
    collector: '采集人',
    note: '备注'
  },
  spores: {
    recordId: '所属条目',
    color: '印色',
    shape: '印形',
    hours: '获取时长',
    observeDate: '观察日期',
    moisture: '样本干湿度'
  },
  identifies: {
    recordId: '所属条目',
    conclusion: '结论学名',
    basis: '鉴定依据',
    referenceBook: '参考图鉴',
    referencePage: '页码',
    confidence: '置信度',
    needReview: '是否待复核',
    reviewer: '复核人',
    date: '日期'
  }
}

function baseEntity(kind: EntityKind): EntityRecord {
  if (kind === 'points') {
    return {
      id: '',
      name: '',
      longitude: 0,
      latitude: 0,
      altitude: 0,
      vegetation: '针阔混交林',
      substrate: '落叶层',
      companionTrees: '',
      collectDate: '',
      collector: ''
    }
  }
  if (kind === 'records') {
    return {
      id: '',
      code: '',
      tempName: '',
      fruitBodyCount: 1,
      pointId: '',
      capDiameter: 0,
      capShape: '平展',
      capMargin: '全缘',
      capTexture: '光滑',
      fleshThickness: 0,
      fleshReaction: '不变色',
      attachment: '直生',
      gillDensity: '中等',
      stipeLength: 0,
      stipeDiameter: 0,
      ring: '无菌环',
      volva: '无菌托',
      odor: '',
      hostTree: '',
      collectDate: '',
      collector: '',
      note: ''
    }
  }
  if (kind === 'spores') {
    return {
      id: '',
      recordId: '',
      color: '白色',
      shape: '',
      hours: 0,
      observeDate: '',
      moisture: ''
    }
  }
  return {
    id: '',
    recordId: '',
    conclusion: '',
    basis: '形态特征',
    referenceBook: '',
    referencePage: '',
    confidence: '中',
    needReview: true,
    reviewer: '',
    date: ''
  }
}

const ENUM_FIELDS: Record<EntityKind, Record<string, readonly string[]>> = {
  points: { vegetation: VEGETATIONS, substrate: SUBSTRATES },
  records: {
    capShape: CAP_SHAPES,
    capMargin: CAP_MARGINS,
    capTexture: CAP_TEXTURES,
    fleshReaction: FLESH_REACTIONS,
    attachment: GILL_ATTACHMENTS,
    gillDensity: GILL_DENSITIES,
    ring: RING_TYPES,
    volva: VOLVA_TYPES
  },
  spores: { color: SPORE_COLORS },
  identifies: { basis: ID_BASES, confidence: ID_CONFIDENCES }
}

const NUMERIC_FIELDS: Record<EntityKind, string[]> = {
  points: ['longitude', 'latitude', 'altitude'],
  records: ['fruitBodyCount', 'capDiameter', 'fleshThickness', 'stipeLength', 'stipeDiameter'],
  spores: ['hours'],
  identifies: []
}

const BOOLEAN_FIELDS: Record<EntityKind, string[]> = {
  points: [],
  records: [],
  spores: [],
  identifies: ['needReview']
}

/** 比较时忽略主键与外键：外键指向同一实体的不同副本不算内容差异 */
const DIFF_IGNORE_FIELDS = new Set(['id', 'pointId', 'recordId'])

interface NormalizeResult {
  entity: EntityRecord | null
  compatFields: string[]
  errors: string[]
}

/** 单条实体的兼容读写：缺新字段补默认值并留痕，类型/枚举非法则报校验错误 */
function normalizeEntity(kind: EntityKind, raw: unknown): NormalizeResult {
  const base = baseEntity(kind)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { entity: null, compatFields: [], errors: ['不是有效的对象'] }
  }
  const source = raw as EntityRecord
  const errors: string[] = []
  const compatFields: string[] = []

  if (typeof source.id !== 'string' || !source.id.trim()) {
    errors.push('缺少唯一 id')
  }

  const out: EntityRecord = {}
  for (const [key, defaultValue] of Object.entries(base)) {
    if (key === 'id') {
      out.id = typeof source.id === 'string' ? source.id.trim() : ''
      continue
    }
    const labels = FIELD_LABELS[kind]
    if (!(key in source) || source[key] === null || source[key] === undefined) {
      // 旧版本采集包缺少新字段：按默认值兼容补齐
      out[key] = defaultValue
      compatFields.push(labels[key] ?? key)
      continue
    }
    const value = source[key]
    if (NUMERIC_FIELDS[kind].includes(key)) {
      const num = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(num)) {
        errors.push(`「${labels[key] ?? key}」必须是数字`)
        out[key] = defaultValue
      } else {
        out[key] = num
      }
      continue
    }
    if (BOOLEAN_FIELDS[kind].includes(key)) {
      if (typeof value !== 'boolean') {
        errors.push(`「${labels[key] ?? key}」必须是布尔值`)
        out[key] = defaultValue
      } else {
        out[key] = value
      }
      continue
    }
    const text = typeof value === 'string' ? value.trim() : String(value ?? '')
    const enumValues = ENUM_FIELDS[kind][key]
    if (enumValues && !enumValues.includes(text)) {
      errors.push(`「${labels[key] ?? key}」取值「${text}」不在当前版本允许范围内`)
      out[key] = defaultValue
      continue
    }
    out[key] = text
  }

  if (kind === 'records' && !String(out.code)) errors.push('缺少采集编号 code')
  if (kind === 'points') {
    const lon = Number(out.longitude)
    const lat = Number(out.latitude)
    if (lon < -180 || lon > 180) errors.push('经度必须在 -180 ~ 180 之间')
    if (lat < -90 || lat > 90) errors.push('纬度必须在 -90 ~ 90 之间')
  }
  if ((kind === 'records' && !String(out.pointId)) || (kind !== 'points' && kind !== 'records' && !String(out.recordId))) {
    if (kind === 'records') errors.push('缺少所属采集点 pointId')
    else errors.push('缺少所属条目 recordId')
  }

  return { entity: out, compatFields, errors }
}

/* -------------------------------- 解包 -------------------------------- */

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 解析采集包，兼容三种形态：
 * 1. 当前版信封 { kind, formatVersion: 2, data: { points, records, spores, identifies } }
 * 2. 旧版信封（formatVersion: 1，数据在顶层）
 * 3. 裸对象 { points, records, spores, identifies }
 */
export function parseCollectionPack(input: unknown): ParseResult {
  const compat: CompatNote[] = []
  const errors: string[] = []

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { pack: null, errors: ['文件内容不是 JSON 对象，无法识别为采集包'], compat }
  }
  const root = input as EntityRecord

  let dataNode: EntityRecord
  let formatVersion = 1
  let source: PackSource = {}
  let exportedAt: string | undefined
  let hasEnvelope = false

  if (root.data && typeof root.data === 'object' && !Array.isArray(root.data)) {
    hasEnvelope = true
    dataNode = root.data as EntityRecord
    formatVersion = typeof root.formatVersion === 'number' ? root.formatVersion : 1
    source = (root.source as PackSource) ?? {}
    exportedAt = typeof root.exportedAt === 'string' ? root.exportedAt : undefined
    if (root.kind && root.kind !== PACKAGE_KIND) {
      errors.push(`采集包标识为「${String(root.kind)}」与预期「${PACKAGE_KIND}」不符，仍尝试按内容读取`)
    }
  } else if (['points', 'records', 'spores', 'identifies'].some((key) => Array.isArray(root[key]))) {
    // 旧版或裸导出：四个数组直接在顶层
    dataNode = root
    formatVersion = typeof root.formatVersion === 'number' ? root.formatVersion : 1
  } else {
    return { pack: null, errors: ['未在文件中找到 points / records / spores / identifies 数据，文件可能不是采集包'], compat }
  }

  if (!hasEnvelope) {
    compat.push({ kind: '', entityId: '', fields: [], reason: '采集包缺少版本信封，按旧版格式兼容读取' })
  }
  if (formatVersion < CURRENT_FORMAT_VERSION) {
    compat.push({
      kind: '',
      entityId: '',
      fields: ['菌肉变色反应'],
      reason: `旧版本采集包（v${formatVersion}）缺少新字段，已按当前版本（v${CURRENT_FORMAT_VERSION}）默认值兼容补齐`
    })
  } else if (formatVersion > CURRENT_FORMAT_VERSION) {
    compat.push({
      kind: '',
      entityId: '',
      fields: [],
      reason: `采集包版本 v${formatVersion} 新于当前支持的 v${CURRENT_FORMAT_VERSION}，未知字段已忽略，按兼容方式读取`
    })
  }

  const data: CollectionPackData = { points: [], records: [], spores: [], identifies: [] }
  ;(Object.keys(data) as EntityKind[]).forEach((kind) => {
    const rows = asArray(dataNode[kind])
    rows.forEach((raw, index) => {
      const result = normalizeEntity(kind, raw)
      const entityId =
        raw && typeof raw === 'object' && typeof (raw as EntityRecord).id === 'string'
          ? String((raw as EntityRecord).id)
          : `第 ${index + 1} 条`
      if (result.compatFields.length > 0) {
        compat.push({
          kind,
          entityId,
          fields: result.compatFields,
          reason: `缺少字段${result.compatFields.map((f) => `「${f}」`).join('、')}，已按默认值补齐`
        })
      }
      if (result.errors.length > 0) {
        // 实体级问题照样暂存（带 issues 默认阻断），让用户在清单里看到并明确选择跳过
        ;(result.entity as EntityRecord)['__issue'] = result.errors
      }
      if (result.entity) (data[kind] as AnyEntity[]).push(result.entity as unknown as AnyEntity)
    })
  })

  return {
    pack: { kind: PACKAGE_KIND, formatVersion, exportedAt, source, data },
    errors,
    compat
  }
}

/** 把当前图谱数据打成采集包（兼容写：统一输出当前版本、只保留在册字段） */
export function buildCollectionPack(local: CollectionPackData, source?: PackSource): CollectionPack {
  return {
    kind: PACKAGE_KIND,
    formatVersion: CURRENT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: source ?? {},
    data: {
      points: local.points.map((row) => ({ ...row })),
      records: local.records.map((row) => ({ ...row })),
      spores: local.spores.map((row) => ({ ...row })),
      identifies: local.identifies.map((row) => ({ ...row }))
    }
  }
}

/* ------------------------------ 暂存与比对 ------------------------------ */

export type MatchKind = 'none' | 'same' | 'conflict'
/** pending=尚未确认（冲突项必须逐项确认）；accept=并入（冲突时即覆盖本地）；skip=跳过；keepBoth=保留两边 */
export type Decision = 'pending' | 'accept' | 'skip' | 'keepBoth'

export interface StagedRef {
  id: string
  /** 被引用实体在本地图谱中是否已存在 */
  localExists: boolean
}

export interface StagedItem {
  /** 暂存行唯一键：${kind}:${incomingId}（包内 id 重复时追加序号） */
  key: string
  kind: EntityKind
  incomingId: string
  /** 冲突时命中的本地实体 id（保留两边/覆盖都以它为基准） */
  localId?: string
  label: string
  subLabel: string
  match: MatchKind
  decision: Decision
  /** 选择「保留两边」时分配的新 id（检查点恢复后保持稳定） */
  remapId?: string
  diffFields: string[]
  /** 校验阶段的硬错误（未消除前不能并入） */
  issues: string[]
  incoming: AnyEntity
  pointRef?: StagedRef
  recordRef?: StagedRef
}

export interface LocalSnapshot extends CollectionPackData {}

function entityLabel(kind: EntityKind, row: EntityRecord): string {
  if (kind === 'points') return String(row.name || '未命名采集点')
  if (kind === 'records') return String(row.code || '未编号条目')
  if (kind === 'spores') return `孢子印·${String(row.recordId)}·${String(row.color)}`
  return `鉴定·${String(row.conclusion || '未定名')}·${String(row.recordId)}`
}

function entitySubLabel(kind: EntityKind, row: EntityRecord): string {
  if (kind === 'records') return String(row.tempName ?? '')
  if (kind === 'identifies') return `${String(row.date ?? '')} ${String(row.reviewer ?? '')}`.trim()
  if (kind === 'spores') return String(row.observeDate ?? '')
  return `${String(row.collector ?? '')} ${String(row.collectDate ?? '')}`.trim()
}

function comparableFields(kind: EntityKind, row: EntityRecord): EntityRecord {
  const out: EntityRecord = {}
  for (const key of Object.keys(baseEntity(kind))) {
    if (DIFF_IGNORE_FIELDS.has(key)) continue
    out[key] = row[key]
  }
  return out
}

function stableString(value: unknown): string {
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`
  const obj = value as EntityRecord
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableString(obj[key])}`)
    .join(',')}}`
}

export function entitiesEqual(kind: EntityKind, a: EntityRecord, b: EntityRecord): boolean {
  return stableString(comparableFields(kind, a)) === stableString(comparableFields(kind, b))
}

function diffFieldLabels(kind: EntityKind, local: EntityRecord, incoming: EntityRecord): string[] {
  const labels = FIELD_LABELS[kind]
  const diffs: string[] = []
  for (const key of Object.keys(baseEntity(kind))) {
    if (DIFF_IGNORE_FIELDS.has(key)) continue
    if (stableString(local[key]) !== stableString(incoming[key])) diffs.push(labels[key] ?? key)
  }
  return diffs
}

/**
 * 校验后暂存：与本地快照逐项比对并分类。
 * - 采集点：先按 id 命中，id 不同则按同名地点兜底命中
 * - 菌物条目：按采集编号 code 命中（同一编号内容不同即冲突）
 * - 孢子印 / 鉴定结论：按 id 命中
 * 带校验问题的行（解析时打了 ISSUE_MARKER）同样入暂存清单，默认 pending 阻断，需明确跳过。
 */
export function buildStaging(data: CollectionPackData, local: LocalSnapshot): StagedItem[] {
  const items: StagedItem[] = []
  const usedKeys = new Set<string>()

  const addItem = (kind: EntityKind, rawIncoming: EntityRecord, localRow?: EntityRecord, localId?: string): StagedItem => {
    const rowIssues = Array.isArray(rawIncoming[ISSUE_MARKER]) ? (rawIncoming[ISSUE_MARKER] as string[]) : []
    // 剥离内部标记，保证暂存与落库的实体干净
    const incoming: EntityRecord = { ...rawIncoming }
    delete incoming[ISSUE_MARKER]

    const invalidId = !String(incoming.id)
    let key = invalidId ? `${kind}:#invalid-${items.length}` : `${kind}:${String(incoming.id)}`
    let seq = 2
    while (usedKeys.has(key)) {
      key = `${kind}:${String(incoming.id) || 'invalid'}#${seq}`
      seq += 1
    }
    usedKeys.add(key)

    let match: MatchKind = 'none'
    let diffFields: string[] = []
    if (localRow && !invalidId) {
      match = entitiesEqual(kind, localRow, incoming) ? 'same' : 'conflict'
      diffFields = match === 'conflict' ? diffFieldLabels(kind, localRow, incoming) : []
    }
    const hasIssue = rowIssues.length > 0 || invalidId
    const item: StagedItem = {
      key,
      kind,
      incomingId: String(incoming.id),
      localId,
      label: invalidId ? `（缺少 id 的${ENTITY_KIND_LABELS[kind]}）` : entityLabel(kind, incoming),
      subLabel: entitySubLabel(kind, incoming),
      match,
      decision: hasIssue || match === 'conflict' ? 'pending' : match === 'same' ? 'skip' : 'accept',
      diffFields,
      issues: invalidId ? ['缺少唯一 id，无法并入，请跳过并要求对方重新导出', ...rowIssues] : rowIssues,
      incoming: incoming as unknown as AnyEntity
    }
    items.push(item)
    return item
  }

  // 采集点
  const localPointIds = new Set(local.points.map((row) => row.id))
  data.points.forEach((raw) => {
    const incoming = raw as unknown as EntityRecord
    if (!String(incoming.id)) {
      addItem('points', incoming)
      return
    }
    const byId = local.points.find((row) => row.id === incoming.id)
    if (byId) {
      addItem('points', incoming, byId as unknown as EntityRecord, byId.id)
    } else {
      const byName = String(incoming.name).trim() ? local.points.find((row) => row.name === incoming.name) : undefined
      if (byName) addItem('points', incoming, byName as unknown as EntityRecord, byName.id)
      else addItem('points', incoming)
    }
  })

  // 菌物条目（按采集编号）
  data.records.forEach((raw) => {
    const incoming = raw as unknown as EntityRecord
    if (!String(incoming.id)) {
      addItem('records', incoming)
      return
    }
    const sameCode = local.records.find((row) => row.code === incoming.code)
    const item = sameCode
      ? addItem('records', incoming, sameCode as unknown as EntityRecord, sameCode.id)
      : addItem('records', incoming)
    item.pointRef = {
      id: String(incoming.pointId),
      localExists: localPointIds.has(String(incoming.pointId))
    }
  })

  // 孢子印 / 鉴定结论（按 id，外键指向采集包内或本地的条目）
  const localRecordIds = new Set(local.records.map((row) => row.id))
  for (const kind of ['spores', 'identifies'] as const) {
    data[kind].forEach((raw) => {
      const incoming = raw as unknown as EntityRecord
      if (!String(incoming.id)) {
        addItem(kind, incoming)
        return
      }
      const byId = local[kind].find((row) => row.id === incoming.id)
      const item = byId
        ? addItem(kind, incoming, byId as unknown as EntityRecord, byId.id)
        : addItem(kind, incoming)
      item.recordRef = {
        id: String(incoming.recordId),
        localExists: localRecordIds.has(String(incoming.recordId))
      }
    })
  }

  return items
}

/* ------------------------------ 决策与守卫 ------------------------------ */

/** 采集包内同键重复（多组离线记录撞号）的行 */
export function intraPackDuplicateKeys(items: StagedItem[]): Set<string> {
  const groups = new Map<string, StagedItem[]>()
  for (const item of items) {
    let groupKey: string
    if (item.kind === 'records') groupKey = `code:${String((item.incoming as unknown as EntityRecord).code)}`
    else if (item.kind === 'points') groupKey = `name:${String((item.incoming as unknown as EntityRecord).name)}`
    else groupKey = `id:${item.incomingId}`
    const list = groups.get(groupKey) ?? []
    list.push(item)
    groups.set(groupKey, list)
  }
  const dup = new Set<string>()
  for (const list of groups.values()) {
    if (list.length > 1) list.forEach((item) => dup.add(item.key))
  }
  return dup
}

/**
 * 实时推导每行的阻断原因：外键目标没并入、包内撞号却选择直接并入等。
 * 未消除阻断的行不能进入正式数据。
 */
export function deriveBlockers(items: StagedItem[]): Map<string, string[]> {
  const acceptedPoints = new Set<string>()
  const acceptedRecords = new Set<string>()
  for (const item of items) {
    if (item.decision === 'accept' || item.decision === 'keepBoth') {
      if (item.kind === 'points') acceptedPoints.add(item.incomingId)
      if (item.kind === 'records') acceptedRecords.add(item.incomingId)
    }
  }

  const dupKeys = intraPackDuplicateKeys(items)
  const blockers = new Map<string, string[]>()
  for (const item of items) {
    const reasons: string[] = []
    if (item.issues.length > 0) reasons.push(...item.issues)
    if (item.decision === 'accept' || item.decision === 'keepBoth') {
      if (item.pointRef && !item.pointRef.localExists && !acceptedPoints.has(item.pointRef.id)) {
        reasons.push('引用的采集点未并入，请先确认采集点')
      }
      if (item.recordRef && !item.recordRef.localExists && !acceptedRecords.has(item.recordRef.id)) {
        reasons.push('所属菌物条目未并入，请先确认该条目')
      }
      if (item.decision === 'accept' && dupKeys.has(item.key)) {
        reasons.push('采集包内存在同编号/同名重复，请选择「保留两边」或「跳过」')
      }
    }
    if (reasons.length > 0) blockers.set(item.key, reasons)
  }
  return blockers
}

export interface PendingItem {
  key: string
  kind: EntityKind
  label: string
  reasons: string[]
}

/** 尚未完成逐项确认的行：冲突未决，或已选并入但仍有阻断 */
export function pendingItems(items: StagedItem[]): PendingItem[] {
  const blockers = deriveBlockers(items)
  const result: PendingItem[] = []
  for (const item of items) {
    const reasons: string[] = []
    if (item.match === 'conflict' && item.decision === 'pending') reasons.push('同一编号存在内容不同的两个版本，需逐项确认')
    if (item.decision === 'pending' && item.issues.length > 0) reasons.push('校验未通过，修正后选择跳过或并入')
    const blocked = blockers.get(item.key)
    if (blocked && (item.decision === 'accept' || item.decision === 'keepBoth')) reasons.push(...blocked)
    if (reasons.length > 0) result.push({ key: item.key, kind: item.kind, label: item.label, reasons })
  }
  return result
}

/** 是否展示「保留两边」：本地冲突，或采集包内部撞号 */
export function canKeepBoth(item: StagedItem, items: StagedItem[]): boolean {
  return item.match === 'conflict' || intraPackDuplicateKeys(items).has(item.key)
}

/** 变更单项确认结果；选「保留两边」时一次性分配稳定的新 id，检查点恢复后不重新分配 */
export function changeDecision(
  items: StagedItem[],
  key: string,
  decision: Decision,
  genId: (prefix: string) => string
): StagedItem[] {
  const prefixMap: Record<EntityKind, string> = { points: 'pt', records: 'rec', spores: 'spo', identifies: 'idf' }
  return items.map((item) => {
    if (item.key !== key) return item
    const next = { ...item, decision }
    if (decision === 'keepBoth' && !next.remapId) next.remapId = genId(prefixMap[item.kind])
    if (decision !== 'keepBoth') next.remapId = undefined
    return next
  })
}

/* ------------------------------ 写入计划 ------------------------------ */

export interface PlannedWrite {
  key: string
  kind: EntityKind
  /** 最终落库的主键 id */
  id: string
  row: AnyEntity
}

/** 采集包内 id → 落库最终 id 的映射（冲突覆盖时指向本地 id，保留两边时指向新 id） */
export function idMaps(items: StagedItem[]): {
  points: Map<string, string>
  records: Map<string, string>
} {
  const points = new Map<string, string>()
  const records = new Map<string, string>()
  for (const item of items) {
    if (item.decision === 'skip' || item.decision === 'pending') continue
    if (item.kind === 'points') points.set(item.incomingId, item.remapId ?? item.localId ?? item.incomingId)
    if (item.kind === 'records') records.set(item.incomingId, item.remapId ?? item.localId ?? item.incomingId)
  }
  return { points, records }
}

/**
 * 按「采集点 → 菌物条目 → 孢子印 → 鉴定结论」生成写入序列；
 * 仅包含已确认并入、且无阻断的行。
 */
export function planWrites(items: StagedItem[]): PlannedWrite[] {
  const blockers = deriveBlockers(items)
  const maps = idMaps(items)
  const writes: PlannedWrite[] = []

  for (const kind of ENTITY_ORDER) {
    for (const item of items.filter((row) => row.kind === kind)) {
      if (item.decision !== 'accept' && item.decision !== 'keepBoth') continue
      if (blockers.has(item.key)) continue

      const incoming = { ...(item.incoming as unknown as EntityRecord) }
      let id = item.remapId ?? item.localId ?? item.incomingId
      if (item.kind === 'points') {
        if (item.decision === 'keepBoth') incoming.name = `${String(incoming.name)}${PACKAGE_SUFFIX}`
      } else if (item.kind === 'records') {
        if (item.decision === 'keepBoth') incoming.code = `${String(incoming.code)}${PACKAGE_SUFFIX}`
        const pointId = maps.points.get(String(incoming.pointId))
        if (pointId) incoming.pointId = pointId
      } else {
        const recordId = maps.records.get(String(incoming.recordId))
        if (recordId) incoming.recordId = recordId
      }
      incoming.id = id
      writes.push({ key: item.key, kind, id, row: incoming as unknown as AnyEntity })
    }
  }
  return writes
}

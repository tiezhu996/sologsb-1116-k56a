import type { Table } from 'dexie'
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
import type {
  ApplyResult,
  CollectPoint,
  CollectionPackage,
  FieldDiff,
  FungusRecord,
  IdentifyLog,
  ItemKind,
  LocalSnapshot,
  MergeItem,
  MergeSession,
  MergeStage,
  SporePrint,
  StageRow
} from '@/types'
import { uid } from '@/utils/id'

/** 当前导出采集包的格式版本（旧版本包缺少新字段时走兼容读写） */
export const PACKAGE_KIND = 'gbfungiguide-collection-package'
export const CURRENT_PACKAGE_VERSION = 1

const today = (): string => new Date().toISOString().slice(0, 10)

/* ------------------------------------------------------------------ */
/* 内容指纹：同包重复导入可识别                                         */
/* ------------------------------------------------------------------ */

/** FNV-1a 32 位内容指纹（采集包一致性校验） */
export function hashContent(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/* ------------------------------------------------------------------ */
/* 兼容读写：字段默认值与中文名                                         */
/* ------------------------------------------------------------------ */

interface FieldSpec {
  label: string
  fallback: unknown
}

/** 各模型当前字段及缺省值；旧版本采集包缺少新字段时据此补齐 */
const FIELD_SPECS: Record<MergeStage, Record<string, FieldSpec>> = {
  points: {
    id: { label: 'ID', fallback: '' },
    name: { label: '地点名', fallback: '' },
    longitude: { label: '经度', fallback: 0 },
    latitude: { label: '纬度', fallback: 0 },
    altitude: { label: '海拔(m)', fallback: 0 },
    vegetation: { label: '植被类型', fallback: '针阔混交林' },
    substrate: { label: '基物', fallback: '落叶层' },
    companionTrees: { label: '伴生树种', fallback: '' },
    collectDate: { label: '日期', fallback: '' },
    collector: { label: '采集人', fallback: '' }
  },
  records: {
    id: { label: 'ID', fallback: '' },
    code: { label: '采集编号', fallback: '' },
    tempName: { label: '暂定名', fallback: '' },
    fruitBodyCount: { label: '子实体数量', fallback: 1 },
    pointId: { label: '采集点ID', fallback: '' },
    capDiameter: { label: '菌盖直径(cm)', fallback: 0 },
    capShape: { label: '菌盖形状', fallback: '平展' },
    capMargin: { label: '菌盖边缘', fallback: '全缘' },
    capTexture: { label: '表面质地', fallback: '光滑' },
    fleshThickness: { label: '菌肉厚度(cm)', fallback: 0 },
    fleshReaction: { label: '菌肉变色反应', fallback: '不变色' },
    attachment: { label: '着生方式', fallback: '直生' },
    gillDensity: { label: '菌褶密度', fallback: '中等' },
    stipeLength: { label: '菌柄长度(cm)', fallback: 0 },
    stipeDiameter: { label: '菌柄直径(cm)', fallback: 0 },
    ring: { label: '菌环', fallback: '无菌环' },
    volva: { label: '菌托', fallback: '无菌托' },
    odor: { label: '气味', fallback: '' },
    hostTree: { label: '关联树种', fallback: '' },
    collectDate: { label: '采集日期', fallback: '' },
    collector: { label: '采集人', fallback: '' },
    note: { label: '备注', fallback: '' }
  },
  spores: {
    id: { label: 'ID', fallback: '' },
    recordId: { label: '菌物条目ID', fallback: '' },
    color: { label: '印色', fallback: '白色' },
    shape: { label: '印形', fallback: '' },
    hours: { label: '获取时长(h)', fallback: 0 },
    observeDate: { label: '观察日期', fallback: '' },
    moisture: { label: '样本干湿度', fallback: '' }
  },
  identifies: {
    id: { label: 'ID', fallback: '' },
    recordId: { label: '菌物条目ID', fallback: '' },
    conclusion: { label: '结论学名', fallback: '' },
    basis: { label: '依据', fallback: '形态特征' },
    referenceBook: { label: '参考图鉴', fallback: '' },
    referencePage: { label: '页码', fallback: '' },
    confidence: { label: '置信度', fallback: '中' },
    needReview: { label: '是否待复核', fallback: true },
    reviewer: { label: '复核人', fallback: '' },
    date: { label: '日期', fallback: '' }
  }
}

/** 对比时不参与内容差异判断的字段（自然键与外键在解析时单独处理） */
const NON_DIFF_KEYS: Record<MergeStage, string[]> = {
  points: ['id'],
  records: ['id', 'pointId'],
  spores: ['id', 'recordId'],
  identifies: ['id', 'recordId']
}

/* ------------------------------------------------------------------ */
/* 逐行归一化：旧包补字段、非法值报错、多余字段忽略                      */
/* ------------------------------------------------------------------ */

interface NormalizeResult<T> {
  row: T | null
  errors: string[]
  warnings: string[]
  /** 因采集包缺字段而走兼容默认值补齐的字段（差异比对时忽略，不把旧包当冲突） */
  patchedKeys: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rawText(raw: Record<string, unknown>, key: string): { missing: boolean; value: unknown } {
  return { missing: !Object.prototype.hasOwnProperty.call(raw, key), value: raw[key] }
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function textField(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  fallback: string,
  errors: string[],
  warnings: string[],
  patchedKeys: string[],
  required = false
): string {
  const { missing, value } = rawText(raw, key)
  const text = asText(value)
  if (missing) {
    if (required) {
      errors.push(`缺少必填字段「${label}」`)
      return ''
    }
    patchedKeys.push(key)
    warnings.push(`缺少字段「${label}」，已按兼容默认值补齐`)
    return fallback
  }
  if (required && !text) {
    errors.push(`字段「${label}」不能为空`)
    return ''
  }
  return text
}

function numberField(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  fallback: number,
  errors: string[],
  warnings: string[],
  patchedKeys: string[]
): number {
  const { missing, value } = rawText(raw, key)
  if (missing || value === null || value === '') {
    patchedKeys.push(key)
    warnings.push(`缺少字段「${label}」，已按兼容默认值 ${fallback} 补齐`)
    return fallback
  }
  const n = asNumber(value)
  if (n === null) {
    errors.push(`字段「${label}」不是合法数字`)
    return fallback
  }
  return n
}

function enumField<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  allowed: readonly T[],
  fallback: T,
  errors: string[],
  warnings: string[],
  patchedKeys: string[]
): T {
  const { missing, value } = rawText(raw, key)
  if (missing) {
    patchedKeys.push(key)
    warnings.push(`缺少字段「${label}」，已按兼容默认值「${fallback}」补齐`)
    return fallback
  }
  const text = asText(value)
  if (!text) {
    patchedKeys.push(key)
    warnings.push(`字段「${label}」为空，已按兼容默认值「${fallback}」补齐`)
    return fallback
  }
  if (!(allowed as readonly string[]).includes(text)) {
    errors.push(`字段「${label}」取值「${text}」不在允许范围（${allowed.join(' / ')}）`)
    return fallback
  }
  return text as T
}

function boolField(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  fallback: boolean,
  errors: string[],
  warnings: string[],
  patchedKeys: string[]
): boolean {
  const { missing, value } = rawText(raw, key)
  if (missing) {
    patchedKeys.push(key)
    warnings.push(`缺少字段「${label}」，已按兼容默认值${fallback ? '（是）' : '（否）'}补齐`)
    return fallback
  }
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 1 || value === '1') return true
  if (value === 'false' || value === 0 || value === '0') return false
  errors.push(`字段「${label}」必须是布尔值`)
  return fallback
}

function dateField(
  raw: Record<string, unknown>,
  key: string,
  label: string,
  errors: string[],
  warnings: string[],
  patchedKeys: string[]
): string {
  const { missing, value } = rawText(raw, key)
  const text = asText(value)
  if (missing || !text) {
    patchedKeys.push(key)
    warnings.push(`缺少字段「${label}」，已按当天日期补齐`)
    return today()
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) {
    errors.push(`字段「${label}」日期格式应为 YYYY-MM-DD`)
    return text
  }
  return text.slice(0, 10)
}

/** 记录采集包里多出的、当前结构无法识别的字段（忽略，不阻断导入） */
function collectIgnored(raw: Record<string, unknown>, stage: MergeStage, warnings: string[]): void {
  const known = new Set(Object.keys(FIELD_SPECS[stage]))
  const extra = Object.keys(raw).filter((key) => !known.has(key))
  if (extra.length > 0) {
    warnings.push(`存在当前版本无法识别的字段（${extra.join('、')}），已忽略`)
  }
}

function normalizePoint(rawRow: unknown): NormalizeResult<CollectPoint> {
  const errors: string[] = []
  const warnings: string[] = []
  const patchedKeys: string[] = []
  if (!isObject(rawRow)) return { row: null, errors: ['不是合法对象'], warnings, patchedKeys }
  collectIgnored(rawRow, 'points', warnings)
  const id = textField(rawRow, 'id', 'ID', '', errors, warnings, patchedKeys, true)
  const row: CollectPoint = {
    id,
    name: textField(rawRow, 'name', '地点名', '', errors, warnings, patchedKeys, true),
    longitude: numberField(rawRow, 'longitude', '经度', 0, errors, warnings, patchedKeys),
    latitude: numberField(rawRow, 'latitude', '纬度', 0, errors, warnings, patchedKeys),
    altitude: numberField(rawRow, 'altitude', '海拔', 0, errors, warnings, patchedKeys),
    vegetation: enumField(rawRow, 'vegetation', '植被类型', VEGETATIONS, '针阔混交林', errors, warnings, patchedKeys),
    substrate: enumField(rawRow, 'substrate', '基物', SUBSTRATES, '落叶层', errors, warnings, patchedKeys),
    companionTrees: textField(rawRow, 'companionTrees', '伴生树种', '', errors, warnings, patchedKeys),
    collectDate: dateField(rawRow, 'collectDate', '日期', errors, warnings, patchedKeys),
    collector: textField(rawRow, 'collector', '采集人', '', errors, warnings, patchedKeys)
  }
  if (row.longitude < -180 || row.longitude > 180) errors.push('经度必须在 -180 ~ 180 之间')
  if (row.latitude < -90 || row.latitude > 90) errors.push('纬度必须在 -90 ~ 90 之间')
  if (row.longitude === 0 && row.latitude === 0) errors.push('经纬度不能同时为 0')
  return { row, errors, warnings, patchedKeys }
}

function normalizeRecord(rawRow: unknown): NormalizeResult<FungusRecord> {
  const errors: string[] = []
  const warnings: string[] = []
  const patchedKeys: string[] = []
  if (!isObject(rawRow)) return { row: null, errors: ['不是合法对象'], warnings, patchedKeys }
  collectIgnored(rawRow, 'records', warnings)
  const row: FungusRecord = {
    id: textField(rawRow, 'id', 'ID', '', errors, warnings, patchedKeys, true),
    code: textField(rawRow, 'code', '采集编号', '', errors, warnings, patchedKeys, true),
    tempName: textField(rawRow, 'tempName', '暂定名', '', errors, warnings, patchedKeys),
    fruitBodyCount: numberField(rawRow, 'fruitBodyCount', '子实体数量', 1, errors, warnings, patchedKeys),
    pointId: textField(rawRow, 'pointId', '采集点ID', '', errors, warnings, patchedKeys, true),
    capDiameter: numberField(rawRow, 'capDiameter', '菌盖直径', 0, errors, warnings, patchedKeys),
    capShape: enumField(rawRow, 'capShape', '菌盖形状', CAP_SHAPES, '平展', errors, warnings, patchedKeys),
    capMargin: enumField(rawRow, 'capMargin', '菌盖边缘', CAP_MARGINS, '全缘', errors, warnings, patchedKeys),
    capTexture: enumField(rawRow, 'capTexture', '表面质地', CAP_TEXTURES, '光滑', errors, warnings, patchedKeys),
    fleshThickness: numberField(rawRow, 'fleshThickness', '菌肉厚度', 0, errors, warnings, patchedKeys),
    // 旧版本采集包（v1 结构）缺少「菌肉变色反应」，走兼容默认值
    fleshReaction: enumField(rawRow, 'fleshReaction', '菌肉变色反应', FLESH_REACTIONS, '不变色', errors, warnings, patchedKeys),
    attachment: enumField(rawRow, 'attachment', '着生方式', GILL_ATTACHMENTS, '直生', errors, warnings, patchedKeys),
    gillDensity: enumField(rawRow, 'gillDensity', '菌褶密度', GILL_DENSITIES, '中等', errors, warnings, patchedKeys),
    stipeLength: numberField(rawRow, 'stipeLength', '菌柄长度', 0, errors, warnings, patchedKeys),
    stipeDiameter: numberField(rawRow, 'stipeDiameter', '菌柄直径', 0, errors, warnings, patchedKeys),
    ring: enumField(rawRow, 'ring', '菌环', RING_TYPES, '无菌环', errors, warnings, patchedKeys),
    volva: enumField(rawRow, 'volva', '菌托', VOLVA_TYPES, '无菌托', errors, warnings, patchedKeys),
    odor: textField(rawRow, 'odor', '气味', '', errors, warnings, patchedKeys),
    hostTree: textField(rawRow, 'hostTree', '关联树种', '', errors, warnings, patchedKeys),
    collectDate: dateField(rawRow, 'collectDate', '采集日期', errors, warnings, patchedKeys),
    collector: textField(rawRow, 'collector', '采集人', '', errors, warnings, patchedKeys),
    note: textField(rawRow, 'note', '备注', '', errors, warnings, patchedKeys)
  }
  return { row, errors, warnings, patchedKeys }
}

function normalizeSpore(rawRow: unknown): NormalizeResult<SporePrint> {
  const errors: string[] = []
  const warnings: string[] = []
  const patchedKeys: string[] = []
  if (!isObject(rawRow)) return { row: null, errors: ['不是合法对象'], warnings, patchedKeys }
  collectIgnored(rawRow, 'spores', warnings)
  const row: SporePrint = {
    id: textField(rawRow, 'id', 'ID', '', errors, warnings, patchedKeys, true),
    recordId: textField(rawRow, 'recordId', '菌物条目ID', '', errors, warnings, patchedKeys, true),
    color: enumField(rawRow, 'color', '印色', SPORE_COLORS, '白色', errors, warnings, patchedKeys),
    shape: textField(rawRow, 'shape', '印形', '', errors, warnings, patchedKeys),
    hours: numberField(rawRow, 'hours', '获取时长', 0, errors, warnings, patchedKeys),
    observeDate: dateField(rawRow, 'observeDate', '观察日期', errors, warnings, patchedKeys),
    moisture: textField(rawRow, 'moisture', '样本干湿度', '', errors, warnings, patchedKeys)
  }
  return { row, errors, warnings, patchedKeys }
}

function normalizeIdentify(rawRow: unknown): NormalizeResult<IdentifyLog> {
  const errors: string[] = []
  const warnings: string[] = []
  const patchedKeys: string[] = []
  if (!isObject(rawRow)) return { row: null, errors: ['不是合法对象'], warnings, patchedKeys }
  collectIgnored(rawRow, 'identifies', warnings)
  const row: IdentifyLog = {
    id: textField(rawRow, 'id', 'ID', '', errors, warnings, patchedKeys, true),
    recordId: textField(rawRow, 'recordId', '菌物条目ID', '', errors, warnings, patchedKeys, true),
    conclusion: textField(rawRow, 'conclusion', '结论学名', '', errors, warnings, patchedKeys, true),
    basis: enumField(rawRow, 'basis', '依据', ID_BASES, '形态特征', errors, warnings, patchedKeys),
    referenceBook: textField(rawRow, 'referenceBook', '参考图鉴', '', errors, warnings, patchedKeys),
    referencePage: textField(rawRow, 'referencePage', '页码', '', errors, warnings, patchedKeys),
    confidence: enumField(rawRow, 'confidence', '置信度', ID_CONFIDENCES, '中', errors, warnings, patchedKeys),
    needReview: boolField(rawRow, 'needReview', '是否待复核', true, errors, warnings, patchedKeys),
    reviewer: textField(rawRow, 'reviewer', '复核人', '', errors, warnings, patchedKeys),
    date: dateField(rawRow, 'date', '日期', errors, warnings, patchedKeys)
  }
  return { row, errors, warnings, patchedKeys }
}

const NORMALIZERS = {
  points: normalizePoint,
  records: normalizeRecord,
  spores: normalizeSpore,
  identifies: normalizeIdentify
} as const

/* ------------------------------------------------------------------ */
/* 采集包解析与校验                                                    */
/* ------------------------------------------------------------------ */

export interface ParsedPackage {
  pkg: CollectionPackage
  warnings: string[]
  hash: string
}

/** 校验并解析采集包；结构不合法直接抛错，不允许进入暂存 */
export function parsePackage(text: string): ParsedPackage {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('采集包不是合法 JSON 文件')
  }
  if (!isObject(data)) throw new Error('采集包结构应为 JSON 对象')

  const kind = asText((data as Record<string, unknown>).kind)
  if (!kind) throw new Error('缺少采集包标识（kind），请确认文件由野外分组导出')
  if (kind !== PACKAGE_KIND) throw new Error(`采集包标识不匹配：${kind}`)

  const raw = data as Record<string, unknown>
  const version = asNumber(raw.packageVersion)
  const warnings: string[] = []
  if (version === null) {
    warnings.push('采集包未标注格式版本，已按最旧版本兼容读取（缺失字段走默认值）')
  } else if (version < CURRENT_PACKAGE_VERSION) {
    warnings.push(`采集包为旧版本 v${version}（当前 v${CURRENT_PACKAGE_VERSION}），缺失字段已按兼容默认值补齐`)
  } else if (version > CURRENT_PACKAGE_VERSION) {
    warnings.push(`采集包版本 v${version} 高于当前支持的 v${CURRENT_PACKAGE_VERSION}，无法识别的字段将被忽略`)
  }

  const asArray = (value: unknown, key: string): unknown[] => {
    if (value === undefined || value === null) {
      warnings.push(`采集包缺少「${key}」分区，已按空集合处理`)
      return []
    }
    if (!Array.isArray(value)) throw new Error(`采集包分区「${key}」应为数组`)
    return value
  }

  const pkg: CollectionPackage = {
    kind,
    packageVersion: version ?? 0,
    exportedAt: asText(raw.exportedAt) || '未知',
    group: asText(raw.group) || '未命名分组',
    points: asArray(raw.points, 'points'),
    records: asArray(raw.records, 'records'),
    spores: asArray(raw.spores, 'spores'),
    identifies: asArray(raw.identifies, 'identifies')
  }

  return { pkg, warnings: dedupe(warnings), hash: hashContent(text) }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list))
}

/* ------------------------------------------------------------------ */
/* 暂存计划：逐阶段匹配、保留两边版本、外键重映射                       */
/* ------------------------------------------------------------------ */

function fieldLabel(stage: MergeStage, key: string): string {
  return FIELD_SPECS[stage][key]?.label ?? key
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value)
}

function buildDiffs(stage: MergeStage, local: StageRow, incoming: StageRow, patchedKeys: string[] = []): FieldDiff[] {
  const diffs: FieldDiff[] = []
  const skip = new Set([...NON_DIFF_KEYS[stage], ...patchedKeys])
  for (const key of Object.keys(FIELD_SPECS[stage])) {
    if (skip.has(key)) continue
    const localValue = (local as unknown as Record<string, unknown>)[key]
    const incomingValue = (incoming as unknown as Record<string, unknown>)[key]
    if (JSON.stringify(localValue ?? null) !== JSON.stringify(incomingValue ?? null)) {
      diffs.push({
        key,
        label: fieldLabel(stage, key),
        local: formatValue(localValue),
        incoming: formatValue(incomingValue)
      })
    }
  }
  return diffs
}

/** 组装一条暂存项（错误/新增/冲突/一致） */
function makeItem(
  stage: MergeStage,
  ordinal: number,
  naturalKey: string,
  kind: ItemKind,
  incoming: StageRow | Record<string, unknown>,
  resolved: StageRow | null,
  local: StageRow | undefined,
  errors: string[],
  warnings: string[],
  diffs: FieldDiff[]
): MergeItem {
  return {
    itemKey: `${stage}#${ordinal}`,
    stage,
    naturalKey,
    kind,
    // 内容一致自动跳过；校验失败项直接排除（不能勾选、不计入待确认）
    state: kind === 'identical' || kind === 'error' ? 'skipped' : 'pending',
    errors: dedupe(errors),
    warnings: dedupe(warnings),
    diffs,
    incoming,
    local,
    resolved
  }
}

export interface BuildPlan {
  items: MergeItem[]
}

/**
 * 按「采集点 → 菌物条目 → 孢子印 → 鉴定结论」顺序构建暂存计划。
 * 同一自然键内容不同时保留两边版本（外部版本换新 id，菌物条目保留原采集编号）。
 */
export function buildMergePlan(pkg: CollectionPackage, local: LocalSnapshot): BuildPlan {
  const items: MergeItem[] = []

  /* ---- 采集点：自然键 id ---- */
  const pointIdMap = new Map<string, string>() // 外部 id → 写入 id
  const seenPointKeys = new Set<string>()
  const localPointIds = new Set(local.points.map((p) => p.id))
  pkg.points.forEach((rawRow, index) => {
    const { row, errors, warnings, patchedKeys } = NORMALIZERS.points(rawRow)
    const ordinal = index + 1
    if (!row) {
      items.push(makeItem('points', ordinal, '（非法行）', 'error', isObject(rawRow) ? rawRow : {}, null, undefined, errors, warnings, []))
      return
    }
    const localPoint = local.points.find((p) => p.id === row.id)
    if (seenPointKeys.has(row.id)) errors.push(`采集包内采集点 id「${row.id}」重复`)
    seenPointKeys.add(row.id)

    let kind: ItemKind = 'new'
    let resolved: CollectPoint = { ...row }
    let diffs: FieldDiff[] = []
    if (errors.length > 0) {
      kind = 'error'
    } else if (localPoint) {
      diffs = buildDiffs('points', localPoint, row, patchedKeys)
      if (diffs.length === 0) {
        kind = 'identical'
        pointIdMap.set(row.id, localPoint.id)
      } else {
        kind = 'conflict'
        const freshId = uid('pt')
        pointIdMap.set(row.id, freshId)
        resolved = { ...row, id: freshId }
      }
    } else {
      // 极端兜底：编号不同但 id 撞本地（跨设备同随机 id），同样保留两边
      if (localPointIds.has(row.id)) resolved = { ...row, id: uid('pt') }
      pointIdMap.set(row.id, resolved.id)
    }
    items.push(makeItem('points', ordinal, row.id, kind, row, resolved, localPoint, errors, warnings, diffs))
  })

  /* ---- 菌物条目：自然键采集编号 code ---- */
  const recordIdMap = new Map<string, string>() // 外部 id → 写入 id
  const seenCodes = new Set<string>()
  const localRecordIds = new Set(local.records.map((r) => r.id))
  const localByCode = new Map(local.records.map((r) => [r.code, r]))
  pkg.records.forEach((rawRow, index) => {
    const { row, errors, warnings, patchedKeys } = NORMALIZERS.records(rawRow)
    const ordinal = index + 1
    if (!row) {
      items.push(makeItem('records', ordinal, '（非法行）', 'error', isObject(rawRow) ? rawRow : {}, null, undefined, errors, warnings, []))
      return
    }
    const localRecord = localByCode.get(row.code)
    if (seenCodes.has(row.code)) errors.push(`采集包内采集编号「${row.code}」重复`)
    seenCodes.add(row.code)

    // 外键：解析到采集点写入 id
    const targetPointId = pointIdMap.get(row.pointId) ?? (localPointIds.has(row.pointId) ? row.pointId : undefined)
    if (!targetPointId) errors.push(`引用的采集点「${row.pointId}」在采集包与本地图谱中均不存在`)

    let kind: ItemKind = 'new'
    let resolved: FungusRecord | null = { ...row, pointId: targetPointId ?? row.pointId }
    let diffs: FieldDiff[] = []
    if (errors.length > 0) {
      kind = 'error'
      resolved = null
    } else if (localRecord) {
      diffs = buildDiffs('records', localRecord, row, patchedKeys)
      if (diffs.length === 0) {
        kind = 'identical'
        recordIdMap.set(row.id, localRecord.id)
        resolved = null
      } else {
        kind = 'conflict'
        const freshId = uid('rec')
        recordIdMap.set(row.id, freshId)
        // 保留同一采集编号，两边版本并存
        resolved = { ...row, id: freshId, code: row.code, pointId: targetPointId as string }
      }
    } else {
      if (localRecordIds.has(row.id)) resolved = { ...resolved!, id: uid('rec') }
      recordIdMap.set(row.id, resolved.id)
    }
    items.push(makeItem('records', ordinal, row.code, kind, row, resolved, localRecord, errors, warnings, diffs))
  })

  /* ---- 孢子印：自然键 id，按 recordId 归属 ---- */
  const seenSporeIds = new Set<string>()
  const localSporeIds = new Set(local.spores.map((s) => s.id))
  pkg.spores.forEach((rawRow, index) => {
    const { row, errors, warnings, patchedKeys } = NORMALIZERS.spores(rawRow)
    const ordinal = index + 1
    if (!row) {
      items.push(makeItem('spores', ordinal, '（非法行）', 'error', isObject(rawRow) ? rawRow : {}, null, undefined, errors, warnings, []))
      return
    }
    const localSpore = local.spores.find((s) => s.id === row.id)
    if (seenSporeIds.has(row.id)) errors.push(`采集包内孢子印 id「${row.id}」重复`)
    seenSporeIds.add(row.id)

    const targetRecordId = resolveRecordId(row.recordId, recordIdMap, localRecordIds)
    if (!targetRecordId) errors.push(`归属菌物条目「${row.recordId}」不存在，无法挂接孢子印`)

    let kind: ItemKind = 'new'
    let resolved: SporePrint | null = { ...row, recordId: targetRecordId ?? row.recordId }
    let diffs: FieldDiff[] = []
    if (errors.length > 0) {
      kind = 'error'
      resolved = null
    } else if (localSpore) {
      diffs = buildDiffs('spores', localSpore, row, patchedKeys)
      if (diffs.length === 0) {
        kind = 'identical'
        resolved = null
      } else {
        kind = 'conflict'
        resolved = { ...row, id: uid('spo'), recordId: targetRecordId as string }
      }
    } else {
      if (localSporeIds.has(row.id)) resolved = { ...resolved!, id: uid('spo') }
    }
    items.push(makeItem('spores', ordinal, row.id, kind, row, resolved, localSpore, errors, warnings, diffs))
  })

  /* ---- 鉴定结论：自然键 id，按 recordId 归属 ---- */
  const seenLogIds = new Set<string>()
  const localLogIds = new Set(local.identifies.map((l) => l.id))
  pkg.identifies.forEach((rawRow, index) => {
    const { row, errors, warnings, patchedKeys } = NORMALIZERS.identifies(rawRow)
    const ordinal = index + 1
    if (!row) {
      items.push(makeItem('identifies', ordinal, '（非法行）', 'error', isObject(rawRow) ? rawRow : {}, null, undefined, errors, warnings, []))
      return
    }
    const localLog = local.identifies.find((l) => l.id === row.id)
    if (seenLogIds.has(row.id)) errors.push(`采集包内鉴定结论 id「${row.id}」重复`)
    seenLogIds.add(row.id)

    const targetRecordId = resolveRecordId(row.recordId, recordIdMap, localRecordIds)
    if (!targetRecordId) errors.push(`归属菌物条目「${row.recordId}」不存在，无法挂接鉴定结论`)

    let kind: ItemKind = 'new'
    let resolved: IdentifyLog | null = { ...row, recordId: targetRecordId ?? row.recordId }
    let diffs: FieldDiff[] = []
    if (errors.length > 0) {
      kind = 'error'
      resolved = null
    } else if (localLog) {
      diffs = buildDiffs('identifies', localLog, row, patchedKeys)
      if (diffs.length === 0) {
        kind = 'identical'
        resolved = null
      } else {
        kind = 'conflict'
        resolved = { ...row, id: uid('idf'), recordId: targetRecordId as string }
      }
    } else {
      if (localLogIds.has(row.id)) resolved = { ...resolved!, id: uid('idf') }
    }
    items.push(makeItem('identifies', ordinal, row.id, kind, row, resolved, localLog, errors, warnings, diffs))
  })

  return { items }
}

/** 孢子印/鉴定结论的归属条目解析：优先映射到本包新写入 id，其次本地已有 id */
function resolveRecordId(
  externalRecordId: string,
  recordIdMap: Map<string, string>,
  localRecordIds: Set<string>
): string | undefined {
  const mapped = recordIdMap.get(externalRecordId)
  if (mapped) return mapped
  return localRecordIds.has(externalRecordId) ? externalRecordId : undefined
}

/* ------------------------------------------------------------------ */
/* 会话与检查点                                                        */
/* ------------------------------------------------------------------ */

/** 新建暂存会话（尚未确认任何条目） */
export function createSession(fileName: string, parsed: ParsedPackage, items: MergeItem[]): MergeSession {
  const now = new Date().toISOString()
  return {
    id: uid('mrg'),
    status: 'staged',
    fileName,
    packageHash: parsed.hash,
    group: parsed.pkg.group,
    exportedAt: parsed.pkg.exportedAt,
    packageWarnings: parsed.warnings,
    items,
    checkpoint: { lastItemKey: null, writtenCount: 0, updatedAt: now },
    createdAt: now,
    updatedAt: now
  }
}

export interface StageTables {
  points: Table<CollectPoint, string>
  records: Table<FungusRecord, string>
  spores: Table<SporePrint, string>
  identifies: Table<IdentifyLog, string>
}

/**
 * 按阶段顺序写入所有已确认条目。
 * 每条写入成功后立刻推进检查点；中断后重放会跳过 written，不重复写入。
 */
export async function applyConfirmedItems(session: MergeSession, tables: StageTables): Promise<ApplyResult> {
  const writers: Record<MergeStage, (row: StageRow) => Promise<void>> = {
    points: async (row) => {
      await tables.points.put(row as CollectPoint)
    },
    records: async (row) => {
      await tables.records.put(row as FungusRecord)
    },
    spores: async (row) => {
      await tables.spores.put(row as SporePrint)
    },
    identifies: async (row) => {
      await tables.identifies.put(row as IdentifyLog)
    }
  }

  session.status = 'writing'
  let written = 0
  let failed: MergeItem | null = null

  for (const item of session.items) {
    if (item.state === 'written' || item.state === 'skipped') continue
    // confirmed：本次勾选确认；failed：上次已确认但写入中断，恢复时继续该项（不重复写入）
    if (item.state !== 'confirmed' && item.state !== 'failed') continue
    if (item.kind === 'error' || !item.resolved) {
      item.state = 'failed'
      item.failReason = '条目校验未通过，不能写入正式数据'
      failed = item
      break
    }
    try {
      await writers[item.stage](item.resolved)
      item.state = 'written'
      item.failReason = undefined
      written += 1
      session.checkpoint.lastItemKey = item.itemKey
      session.checkpoint.writtenCount += 1
      session.checkpoint.updatedAt = new Date().toISOString()
    } catch (cause) {
      item.state = 'failed'
      item.failReason = cause instanceof Error ? cause.message : String(cause)
      failed = item
      break
    }
  }

  const remaining = session.items.filter(
    (item) => item.state === 'confirmed' || item.state === 'pending'
  ).length
  session.checkpoint.lastError = failed?.failReason
  session.updatedAt = new Date().toISOString()
  session.status = failed ? 'failed' : remaining > 0 ? 'partial' : 'done'
  return { written, failed, remaining }
}

/* ------------------------------------------------------------------ */
/* 采集包导出（野外分组离线记录后导出）                                 */
/* ------------------------------------------------------------------ */

/** 把本地图谱导出为采集包 */
export function exportPackage(snapshot: LocalSnapshot, group: string): CollectionPackage {
  return {
    kind: PACKAGE_KIND,
    packageVersion: CURRENT_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    group: group.trim() || '未命名分组',
    points: snapshot.points,
    records: snapshot.records,
    spores: snapshot.spores,
    identifies: snapshot.identifies
  }
}

/** 组装一份缺少新字段的旧版本采集包（兼容读写演示/测试用） */
export function buildLegacyPackage(snapshot: LocalSnapshot, group: string): Record<string, unknown> {
  return {
    kind: PACKAGE_KIND,
    // 旧版本：故意不写 packageVersion、不带 fleshReaction 与 needReview
    exportedAt: new Date().toISOString(),
    group: group.trim() || '旧版分组',
    points: snapshot.points.map(({ id, name, longitude, latitude, altitude, vegetation, substrate, companionTrees, collectDate, collector }) => ({
      id, name, longitude, latitude, altitude, vegetation, substrate, companionTrees, collectDate, collector
    })),
    records: snapshot.records.map((row) => {
      const { fleshReaction: _flesh, ...rest } = row
      return rest
    }),
    spores: snapshot.spores,
    identifies: snapshot.identifies.map((row) => {
      const { needReview: _need, ...rest } = row
      return rest
    })
  }
}

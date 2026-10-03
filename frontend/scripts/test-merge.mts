import assert from 'node:assert/strict'
import {
  applyConfirmedItems,
  buildLegacyPackage,
  buildMergePlan,
  createSession,
  exportPackage,
  hashContent,
  parsePackage
} from '../src/utils/merge.ts'
import type { CollectionPackage, CollectPoint, FungusRecord, IdentifyLog, LocalSnapshot, MergeItem, SporePrint } from '../src/types/index.ts'

function makeSnapshot(): LocalSnapshot {
  const point: CollectPoint = {
    id: 'pt_local',
    name: '本地山样线',
    longitude: 110.1,
    latitude: 30.1,
    altitude: 500,
    vegetation: '针叶林',
    substrate: '土壤',
    companionTrees: '马尾松',
    collectDate: '2026-09-01',
    collector: '甲组'
  }
  const record: FungusRecord = {
    id: 'rec_local',
    code: 'BHS-2026-001',
    tempName: '本地牛肝菌',
    fruitBodyCount: 2,
    pointId: 'pt_local',
    capDiameter: 8,
    capShape: '半球形',
    capMargin: '全缘',
    capTexture: '光滑',
    fleshThickness: 1.5,
    fleshReaction: '迅速变蓝',
    attachment: '直生',
    gillDensity: '中等',
    stipeLength: 7,
    stipeDiameter: 2,
    ring: '无菌环',
    volva: '无菌托',
    odor: '无',
    hostTree: '马尾松',
    collectDate: '2026-09-01',
    collector: '甲组',
    note: ''
  }
  const spore: SporePrint = {
    id: 'spo_local',
    recordId: 'rec_local',
    color: '淡黄',
    shape: '圆形',
    hours: 10,
    observeDate: '2026-09-02',
    moisture: '干燥'
  }
  const log: IdentifyLog = {
    id: 'idf_local',
    recordId: 'rec_local',
    conclusion: 'Boletus localis',
    basis: '形态特征',
    referenceBook: '本地图鉴',
    referencePage: 'P.1',
    confidence: '中',
    needReview: false,
    reviewer: '甲',
    date: '2026-09-03'
  }
  return { points: [point], records: [record], spores: [spore], identifies: [log] }
}

function find(items: MergeItem[], stage: string, key: string): MergeItem {
  const item = items.find((candidate) => candidate.stage === stage && candidate.naturalKey === key)
  assert.ok(item, `${stage}/${key} 应存在`)
  return item
}

/* ---------- 1. 解析与校验 ---------- */
assert.equal(hashContent('a').length, 8, '指纹应为 8 位十六进制')
assert.throws(() => parsePackage('{bad json'), /合法 JSON/, '非法 JSON 应报错')
assert.throws(() => parsePackage(JSON.stringify({ foo: 1 })), /缺少采集包标识/, '缺 kind 应报错')
assert.throws(
  () => parsePackage(JSON.stringify({ kind: 'wrong', points: [] })),
  /标识不匹配/,
  'kind 不匹配应报错'
)

const valid: CollectionPackage = {
  kind: 'gbfungiguide-collection-package',
  packageVersion: 1,
  exportedAt: '2026-10-01T00:00:00.000Z',
  group: '乙组',
  points: [],
  records: [],
  spores: [],
  identifies: []
}
const parsed = parsePackage(JSON.stringify(valid))
assert.equal(parsed.pkg.group, '乙组')
assert.equal(parsed.warnings.length, 0, '当前版本包不应有兼容警告')

/* ---------- 2. 暂存：新增 / 一致 / 冲突保留两边 / 引用错误 ---------- */
const local = makeSnapshot()
const incomingPoint: CollectPoint = { ...local.points[0], name: '本地山样线-改名', longitude: 110.2 }
const newPoint: CollectPoint = {
  id: 'pt_new',
  name: '新样线',
  longitude: 120,
  latitude: 40,
  altitude: 800,
  vegetation: '灌丛',
  substrate: '腐木',
  companionTrees: '',
  collectDate: '2026-10-01',
  collector: '乙组'
}
// 同采集编号、内容不同的菌物条目
const incomingRecord: FungusRecord = {
  ...local.records[0],
  tempName: '乙组修订牛肝菌',
  pointId: 'pt_local',
  fleshReaction: '变红'
}
const newRecord: FungusRecord = {
  id: 'rec_new',
  code: 'BHS-2026-009',
  tempName: '乙组新种',
  fruitBodyCount: 1,
  pointId: 'pt_new',
  capDiameter: 3,
  capShape: '钟形',
  capMargin: '波状',
  capTexture: '粘滑',
  fleshThickness: 0.5,
  fleshReaction: '不变色',
  attachment: '离生',
  gillDensity: '密集',
  stipeLength: 5,
  stipeDiameter: 0.6,
  ring: '易脱落',
  volva: '杯状菌托',
  odor: '菌香',
  hostTree: '栎',
  collectDate: '2026-10-01',
  collector: '乙组',
  note: ''
}
const orphanSpore: SporePrint = {
  id: 'spo_orphan',
  recordId: 'rec_missing',
  color: '黑褐',
  shape: '',
  hours: 4,
  observeDate: '2026-10-01',
  moisture: ''
}
const newSpore: SporePrint = {
  id: 'spo_new',
  recordId: 'rec_new',
  color: '白色',
  shape: '规则',
  hours: 6,
  observeDate: '2026-10-02',
  moisture: '新鲜'
}
const newLog: IdentifyLog = {
  id: 'idf_new',
  recordId: 'rec_new',
  conclusion: 'Agaricus sp.',
  basis: '孢子印',
  referenceBook: '',
  referencePage: '',
  confidence: '高',
  needReview: true,
  reviewer: '',
  date: '2026-10-03'
}

const pkg: CollectionPackage = {
  ...valid,
  points: [incomingPoint, newPoint, { id: 'pt_bad', name: '坏点' }],
  records: [incomingRecord, newRecord, { id: 'rec_bad', code: 'BAD-1', pointId: 'pt_local' }],
  spores: [orphanSpore, newSpore],
  identifies: [local.identifies[0], newLog]
}
const { items } = buildMergePlan(pkg, local)

const pointConflict = find(items, 'points', 'pt_local')
assert.equal(pointConflict.kind, 'conflict', '同名 id 内容不同应为冲突')
assert.ok(pointConflict.diffs.some((d) => d.key === 'name'), '应给出 name 差异')
assert.ok(pointConflict.diffs.some((d) => d.key === 'longitude'), '应给出 longitude 差异')
assert.notEqual(pointConflict.resolved!.id, 'pt_local', '冲突外部采集点应换新 id')

const sameItem = items.find((i) => i.stage === 'identifies' && i.kind === 'identical')
assert.ok(sameItem, '应有内容一致自动跳过的鉴定结论')
assert.equal(sameItem!.state, 'skipped')

const pointNew = find(items, 'points', 'pt_new')
assert.equal(pointNew.kind, 'new')

const badPoint = find(items, 'points', 'pt_bad')
assert.equal(badPoint.kind, 'error')
assert.ok(badPoint.errors.some((e) => e.includes('经纬')), '缺经纬度（0,0）应报错')

const recordConflict = find(items, 'records', 'BHS-2026-001')
assert.equal(recordConflict.kind, 'conflict')
assert.equal((recordConflict.resolved as FungusRecord).code, 'BHS-2026-001', '冲突菌物条目保留原采集编号')
assert.notEqual(recordConflict.resolved!.id, 'rec_local', '冲突菌物条目换新 id')
assert.ok(recordConflict.diffs.some((d) => d.key === 'tempName'))
assert.ok(recordConflict.diffs.some((d) => d.key === 'fleshReaction'))

const recordNew = find(items, 'records', 'BHS-2026-009')
assert.equal(recordNew.kind, 'new')
assert.equal((recordNew.resolved as FungusRecord).pointId, 'pt_new', '新条目外键应映射到新采集点 id')

const badRecord = find(items, 'records', 'BAD-1')
assert.equal(badRecord.kind, 'new', '字段缺失但可兼容补齐时应视为可导入新增项')
assert.ok(badRecord.warnings.length > 0, '缺失字段应记录兼容补齐提示')

const orphan = find(items, 'spores', 'spo_orphan')
assert.equal(orphan.kind, 'error')
assert.ok(orphan.errors.some((e) => e.includes('归属菌物条目')), '悬挂外键应报错')

const sporeNew = find(items, 'spores', 'spo_new')
assert.equal(sporeNew.kind, 'new')
assert.equal((sporeNew.resolved as SporePrint).recordId, (recordNew.resolved as FungusRecord).id, '孢子印应挂接到映射后的新条目')

const logNew = find(items, 'identifies', 'idf_new')
assert.equal((logNew.resolved as IdentifyLog).recordId, (recordNew.resolved as FungusRecord).id)

// 顺序：采集点 → 菌物条目 → 孢子印 → 鉴定结论
const stages = items.map((i) => i.stage)
assert.deepEqual(
  [...new Set(stages)],
  ['points', 'records', 'spores', 'identifies'],
  '写入顺序必须为采集点→菌物条目→孢子印→鉴定结论'
)

/* ---------- 3. 旧版本兼容：缺 fleshReaction / needReview / packageVersion ---------- */
const legacy = buildLegacyPackage(local, '旧组')
const legacyText = JSON.stringify(legacy)
assert.ok(!legacyText.includes('fleshReaction'), '旧包应不含新字段 fleshReaction')
assert.ok(!legacyText.includes('needReview'), '旧包应不含 needReview')
const legacyParsed = parsePackage(legacyText)
assert.ok(legacyParsed.warnings.some((w) => w.includes('最旧版本')), '无版本号应提示兼容读取')
const legacyPlan = buildMergePlan(legacyParsed.pkg, makeSnapshot())
const legacyRecord = find(legacyPlan.items, 'records', 'BHS-2026-001')
assert.equal(legacyRecord.kind, 'identical', '补齐默认值后应与本地内容一致')
assert.ok(
  legacyRecord.warnings.some((w) => w.includes('菌肉变色反应')),
  '缺少新字段应在条目上记录兼容补齐提示'
)
const legacyLog = find(legacyPlan.items, 'identifies', 'idf_local')
assert.equal(legacyLog.kind, 'identical')
assert.ok(legacyLog.warnings.some((w) => w.includes('是否待复核')))

/* ---------- 4. 检查点写入：跳过未确认、不重复写入、可恢复 ---------- */
const memory = new Map<string, unknown>()
const tables = {
  points: { put: async (row: unknown) => { memory.set((row as CollectPoint).id, row) } },
  records: { put: async (row: unknown) => { memory.set((row as FungusRecord).id, row) } },
  spores: { put: async (row: unknown) => { memory.set((row as SporePrint).id, row) } },
  identifies: { put: async (row: unknown) => { memory.set((row as IdentifyLog).id, row) } }
}

const session = createSession('pkg.json', parsed, items)
// 仅确认新采集点与新条目；冲突项与错误项不确认
pointNew.state = 'confirmed'
recordNew.state = 'confirmed'
sporeNew.state = 'confirmed'
logNew.state = 'confirmed'
// 制造一次失败：第二次写入时让 records.put 抛错
let failOnce = true
const flakyTables = {
  ...tables,
  records: {
    put: async (row: unknown) => {
      if (failOnce && (row as FungusRecord).code === 'BHS-2026-009') {
        failOnce = false
        throw new Error('模拟磁盘错误')
      }
      memory.set((row as FungusRecord).id, row)
    }
  }
}

const first = await applyConfirmedItems(session, flakyTables as never)
assert.ok(first.failed, '首次应在记录处中断')
assert.equal(session.status, 'failed')
assert.equal(session.checkpoint.writtenCount, 1, '只有采集点写入成功')
assert.ok(memory.has('pt_new'))
assert.ok(!memory.has((recordNew.resolved as FungusRecord).id), '失败条目不应写入')

// 恢复：重放应跳过已写入的采集点（不重复），继续写余下
const second = await applyConfirmedItems(session, tables as never)
assert.equal(second.failed, null)
assert.equal(session.status, 'partial', '仍有未确认的冲突项，状态为部分写入')
assert.equal(session.checkpoint.writtenCount, 4, '检查点计数 1+3')
// remaining 统计仍处于 pending/confirmed 的项（含 2 个未确认冲突、1 个兼容补齐新增与校验失败点）
assert.ok(second.remaining === 3, '剩余 2 个未确认冲突 + 1 个未确认兼容补齐条目')
assert.ok(memory.has((recordNew.resolved as FungusRecord).id))
assert.ok(memory.has((sporeNew.resolved as SporePrint).id))
assert.ok(memory.has((logNew.resolved as IdentifyLog).id))
// 冲突与错误项绝不能进入正式数据
assert.ok(!memory.has('rec_local'), '本地 id 不应被覆盖')
assert.ok(!memory.has('spo_orphan'), '错误项不能写入')
assert.equal(
  memory.get((recordConflict.resolved as FungusRecord).id),
  undefined,
  '未确认的冲突项不能进入正式数据'
)

// 再确认冲突项后继续，冲突版本写入；未确认的兼容补齐条目仍保留
recordConflict.state = 'confirmed'
pointConflict.state = 'confirmed'
const third = await applyConfirmedItems(session, tables as never)
assert.equal(third.failed, null)
assert.equal(third.remaining, 1, '仍有 1 项未确认（BAD-1），不进入正式数据')
assert.equal(session.status, 'partial')
assert.ok(memory.has((recordConflict.resolved as FungusRecord).id), '冲突版本确认后应写入为并存版本')
// 最后确认剩余可导入条目，全部写完
const badRecordPending = items.find((i) => i.naturalKey === 'BAD-1')
assert.ok(badRecordPending)
badRecordPending!.state = 'confirmed'
const done = await applyConfirmedItems(session, tables as never)
assert.equal(done.failed, null)
assert.equal(done.remaining, 0, '校验失败项已排除不计，其余全部确认完成')
assert.equal(session.status, 'done')
// 重放幂等：done 后再跑不重复写入
const beforeCount = session.checkpoint.writtenCount
const fourth = await applyConfirmedItems(session, tables as never)
assert.equal(session.checkpoint.writtenCount, beforeCount, '已写入项重放不得重复计数')
assert.equal(fourth.written, 0)

/* ---------- 5. 导出 ---------- */
const exported = exportPackage(local, '甲组')
assert.equal(exported.kind, 'gbfungiguide-collection-package')
assert.equal(exported.records.length, 1)
const reparsed = parsePackage(JSON.stringify(exported))
assert.equal(reparsed.pkg.packageVersion, 1)

console.log('所有离线合并逻辑测试通过 ✅')

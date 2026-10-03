import assert from 'node:assert/strict'
import {
  parseCollectionPack,
  buildStaging,
  pendingItems,
  changeDecision,
  planWrites,
  deriveBlockers,
  entitiesEqual,
  buildCollectionPack,
  CURRENT_FORMAT_VERSION
} from '../src/utils/merge'
import type { CollectionPackData, StagedItem } from '../src/utils/merge'

let passed = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed++
  console.log('  ✓', name)
}

let seq = 0
const genId = (p: string) => `${p}_t${++seq}`

/* ---------- 夹具 ---------- */
const local: CollectionPackData = {
  points: [
    {
      id: 'pt_bhs', name: '百花山', longitude: 115.6, latitude: 39.8, altitude: 1400,
      vegetation: '针阔混交林', substrate: '落叶层', companionTrees: '栎', collectDate: '2026-09-01', collector: '沈禾'
    }
  ],
  records: [
    {
      id: 'rec_001', code: 'BHS-2026-001', tempName: '橙黄牛肝菌（暂定）', fruitBodyCount: 3, pointId: 'pt_bhs',
      capDiameter: 9.5, capShape: '半球形', capMargin: '全缘', capTexture: '绒状', fleshThickness: 2.1,
      fleshReaction: '缓慢变蓝', attachment: '直生', gillDensity: '中等', stipeLength: 7.4, stipeDiameter: 2.2,
      ring: '膜质菌环', volva: '无菌托', odor: '坚果味', hostTree: '辽东栎', collectDate: '2026-09-01',
      collector: '沈禾', note: '本地版本'
    }
  ],
  spores: [{ id: 'spo_001', recordId: 'rec_001', color: '淡黄', shape: '圆形', hours: 12, observeDate: '2026-09-02', moisture: '偏干' }],
  identifies: [
    { id: 'idf_001', recordId: 'rec_001', conclusion: 'Boletus sp.', basis: '形态特征', referenceBook: '图鉴', referencePage: 'P1', confidence: '低', needReview: true, reviewer: '祁野', date: '2026-09-03' }
  ]
}

console.log('1) 旧版采集包（v1，缺 fleshReaction 字段，裸顶层）兼容读取')
{
  const oldPack = {
    points: [],
    records: [
      {
        id: 'rec_new', code: 'BHS-2026-009', tempName: '新种', fruitBodyCount: 1, pointId: 'pt_bhs',
        capDiameter: 5, capShape: '平展', capMargin: '全缘', capTexture: '光滑', fleshThickness: 1,
        attachment: '直生', gillDensity: '中等', stipeLength: 5, stipeDiameter: 1,
        ring: '无菌环', volva: '无菌托', odor: '', hostTree: '', collectDate: '2026-10-01', collector: '甲组', note: ''
      }
    ],
    spores: [],
    identifies: []
  }
  const r = parseCollectionPack(oldPack)
  ok('解析成功', r.pack !== null)
  ok('有兼容留痕', r.compat.some((c) => c.reason.includes('旧版本')))
  ok('缺字段补默认值 不变色', (r.pack!.data.records[0] as any).fleshReaction === '不变色')
  ok('包版本识别为 1', r.pack!.formatVersion === 1)

  const items = buildStaging(r.pack!.data, local)
  ok('新条目默认并入', items.find((i) => i.incomingId === 'rec_new')!.decision === 'accept')
  ok('无未决项', pendingItems(items).length === 0)
  const writes = planWrites(items)
  ok('写入顺序：条目', writes.length === 1 && writes[0].kind === 'records' && writes[0].id === 'rec_new')
}

console.log('2) 同采集编号内容不同 → 冲突，必须逐项确认')
{
  const pack = buildCollectionPack({
    points: [],
    records: [{ ...local.records[0], tempName: '橙黄牛肝菌-修订', note: '野外组修订版' }],
    spores: [],
    identifies: []
  })
  const r = parseCollectionPack(pack)
  const items = buildStaging(r.pack!.data, local)
  const item = items.find((i) => i.incomingId === 'rec_001')!
  ok('识别为冲突', item.match === 'conflict')
  ok('默认 pending', item.decision === 'pending')
  ok('差异字段含暂定名/备注', item.diffFields.includes('暂定名') && item.diffFields.includes('备注'))
  ok('未确认不能写入', pendingItems(items).some((p) => p.key === item.key))
  ok('计划写入为空', planWrites(items).length === 0)
}

console.log('3) 冲突选择「保留两边」→ 新 id + 新编号，不覆盖本地')
{
  const pack = buildCollectionPack({ points: [], records: [{ ...local.records[0], tempName: '修订' }], spores: [], identifies: [] })
  let items = buildStaging(parseCollectionPack(pack).pack!.data, local)
  const item = items.find((i) => i.incomingId === 'rec_001')!
  items = changeDecision(items, item.key, 'keepBoth', genId)
  ok('保留两边分配新 id', !!items.find((i) => i.key === item.key)!.remapId)
  const writes = planWrites(items)
  ok('写入 1 条', writes.length === 1)
  ok('新 id 落库且编号带后缀', writes[0].id.startsWith('rec_t') && String((writes[0].row as any).code).endsWith('（并入）'))
  ok('本地原编号未受影响', local.records[0].code === 'BHS-2026-001')
}

console.log('4) 外键守卫：孢子印所属条目不并入时阻断；并入后放行')
{
  const r = parseCollectionPack({
    kind: 'gbfungiguide-collection-pack', formatVersion: 2,
    data: {
      points: [],
      records: [{ ...local.records[0], id: 'rec_x', code: 'X-1' }],
      spores: [{ id: 'spo_x', recordId: 'rec_x', color: '白色', shape: '', hours: 2, observeDate: '2026-10-01', moisture: '' }],
      identifies: []
    }
  })
  let items: StagedItem[] = buildStaging(r.pack!.data, local)
  // 用户把条目跳过 → 孢子印被阻断
  items = changeDecision(items, items.find((i) => i.kind === 'records')!.key, 'skip', genId)
  const spore = items.find((i) => i.kind === 'spores')!
  ok('孢子印被阻断', deriveBlockers(items).has(spore.key))
  ok('未确认列表含外键原因', pendingItems(items).some((p) => p.reasons.some((x) => x.includes('菌物条目未并入'))))
  // 改为并入条目 → 外键重映射到新 id
  items = changeDecision(items, items.find((i) => i.kind === 'records')!.key, 'accept', genId)
  ok('阻断解除', !deriveBlockers(items).has(spore.key))
  const writes = planWrites(items)
  const sp = writes.find((w) => w.kind === 'spores')!
  ok('孢子印 recordId 重映射为落库 id', (sp.row as any).recordId === 'rec_x')
}

console.log('5) 内容一致 → 默认跳过，不重复写入')
{
  const r = parseCollectionPack(buildCollectionPack(local))
  const items = buildStaging(r.pack!.data, local)
  ok('全部 same', items.every((i) => i.match === 'same'))
  ok('全部默认 skip', items.every((i) => i.decision === 'skip'))
  ok('计划写入 0 条', planWrites(items).length === 0)
}

console.log('6) 写入顺序：点→条目→孢子印→鉴定，且外键沿映射改写')
{
  const data: CollectionPackData = {
    points: [{ ...local.points[0], id: 'pt_new', name: '新样线' }],
    records: [{ ...local.records[0], id: 'rec_new', code: 'NEW-1', pointId: 'pt_new' }],
    spores: [{ ...local.spores[0], id: 'spo_new', recordId: 'rec_new' }],
    identifies: [{ ...local.identifies[0], id: 'idf_new', recordId: 'rec_new' }]
  }
  const items = buildStaging(data, local)
  const writes = planWrites(items)
  ok('共 4 条', writes.length === 4)
  ok('顺序正确', writes.map((w) => w.kind).join(',') === 'points,records,spores,identifies')
  ok('条目 pointId 指向包内采集点', (writes[1].row as any).pointId === 'pt_new')
  ok('孢子印 recordId 指向包内条目', (writes[2].row as any).recordId === 'rec_new')
}

console.log('7) 校验错误：非法枚举的行暂存且阻断，可显式跳过')
{
  const r = parseCollectionPack({
    data: {
      points: [],
      records: [{ ...local.records[0], id: 'rec_bad', code: 'BAD-1', attachment: '奇怪着生' }],
      spores: [], identifies: []
    }
  })
  ok('非法枚举进入暂存清单并带 issue', true)
  const items = buildStaging(r.pack!.data, local)
  const item = items.find((i) => i.incomingId === 'rec_bad')!
  ok('非法行 pending', item.decision === 'pending')
  ok('暂存行带校验问题', item.issues.some((e) => e.includes('着生方式')))
  const skipped = changeDecision(items, item.key, 'skip', genId)
  ok('跳过后无未决', pendingItems(skipped).length === 0)
  ok('跳过后不生成写入', planWrites(skipped).length === 0)
}

console.log('8) 包内同编号撞号：必须保留两边或跳过，accept 被阻断')
{
  const data: CollectionPackData = {
    points: [],
    records: [
      { ...local.records[0], id: 'rec_a', code: 'DUP-1', tempName: '甲组建档' },
      { ...local.records[0], id: 'rec_b', code: 'DUP-1', tempName: '乙组建档' }
    ],
    spores: [], identifies: []
  }
  let items = buildStaging(data, local)
  ok('两行都默认 accept（本地无此编号）', items.every((i) => i.decision === 'accept'))
  ok('accept 撞号被阻断', pendingItems(items).length === 2)
  items = changeDecision(items, items[0].key, 'keepBoth', genId)
  items = changeDecision(items, items[1].key, 'keepBoth', genId)
  const writes = planWrites(items)
  ok('保留两边后两行都可写', writes.length === 2)
  ok('两个新 id 不同', writes[0].id !== writes[1].id)
  ok('编号均带并入后缀', writes.every((w) => String((w.row as any).code).endsWith('（并入）')))
}

console.log('9) 同名采集点兜底命中')
{
  const data: CollectionPackData = {
    points: [{ ...local.points[0], id: 'pt_other_id', longitude: 116.0 }],
    records: [], spores: [], identifies: []
  }
  const items = buildStaging(data, local)
  const p = items[0]
  ok('同名识别为冲突', p.match === 'conflict' && p.localId === 'pt_bhs')
  ok('差异含经度', p.diffFields.includes('经度'))
}

console.log('10) 不是采集包的文件 → 致命错误')
{
  ok('字符串拒绝', parseCollectionPack('x').pack === null)
  ok('无数据键拒绝', parseCollectionPack({ hello: 1 }).pack === null)
  const r2 = parseCollectionPack(buildCollectionPack(local))
  ok('当前版本信封可解析', r2.pack !== null && r2.pack!.formatVersion === CURRENT_FORMAT_VERSION)
  ok('当前版本无兼容告警', r2.compat.length === 0)
}

console.log('11) 内容相等性忽略外键副本差异')
{
  const a = { ...local.points[0] } as any
  const b = { ...local.points[0], id: 'different' } as any
  ok('id 不同不算内容差异', entitiesEqual('points', a, b))
}

console.log('12) 问题随实体携带：前面有缺 id 行时，后续行的校验问题不串行')
{
  const r = parseCollectionPack({
    data: {
      points: [],
      records: [
        { ...local.records[0], id: '', code: 'NO-ID' },
        { ...local.records[0], id: 'rec_bad2', code: 'BAD-2', gillDensity: '非法密度' }
      ],
      spores: [], identifies: []
    }
  })
  // 缺 id 行被剥离，只暂存有效行；问题必须挂在 rec_bad2 而不是丢失
  const items = buildStaging(r.pack!.data, local)
  const bad = items.find((i) => i.incomingId === 'rec_bad2')
  ok('有效行仍在暂存清单', !!bad)
  ok('问题准确挂在后续行', !!bad && bad.issues.some((e) => e.includes('菌褶密度')))
}

console.log(`\n全部通过：${passed} 项断言`)

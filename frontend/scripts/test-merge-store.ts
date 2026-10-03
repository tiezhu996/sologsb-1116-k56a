import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db } from '../src/hooks/usePersistentStore'
import { mergeStore } from '../src/stores/mergeStore'
import { buildCollectionPack } from '../src/utils/merge'
import type { CollectionPackData } from '../src/utils/merge'

let passed = 0
function ok(name: string, cond: boolean) {
  assert.ok(cond, name)
  passed++
  console.log('  ✓', name)
}

const today = '2026-10-03'
const local: CollectionPackData = {
  points: [
    { id: 'pt_1', name: '本地点', longitude: 116, latitude: 40, altitude: 500, vegetation: '针叶林', substrate: '土壤', companionTrees: '松', collectDate: today, collector: '本地' }
  ],
  records: [
    {
      id: 'rec_1', code: 'LOC-1', tempName: '本地条目', fruitBodyCount: 1, pointId: 'pt_1',
      capDiameter: 5, capShape: '平展', capMargin: '全缘', capTexture: '光滑', fleshThickness: 1,
      fleshReaction: '不变色', attachment: '直生', gillDensity: '中等', stipeLength: 5, stipeDiameter: 1,
      ring: '无菌环', volva: '无菌托', odor: '', hostTree: '松', collectDate: today, collector: '本地', note: ''
    }
  ],
  spores: [],
  identifies: []
}

const packText = JSON.stringify(
  buildCollectionPack({
    points: [{ ...local.points[0], id: 'pt_a', name: '新点A' }],
    records: [
      { ...local.records[0], id: 'rec_a', code: 'PKG-A', pointId: 'pt_a', tempName: '包条目A' },
      { ...local.records[0], id: 'rec_b', code: 'PKG-B', pointId: 'pt_a', tempName: '包条目B' }
    ],
    spores: [
      { id: 'spo_a', recordId: 'rec_a', color: '白色', shape: '', hours: 6, observeDate: today, moisture: '' },
      { id: 'spo_b', recordId: 'rec_b', color: '紫褐', shape: '', hours: 8, observeDate: today, moisture: '' }
    ],
    identifies: [{ id: 'idf_a', recordId: 'rec_a', conclusion: 'Agaricus sp.', basis: '形态特征', referenceBook: '', referencePage: '', confidence: '中', needReview: false, reviewer: '甲组', date: today }]
  })
)

console.log('A) 校验暂存不写正式表')
{
  await db.points.bulkPut(local.points)
  await db.records.bulkPut(local.records)
  const r = await mergeStore.getState().importPack('group-a.json', packText)
  ok('导入成功', r.ok)
  ok('正式点表仍只有本地点', (await db.points.count()) === 1)
  ok('正式条目表仍只有本地条目', (await db.records.count()) === 1)
  ok('会话已落 mergeSessions', (await db.mergeSessions.count()) === 1)
  await mergeStore.getState().hydrate()
}

const sessionId = mergeStore.getState().sessions[0].id

console.log('B) 未确认冲突不能写入（构造一个冲突包场景由无冲突包默认通过，此处验证正常通过路径）')
{
  const pending = mergeStore.getState().sessions[0].items.filter((i) => i.decision === 'pending')
  ok('全新包无未决项', pending.length === 0)
  const r = await mergeStore.getState().runMerge(sessionId)
  ok('写入成功', r.ok)
  ok('点表 2 条', (await db.points.count()) === 2)
  ok('条目表 3 条', (await db.records.count()) === 3)
  ok('孢子印 2 条', (await db.spores.count()) === 2)
  ok('鉴定 1 条', (await db.identifies.count()) === 1)
  await mergeStore.getState().hydrate()
  ok('会话状态 done', mergeStore.getState().sessions[0].status === 'done')
  ok('检查点覆盖全部 6 个写入项', mergeStore.getState().sessions[0].checkpoint.length === 6)
  const recA = await db.records.get('rec_a')
  ok('外键改写：rec_a.pointId=pt_a', recA?.pointId === 'pt_a')
}

console.log('C) 已完成会话再跑不重复写入')
{
  const before = await db.records.count()
  const r = await mergeStore.getState().runMerge(sessionId)
  ok('拒绝重复执行', !r.ok)
  ok('记录数不变', (await db.records.count()) === before)
}

console.log('D) 中断恢复：写入中途抛错，恢复后不重复写已确认项')
{
  // 新包：点 + 2 条目
  const text2 = JSON.stringify(
    buildCollectionPack({
      points: [{ ...local.points[0], id: 'pt_c', name: '新点C' }],
      records: [
        { ...local.records[0], id: 'rec_c1', code: 'PKG-C1', pointId: 'pt_c', tempName: 'C1' },
        { ...local.records[0], id: 'rec_c2', code: 'PKG-C2', pointId: 'pt_c', tempName: 'C2' }
      ],
      spores: [],
      identifies: []
    })
  )
  const ir = await mergeStore.getState().importPack('group-c.json', text2)
  ok('第二包导入', ir.ok)
  await mergeStore.getState().hydrate()
  const sid2 = mergeStore.getState().sessions[0].id

  // 在第二条目写入时通过 creating 钩子打桩失败（事务内钩子抛错会回滚整行+检查点）
  const failHook = (pk: string): void => {
    if (pk === 'rec_c2') throw new Error('模拟磁盘故障')
  }
  db.records.hook('creating', failHook)

  const failed = await mergeStore.getState().runMerge(sid2)
  db.records.hook('creating').unsubscribe(failHook)
  ok('报告失败', !failed.ok && failed.message.includes('检查点'))
  await mergeStore.getState().hydrate()
  const s2 = mergeStore.getState().sessions.find((s) => s.id === sid2)!
  ok('状态 failed', s2.status === 'failed')
  ok('检查点只有已确认的 2 项（点 + 第一条目）', s2.checkpoint.length === 2)
  ok('第一条目已落库', !!(await db.records.get('rec_c1')))
  ok('第二条目未落库', !(await db.records.get('rec_c2')))
  const recordsAfterFail = await db.records.count()

  // 恢复：跳过检查点，仅写剩余项
  const resume = await mergeStore.getState().runMerge(sid2)
  ok('恢复成功', resume.ok && resume.message.includes('写入 1'))
  ok('第二条目已补写', !!(await db.records.get('rec_c2')))
  ok('第一条目没有被重复写入（计数只 +1）', (await db.records.count()) === recordsAfterFail + 1)
  const finalSession = (await db.mergeSessions.get(sid2))!
  ok('检查点最终 3 项无重复', new Set(finalSession.checkpoint).size === 3)
}

console.log('E) 冲突包：未逐项确认时 runMerge 被拒')
{
  // 与本地 LOC-1 同编号但内容不同
  const text3 = JSON.stringify(
    buildCollectionPack({
      points: [],
      records: [{ ...local.records[0], id: 'rec_d', code: 'LOC-1', tempName: '野外改名版本' }],
      spores: [], identifies: []
    })
  )
  const ir = await mergeStore.getState().importPack('group-d.json', text3)
  ok('第三包导入暂存', ir.ok)
  await mergeStore.getState().hydrate()
  const sid3 = mergeStore.getState().sessions[0].id
  const r = await mergeStore.getState().runMerge(sid3)
  ok('未确认不能写入', !r.ok)
  ok('本地条目未被覆盖', (await db.records.get('rec_1'))?.tempName === '本地条目')
}

console.log(`\n全部通过：${passed} 项断言`)

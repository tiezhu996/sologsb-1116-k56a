<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  CollectPoint,
  FungusRecord,
  IdentifyLog,
  ItemKind,
  ItemState,
  LocalSnapshot,
  MergeItem,
  MergeSession,
  MergeStage,
  SporePrint
} from '@/types'
import { MERGE_STAGES, STAGE_LABELS } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { mergeStore } from '@/stores/mergeStore'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { pointStore } from '@/stores/pointStore'
import { identifyStore } from '@/stores/identifyStore'
import { buildLegacyPackage, exportPackage } from '@/utils/merge'
import { downloadJson } from '@/utils/export'

const mergeState = useStore(mergeStore)
const recordState = useStore(recordStore)
const sporeState = useStore(sporeStore)
const pointState = useStore(pointStore)
const identifyState = useStore(identifyStore)

const fileInput = ref<HTMLInputElement | null>(null)
const importing = ref(false)
const applying = ref(false)
const exportGroup = ref(`野外分组-${new Date().toISOString().slice(0, 10)}`)

const session = computed<MergeSession | undefined>(() =>
  mergeState.sessions.find((item) => item.id === mergeState.activeId) ?? undefined
)

onMounted(async () => {
  await mergeStore.getState().hydrate()
})

/* ---------------- 读取本地正式数据快照 ---------------- */

function localSnapshot(): LocalSnapshot {
  return {
    points: pointState.points,
    records: recordState.records,
    spores: sporeState.spores,
    identifies: identifyState.logs
  }
}

/* ---------------- 校验并暂存采集包 ---------------- */

function triggerPick(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  importing.value = true
  try {
    const text = await file.text()
    const { session: created, duplicated } = await mergeStore.getState().stageFile(file.name, text, localSnapshot())
    if (duplicated) {
      ElMessage.info('同一采集包已暂存过，已切换到既有会话（可从检查点继续）')
    } else {
      ElMessage.success(`采集包已校验并暂存：${created.group}，共 ${created.items.length} 项待逐项确认`)
    }
  } catch (cause) {
    ElMessage.error(cause instanceof Error ? cause.message : '采集包解析失败')
  } finally {
    importing.value = false
  }
}

/* ---------------- 逐项确认 ---------------- */

const KIND_META: Record<ItemKind, { label: string; type: 'success' | 'warning' | 'info' | 'danger' }> = {
  new: { label: '新增', type: 'success' },
  conflict: { label: '同编号差异', type: 'warning' },
  identical: { label: '内容一致', type: 'info' },
  error: { label: '校验失败', type: 'danger' }
}

const STATE_META: Record<ItemState, { label: string; type: 'success' | 'warning' | 'info' | 'danger' | 'primary' }> = {
  pending: { label: '待确认', type: 'warning' },
  confirmed: { label: '已确认', type: 'primary' },
  written: { label: '已写入', type: 'success' },
  skipped: { label: '自动跳过', type: 'info' },
  failed: { label: '写入失败', type: 'danger' }
}

function isChecked(item: MergeItem): boolean {
  return item.state === 'confirmed' || item.state === 'written'
}

/** 校验失败项状态统一显示为「不予导入」，与一致跳过区分 */
function displayState(item: MergeItem): { label: string; type: 'success' | 'warning' | 'info' | 'danger' | 'primary' } {
  if (item.kind === 'error') return { label: '不予导入', type: 'danger' }
  return STATE_META[item.state]
}

async function toggleItem(item: MergeItem, checked: boolean): Promise<void> {
  await mergeStore.getState().setItemConfirmed(item.itemKey, checked)
}

async function confirmStage(stage: MergeStage): Promise<void> {
  await mergeStore.getState().confirmAllNew(stage)
}

/* ---------------- 从检查点继续写入 ---------------- */

async function runApply(): Promise<void> {
  const current = session.value
  if (!current) return
  const confirmedCount = current.items.filter((item) => item.state === 'confirmed').length
  if (confirmedCount === 0) {
    ElMessage.warning('请先逐项勾选确认，未确认的内容不能进入正式数据')
    return
  }
  applying.value = true
  try {
    const result = await mergeStore.getState().applyActive()
    if (!result) return
    // 写入后刷新正式数据，图谱/详情/鉴定/导出照常使用
    await Promise.all([
      pointStore.getState().hydrate(),
      recordStore.getState().hydrate(),
      sporeStore.getState().hydrate(),
      identifyStore.getState().hydrate()
    ])
    if (result.failed) {
      ElMessage.error(`写入在「${STAGE_LABELS[result.failed.stage]}」中断：${result.failed.failReason ?? '未知错误'}；已写入部分由检查点保护，不会重复`)
    } else if (result.remaining > 0) {
      ElMessage.warning(`已写入 ${result.written} 项，仍有 ${result.remaining} 项未确认，保留在暂存区`)
    } else {
      ElMessage.success(`全部确认项写入完成，共 ${result.written} 项；未确认项未进入正式数据`)
    }
  } finally {
    applying.value = false
  }
}

async function discard(id: string): Promise<void> {
  await ElMessageBox.confirm('放弃该合并会话？暂存与检查点将一并清除（已写入正式数据的内容不受影响）', '清除会话', {
    type: 'warning'
  })
  await mergeStore.getState().discard(id)
  ElMessage.success('合并会话已清除')
}

function selectSession(id: string): void {
  void mergeStore.getState().select(id)
}

/* ---------------- 阶段统计 ---------------- */

function stageItems(stage: MergeStage): MergeItem[] {
  return session.value?.items.filter((item) => item.stage === stage) ?? []
}

function stageSummary(stage: MergeStage): string {
  const list = stageItems(stage)
  const count = (predicate: (item: MergeItem) => boolean) => list.filter(predicate).length
  return `共 ${list.length} 项 · 新增 ${count((i) => i.kind === 'new')} · 冲突 ${count(
    (i) => i.kind === 'conflict'
  )} · 一致跳过 ${count((i) => i.kind === 'identical')} · 失败 ${count((i) => i.kind === 'error')}`
}

const checkpointTip = computed(() => {
  const current = session.value
  if (!current) return ''
  const { writtenCount, lastItemKey } = current.checkpoint
  if (writtenCount === 0) return '尚未开始写入'
  return `检查点：已确认写入 ${writtenCount} 项，最近写入 ${lastItemKey ?? '—'}；中断恢复时自动跳过，不重复写入`
})

/* ---------------- 条目摘要 ---------------- */

function asPoint(row: unknown): CollectPoint | null {
  return row && typeof row === 'object' ? (row as CollectPoint) : null
}
function asRecord(row: unknown): FungusRecord | null {
  return row && typeof row === 'object' ? (row as FungusRecord) : null
}
function asSpore(row: unknown): SporePrint | null {
  return row && typeof row === 'object' ? (row as SporePrint) : null
}
function asLog(row: unknown): IdentifyLog | null {
  return row && typeof row === 'object' ? (row as IdentifyLog) : null
}

function summary(item: MergeItem): string {
  const row = item.resolved ?? item.incoming
  if (item.stage === 'points') {
    const point = asPoint(row)
    return point ? `${point.name}（${point.longitude.toFixed(4)}, ${point.latitude.toFixed(4)}）` : '非法采集点'
  }
  if (item.stage === 'records') {
    const record = asRecord(row)
    return record ? `${record.code} · ${record.tempName || '未命名'} · ${record.capShape}/${record.attachment}` : '非法菌物条目'
  }
  if (item.stage === 'spores') {
    const spore = asSpore(row)
    return spore ? `${spore.color} · ${spore.shape || '未描述印形'} · ${spore.hours}h` : '非法孢子印'
  }
  const log = asLog(row)
  return log ? `${log.conclusion} · 置信度${log.confidence} · ${log.date}` : '非法鉴定结论'
}

function localSummary(item: MergeItem): string {
  if (!item.local) return '—'
  if (item.stage === 'points') {
    const point = item.local as CollectPoint
    return `${point.name}（${point.longitude.toFixed(4)}, ${point.latitude.toFixed(4)}）`
  }
  if (item.stage === 'records') {
    const record = item.local as FungusRecord
    return `${record.code} · ${record.tempName || '未命名'}`
  }
  if (item.stage === 'spores') {
    const spore = item.local as SporePrint
    return `${spore.color} · ${spore.shape || '未描述印形'}`
  }
  const log = item.local as IdentifyLog
  return `${log.conclusion} · 置信度${log.confidence}`
}

const STATUS_LABEL: Record<MergeSession['status'], string> = {
  staged: '待确认',
  writing: '写入中',
  partial: '部分写入',
  done: '已完成',
  failed: '已中断'
}

const STATUS_TYPE: Record<MergeSession['status'], 'success' | 'warning' | 'info' | 'danger' | 'primary'> = {
  staged: 'warning',
  writing: 'primary',
  partial: 'warning',
  done: 'success',
  failed: 'danger'
}

/* ---------------- 导出当前分组采集包 ---------------- */

function exportCurrent(legacy: boolean): void {
  const snapshot = localSnapshot()
  if (snapshot.points.length === 0) {
    ElMessage.warning('本地图谱暂无数据，无法导出采集包')
    return
  }
  const stamp = new Date().toISOString().slice(0, 10)
  if (legacy) {
    downloadJson(`采集包-旧版兼容-${stamp}.json`, buildLegacyPackage(snapshot, exportGroup.value))
    ElMessage.success('已导出旧版本采集包（缺少新字段），可用于验证兼容读写')
  } else {
    downloadJson(`采集包-${stamp}.json`, exportPackage(snapshot, exportGroup.value))
    ElMessage.success('当前图谱已导出为采集包，可分发给其他野外小组')
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">离线合并采集包</h2>
        <p class="page-sub">
          野外分组离线记录回库后：先校验并暂存采集包，再按「采集点 → 菌物条目 → 孢子印 → 鉴定结论」逐项确认；同一采集编号内容不同时保留两边版本，未确认不进入正式数据，中断可从检查点恢复。
        </p>
      </div>
    </div>

    <el-alert type="info" :closable="false" class="rule-strip">
      <template #title>
        合并规则：冲突项（同编号差异）必须逐项勾选；「内容一致」自动跳过不重复写入；旧版本采集包缺少新字段时按默认值兼容读取并在条目上标注。
      </template>
    </el-alert>

    <!-- 第一步：校验并暂存 -->
    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>① 校验并暂存采集包</span>
          <el-tag v-if="mergeState.sessions.length" size="small" type="info" effect="plain">
            历史会话 {{ mergeState.sessions.length }} 个
          </el-tag>
        </div>
      </template>
      <div class="import-row">
        <el-button type="primary" :loading="importing" @click="triggerPick">
          <el-icon><Upload /></el-icon>选择采集包 JSON
        </el-button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="hidden-file"
          @change="onFileChange"
        />
        <span class="muted">选择其他野外小组导出的采集包，先做结构与字段校验，通过后才进入暂存区</span>
      </div>

      <el-divider content-position="left">导出本图谱采集包（离线分发给其他小组）</el-divider>
      <div class="import-row">
        <el-input v-model="exportGroup" style="width: 260px" placeholder="分组名称" />
        <el-button @click="exportCurrent(false)">导出当前版本采集包</el-button>
        <el-button @click="exportCurrent(true)">导出旧版兼容包（缺新字段）</el-button>
      </div>

      <div v-if="mergeState.sessions.length > 0" class="session-list">
        <div
          v-for="s in mergeState.sessions"
          :key="s.id"
          class="session-row"
          :class="{ active: s.id === mergeState.activeId }"
          @click="selectSession(s.id)"
        >
          <el-tag :type="STATUS_TYPE[s.status]" size="small" effect="dark">{{ STATUS_LABEL[s.status] }}</el-tag>
          <span class="session-name">{{ s.group }}</span>
          <span class="muted mono">{{ s.fileName }}</span>
          <span class="muted">导出 {{ s.exportedAt }}</span>
          <span class="muted">{{ s.items.length }} 项</span>
          <el-button
            size="small"
            type="danger"
            link
            @click.stop="discard(s.id)"
          >
            清除
          </el-button>
        </div>
      </div>
    </el-card>

    <template v-if="session">
      <!-- 会话概览与检查点 -->
      <el-card shadow="never" class="block">
        <template #header>
          <div class="block-head">
            <span>② 暂存会话：{{ session.group }}</span>
            <el-tag :type="STATUS_TYPE[session.status]" effect="dark">{{ STATUS_LABEL[session.status] }}</el-tag>
          </div>
        </template>
        <el-descriptions :column="3" size="small" border>
          <el-descriptions-item label="来源文件">{{ session.fileName }}</el-descriptions-item>
          <el-descriptions-item label="分组">{{ session.group }}</el-descriptions-item>
          <el-descriptions-item label="导出时间">{{ session.exportedAt }}</el-descriptions-item>
          <el-descriptions-item label="内容指纹" :span="3">
            <span class="mono">{{ session.packageHash }}</span>
          </el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-for="(warning, index) in session.packageWarnings"
          :key="index"
          type="warning"
          :closable="false"
          show-icon
          class="warn-line"
          :title="warning"
        />
        <div class="checkpoint">
          <el-icon><RefreshRight /></el-icon>
          <span>{{ checkpointTip }}</span>
        </div>
        <el-alert
          v-if="session.checkpoint.lastError"
          type="error"
          :closable="false"
          show-icon
          class="warn-line"
          :title="`上次中断原因：${session.checkpoint.lastError}`"
        />
      </el-card>

      <!-- 第三步：按顺序逐项确认 -->
      <el-card v-for="stage in MERGE_STAGES" :key="stage" shadow="never" class="block">
        <template #header>
          <div class="block-head">
            <span>
              {{ MERGE_STAGES.indexOf(stage) + 3 }}. {{ STAGE_LABELS[stage] }}
              <span class="muted" style="margin-left: 8px">{{ stageSummary(stage) }}</span>
            </span>
            <el-button size="small" plain @click="confirmStage(stage)">勾选本阶段全部新增项</el-button>
          </div>
        </template>
        <el-table :data="stageItems(stage)" border stripe row-key="itemKey">
          <el-table-column width="64" align="center">
            <template #header>确认</template>
            <template #default="{ row }: { row: MergeItem }">
              <el-checkbox
                :model-value="isChecked(row)"
                :disabled="row.kind === 'error' || row.kind === 'identical' || row.state === 'written' || row.state === 'skipped'"
                @change="(value: boolean) => toggleItem(row, value)"
              />
            </template>
          </el-table-column>
          <el-table-column label="类型" width="104">
            <template #default="{ row }: { row: MergeItem }">
              <el-tag :type="KIND_META[row.kind].type" size="small">{{ KIND_META[row.kind].label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="96">
            <template #default="{ row }: { row: MergeItem }">
              <el-tag :type="displayState(row).type" size="small" effect="plain">{{ displayState(row).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="采集包版本" min-width="260">
            <template #default="{ row }: { row: MergeItem }">
              <span>{{ summary(row) }}</span>
              <div v-for="(w, i) in row.warnings" :key="`w${i}`" class="cell-warn">兼容：{{ w }}</div>
              <div v-for="(e, i) in row.errors" :key="`e${i}`" class="cell-error">{{ e }}</div>
            </template>
          </el-table-column>
          <el-table-column label="本地版本" min-width="180">
            <template #default="{ row }: { row: MergeItem }">
              <span>{{ localSummary(row) }}</span>
              <div v-if="row.kind === 'conflict'" class="cell-warn">两边版本保留，写入时外部版本换新 ID</div>
            </template>
          </el-table-column>
          <el-table-column type="expand">
            <template #default="{ row }: { row: MergeItem }">
              <div v-if="row.diffs.length" class="diff-box">
                <p class="diff-title">逐项差异（{{ row.diffs.length }} 项）——确认后两边版本并存</p>
                <el-table :data="row.diffs" border size="small">
                  <el-table-column prop="label" label="字段" width="150" />
                  <el-table-column prop="local" label="本地版本" />
                  <el-table-column prop="incoming" label="采集包版本" />
                </el-table>
              </div>
              <el-empty v-else description="无字段差异" :image-size="60" />
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- 写入 -->
      <el-card shadow="never" class="block action-card">
        <el-button
          type="primary"
          size="large"
          :loading="applying"
          @click="runApply"
        >
          {{ session.status === 'failed' || session.status === 'partial' ? '从检查点继续写入已确认项' : '写入已确认项到正式数据' }}
        </el-button>
        <span class="muted">
          待确认 {{ session.items.filter((i) => i.state === 'pending').length }} ·
          已确认 {{ session.items.filter((i) => i.state === 'confirmed').length }} ·
          已写入 {{ session.items.filter((i) => i.state === 'written').length }} ·
          校验失败 {{ session.items.filter((i) => i.kind === 'error').length }}
        </span>
      </el-card>
    </template>

    <el-empty v-else description="选择采集包后，这里会显示分阶段暂存与逐项确认列表" />
  </div>
</template>

<style scoped>
.rule-strip {
  margin-bottom: 14px;
}
.block {
  border-radius: 12px;
  margin-bottom: 16px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.import-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.hidden-file {
  display: none;
}
.session-list {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid #e8e2d6;
  border-radius: 8px;
  cursor: pointer;
}
.session-row.active {
  border-color: #c96f3a;
  box-shadow: 0 0 0 1px #c96f3a inset;
}
.session-name {
  font-weight: 600;
  min-width: 120px;
}
.warn-line {
  margin-top: 10px;
}
.checkpoint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #eef6f0;
  color: #2f6a45;
  font-size: 12px;
}
.cell-warn {
  font-size: 11px;
  color: #a45b1f;
  margin-top: 2px;
}
.cell-error {
  font-size: 11px;
  color: #c0392b;
  margin-top: 2px;
}
.diff-box {
  padding: 10px 16px;
  background: #faf8f3;
}
.diff-title {
  margin: 0 0 8px;
  font-size: 12px;
  color: #6f7d72;
}
.action-card {
  display: flex;
  align-items: center;
  gap: 16px;
}
:deep(.action-card .el-card__body) {
  display: flex;
  align-items: center;
  gap: 16px;
}
</style>

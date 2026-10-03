<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadRawFile } from 'element-plus'
import { useStore } from '@/hooks/usePersistentStore'
import { mergeStore, blockersOf, type MergeSession } from '@/stores/mergeStore'
import {
  buildCollectionPack,
  ENTITY_KIND_LABELS,
  ENTITY_ORDER,
  FIELD_LABELS,
  type Decision,
  type EntityKind,
  type StagedItem
} from '@/utils/merge'
import { downloadJson } from '@/utils/export'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { pointStore } from '@/stores/pointStore'
import { identifyStore } from '@/stores/identifyStore'

const mergeState = useStore(mergeStore)
const recordState = useStore(recordStore)
const sporeState = useStore(sporeStore)
const pointState = useStore(pointStore)
const identifyState = useStore(identifyStore)

const activeId = ref('')
const uploading = ref(false)
const running = ref(false)
const diffVisible = ref(false)
const diffItem = ref<StagedItem | null>(null)

onMounted(async () => {
  await mergeStore.getState().hydrate()
  if (mergeState.sessions.length > 0 && !activeId.value) activeId.value = mergeState.sessions[0].id
})

const active = computed<MergeSession | null>(
  () => mergeState.sessions.find((item) => item.id === activeId.value) ?? null
)

const localLookup = computed(() => {
  const all = [
    ...pointState.points.map((row) => ({ kind: 'points' as EntityKind, row })),
    ...recordState.records.map((row) => ({ kind: 'records' as EntityKind, row })),
    ...sporeState.spores.map((row) => ({ kind: 'spores' as EntityKind, row })),
    ...identifyState.logs.map((row) => ({ kind: 'identifies' as EntityKind, row }))
  ]
  return new Map(all.map((item) => [`${item.kind}:${item.row.id}`, item.row as unknown as Record<string, unknown>]))
})

function itemsOf(kind: EntityKind): StagedItem[] {
  return active.value?.items.filter((item) => item.kind === kind) ?? []
}

const blockers = computed(() => (active.value ? blockersOf(active.value.items) : new Map<string, string[]>()))

interface KindStat {
  total: number
  accept: number
  skip: number
  keepBoth: number
  pending: number
}

function statOf(kind: EntityKind): KindStat {
  const list = itemsOf(kind)
  return {
    total: list.length,
    accept: list.filter((item) => item.decision === 'accept').length,
    skip: list.filter((item) => item.decision === 'skip').length,
    keepBoth: list.filter((item) => item.decision === 'keepBoth').length,
    pending: list.filter((item) => item.decision === 'pending').length
  }
}

const pendingCount = computed(() => {
  if (!active.value) return 0
  return active.value.items.filter((item) => {
    if (item.decision === 'pending') return true
    return blockers.value.has(item.key) && item.decision !== 'skip'
  }).length
})

const writableCount = computed(() => {
  if (!active.value) return 0
  return active.value.items.filter((item) => (item.decision === 'accept' || item.decision === 'keepBoth') && !blockers.value.has(item.key)).length
})

const progress = computed(() => {
  if (!active.value) return 0
  const total = writableCount.value + active.value.checkpoint.length
  if (total === 0) return 0
  return Math.round((active.value.checkpoint.length / total) * 100)
})

async function handleFile(file: UploadRawFile): Promise<boolean> {
  uploading.value = true
  try {
    const text = await file.text()
    const result = await mergeStore.getState().importPack(file.name, text)
    if (!result.ok) {
      ElMessage.error(result.message)
      if (result.fatal.length > 0) ElMessageBox.alert(result.fatal.join('\n'), '采集包校验失败', { type: 'error' })
      return false
    }
    ElMessage.success(result.message)
    if (result.fatal.length > 0) {
      ElMessage.warning(`采集包标识存在提示：${result.fatal.join('；')}`)
    }
    await mergeStore.getState().hydrate()
    activeId.value = mergeState.sessions[0]?.id ?? ''
    return false // 阻止 el-upload 自动上传
  } finally {
    uploading.value = false
  }
}

async function decide(item: StagedItem, decision: Decision): Promise<void> {
  if (!active.value || active.value.status === 'writing' || active.value.status === 'done') return
  await mergeStore.getState().decide(active.value.id, item.key, decision)
}

async function runMerge(): Promise<void> {
  if (!active.value) return
  if (pendingCount.value > 0) {
    ElMessage.warning('仍有未逐项确认的内容，请先完成确认')
    return
  }
  running.value = true
  try {
    const result = await mergeStore.getState().runMerge(active.value.id)
    if (result.ok) ElMessage.success(result.message)
    else ElMessage.error(result.message)
  } finally {
    running.value = false
  }
}

async function discard(session: MergeSession): Promise<void> {
  await ElMessageBox.confirm(
    `确认丢弃采集包「${session.filename}」的暂存与检查点？已写入正式数据的部分不会回滚，未写入的部分将不再保留。`,
    '丢弃合并会话',
    { type: 'warning' }
  )
  await mergeStore.getState().removeSession(session.id)
  if (activeId.value === session.id) activeId.value = mergeState.sessions[0]?.id ?? ''
  ElMessage.success('暂存会话已移除')
}

function openDiff(item: StagedItem): void {
  diffItem.value = item
  diffVisible.value = true
}

function exportPack(): void {
  const pack = buildCollectionPack(
    {
      points: pointState.points,
      records: recordState.records,
      spores: sporeState.spores,
      identifies: identifyState.logs
    },
    { collector: identifyState.logs[0]?.reviewer || '本地图谱', note: '离线分组采集包' }
  )
  const stamp = new Date().toISOString().slice(0, 10)
  downloadJson(`gbfungiguide-pack-${stamp}.json`, pack)
  ElMessage.success('已导出当前图谱采集包，可供其他分组离线并入')
}

const matchTagType: Record<StagedItem['match'], 'success' | 'info' | 'danger'> = {
  same: 'success',
  none: 'info',
  conflict: 'danger'
}
const matchLabel: Record<StagedItem['match'], string> = {
  same: '内容一致',
  none: '新增',
  conflict: '编号冲突'
}
const statusTagType: Record<MergeSession['status'], 'info' | 'warning' | 'success' | 'danger'> = {
  reviewing: 'info',
  writing: 'warning',
  done: 'success',
  failed: 'danger'
}
const statusLabel: Record<MergeSession['status'], string> = {
  reviewing: '确认中',
  writing: '写入中',
  done: '已完成',
  failed: '中断待恢复'
}

function fieldRows(item: StagedItem): { field: string; label: string; local: unknown; incoming: unknown; same: boolean }[] {
  const labels = FIELD_LABELS[item.kind]
  const incoming = item.incoming as unknown as Record<string, unknown>
  const local = item.localId ? localLookup.value.get(`${item.kind}:${item.localId}`) : undefined
  return Object.keys(labels)
    .filter((field) => field !== 'id')
    .map((field) => {
      const localValue = local?.[field] ?? '—'
      const incomingValue = incoming[field] ?? '—'
      return {
        field,
        label: labels[field],
        local: localValue,
        incoming: incomingValue,
        same: String(localValue) === String(incomingValue)
      }
    })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">离线合并采集包</h2>
        <p class="page-sub">
          先校验并暂存采集包，再按「采集点 → 菌物条目 → 孢子印 → 鉴定结论」逐项确认并入；同一采集编号内容不同时可保留两边，未确认不进入正式数据。写入带检查点，中断后可恢复且不重复写入。
        </p>
      </div>
      <div class="head-actions">
        <el-button @click="exportPack">
          <el-icon><Download /></el-icon>导出本机采集包
        </el-button>
        <el-upload
          :show-file-list="false"
          :before-upload="handleFile"
          accept=".json,application/json"
          :disabled="uploading"
        >
          <el-button type="primary" :loading="uploading">
            <el-icon><Upload /></el-icon>校验并暂存采集包
          </el-button>
        </el-upload>
      </div>
    </div>

    <el-empty v-if="mergeState.sessions.length === 0" description="暂无暂存的采集包：各分组把导出的 JSON 采集包在此校验、暂存并逐项确认并入" />

    <template v-else>
      <div class="session-bar">
        <el-select v-model="activeId" placeholder="选择暂存会话" style="width: 360px">
          <el-option
            v-for="session in mergeState.sessions"
            :key="session.id"
            :label="`${session.filename}（${statusLabel[session.status]}）`"
            :value="session.id"
          />
        </el-select>
      </div>

      <template v-if="active">
        <el-card shadow="never" class="summary-card">
          <div class="summary-head">
            <div>
              <div class="summary-name">{{ active.filename }}</div>
              <div class="muted">
                来源：{{ active.sourceName || '—' }} · 暂存时间 {{ active.updatedAt.slice(0, 16).replace('T', ' ') }} ·
                包格式 v{{ active.formatVersion }}
              </div>
            </div>
            <div class="summary-tags">
              <el-tag :type="statusTagType[active.status]">{{ statusLabel[active.status] }}</el-tag>
              <el-tag type="danger" v-if="pendingCount > 0">待确认 {{ pendingCount }}</el-tag>
              <el-tag type="success">将写入 {{ writableCount }}</el-tag>
            </div>
          </div>

          <el-alert
            v-for="note in active.compat"
            :key="note.reason"
            class="compat-alert"
            type="warning"
            :closable="false"
            show-icon
          >
            <template #title>
              兼容读写：{{ note.reason }}
              <span v-if="note.kind">（{{ ENTITY_KIND_LABELS[note.kind] }} {{ note.entityId }}）</span>
            </template>
          </el-alert>

          <div v-if="active.status === 'writing' || active.status === 'failed' || active.checkpoint.length > 0" class="checkpoint">
            <div class="muted">
              检查点：已确认写入 {{ active.checkpoint.length }} 项
              <template v-if="active.status === 'failed'">
                · <span class="err-text">中断原因：{{ active.error }}</span>
              </template>
            </div>
            <el-progress :percentage="progress" :status="active.status === 'failed' ? 'exception' : active.status === 'done' ? 'success' : undefined" />
          </div>

          <div class="summary-actions">
            <el-button
              type="primary"
              :disabled="pendingCount > 0 || active.status === 'writing' || active.status === 'done'"
              :loading="running"
              @click="runMerge"
            >
              {{ active.status === 'failed' ? '从检查点恢复继续写入' : '开始写入正式数据' }}
            </el-button>
            <el-button
              type="danger"
              plain
              :disabled="active.status === 'writing'"
              @click="discard(active)"
            >
              丢弃暂存
            </el-button>
            <span v-if="pendingCount > 0" class="muted">还有 {{ pendingCount }} 项未确认或被阻断，不能开始写入</span>
          </div>
        </el-card>

        <el-card
          v-for="kind in ENTITY_ORDER"
          :key="kind"
          shadow="never"
          class="kind-card"
        >
          <template #header>
            <div class="kind-head">
              <span>{{ ENTITY_KIND_LABELS[kind] }}（{{ statOf(kind).total }}）</span>
              <span class="kind-stats muted">
                并入 {{ statOf(kind).accept }} · 保留两边 {{ statOf(kind).keepBoth }} · 跳过 {{ statOf(kind).skip }}
                <el-tag v-if="statOf(kind).pending > 0" type="danger" size="small">未确认 {{ statOf(kind).pending }}</el-tag>
              </span>
            </div>
          </template>

          <el-table :data="itemsOf(kind)" border size="small" row-key="key">
            <el-table-column label="状态" width="100">
              <template #default="{ row }: { row: StagedItem }">
                <el-tag :type="matchTagType[row.match]" size="small">{{ matchLabel[row.match] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column min-width="220">
              <template #header>内容</template>
              <template #default="{ row }: { row: StagedItem }">
                <div class="item-name">{{ row.label }}</div>
                <div class="muted">{{ row.subLabel }}</div>
                <div v-if="row.diffFields.length > 0" class="diff-line">
                  <el-tag type="danger" size="small" effect="plain">差异：{{ row.diffFields.join('、') }}</el-tag>
                </div>
                <div v-for="reason in blockers.get(row.key) ?? []" :key="reason" class="block-line">
                  <el-tag type="warning" size="small">⚠ {{ reason }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="逐项确认" width="330">
              <template #default="{ row }: { row: StagedItem }">
                <el-radio-group
                  :model-value="row.decision"
                  :disabled="active.status === 'writing' || active.status === 'done' || active.checkpoint.includes(row.key)"
                  size="small"
                  @change="(value: Decision) => decide(row, value)"
                >
                  <el-radio-button value="accept">并入</el-radio-button>
                  <el-radio-button value="skip">跳过</el-radio-button>
                  <el-radio-button v-if="row.match === 'conflict'" value="keepBoth">保留两边</el-radio-button>
                </el-radio-group>
                <el-tag v-if="active.checkpoint.includes(row.key)" type="success" size="small">已写入</el-tag>
                <el-button
                  v-else-if="row.match === 'conflict'"
                  link
                  type="primary"
                  size="small"
                  @click="openDiff(row)"
                >
                  对比两边版本
                </el-button>
              </template>
            </el-table-column>
          </el-table>
          <el-empty v-if="itemsOf(kind).length === 0" :image-size="50" description="本采集包不含此类数据" />
        </el-card>
      </template>
    </template>

    <el-dialog v-model="diffVisible" title="同一编号两边版本对比" width="760px">
      <template v-if="diffItem">
        <el-alert
          title="两边内容不同：可在列表中选择「并入（覆盖本地）」「跳过（保留本地）」或「保留两边」；保留两边会以新编号/新 id 入库，不覆盖本地版本。"
          type="info"
          :closable="false"
          class="diff-tip"
        />
        <el-table :data="fieldRows(diffItem)" border size="small" max-height="460">
          <el-table-column prop="label" label="字段" width="150" />
          <el-table-column label="本地版本">
            <template #default="{ row }: { row: { local: unknown; same: boolean } }">
              <span :class="{ 'cell-diff': !row.same }">{{ row.local }}</span>
            </template>
          </el-table-column>
          <el-table-column label="采集包版本">
            <template #default="{ row }: { row: { incoming: unknown; same: boolean } }">
              <span :class="{ 'cell-diff': !row.same }">{{ row.incoming }}</span>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.session-bar {
  margin-bottom: 12px;
}
.summary-card,
.kind-card {
  border-radius: 12px;
  margin-bottom: 14px;
}
.summary-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}
.summary-name {
  font-size: 15px;
  font-weight: 600;
}
.summary-tags {
  display: flex;
  gap: 6px;
}
.compat-alert {
  margin-top: 10px;
}
.checkpoint {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.err-text {
  color: #c0392b;
}
.summary-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.kind-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.kind-stats {
  display: flex;
  align-items: center;
  gap: 10px;
}
.item-name {
  font-weight: 600;
}
.diff-line,
.block-line {
  margin-top: 4px;
}
.diff-tip {
  margin-bottom: 10px;
}
.cell-diff {
  color: #c0392b;
  font-weight: 600;
}
</style>

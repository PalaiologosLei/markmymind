<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CalendarDays,
  Code2,
  FilePlus2,
  FolderOpen,
  Lock,
  LocateFixed,
  Plus,
  Save,
  Trash2,
  Unlock,
} from "lucide-vue-next";
import {
  addDays,
  addMonths,
  createSampleDocument,
  createSubtask,
  createTask,
  differenceInDays,
  endDate,
  ensureTaskSubtasks,
  normalizeDuration,
  normalizeProgress,
  parseGanttSource,
  parseIso,
  renderRangeAroundToday,
  serializeGanttDocument,
  statusColor,
  taskStart,
  todayIso,
  type GanttDocument,
  type GanttScale,
  type GanttStatus,
  type GanttSubtask,
  type GanttTask,
} from "./domain/gantt";

type DragMode = "move" | "resize";

interface DragState {
  taskId: string;
  subtaskId: string;
  mode: DragMode;
  startX: number;
  initialStart: string;
  initialDuration: number;
}

interface PanState {
  startX: number;
  startScrollLeft: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  taskId: string;
  subtaskId?: string;
  date?: string;
}

interface UnitSegment {
  key: string;
  label: string;
  start: string;
  end: string;
  days: number;
}

const TASK_ROW_HEIGHT = 72;

const doc = ref<GanttDocument>(createSampleDocument());
const currentPath = ref<string | null>(null);
const lastSavedSource = ref(serializeGanttDocument(doc.value));
const selectedTaskId = ref(doc.value.tasks[0]?.id ?? "");
const selectedSubtaskId = ref(doc.value.tasks[0]?.subtasks[0]?.id ?? "");
const statusMessage = ref("已创建新甘特图");
const warnings = ref<string[]>([]);
const sourcePanelOpen = ref(false);
const sourceDraft = ref("");
const dragState = ref<DragState | null>(null);
const panState = ref<PanState | null>(null);
const contextMenu = ref<ContextMenuState | null>(null);
const timelinePane = ref<HTMLElement | null>(null);

const scaleOptions: Array<{ value: GanttScale; label: string }> = [
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季" },
  { value: "year", label: "年" },
];

const statusOptions: Array<{ value: GanttStatus; label: string }> = [
  { value: "todo", label: "待办" },
  { value: "active", label: "进行中" },
  { value: "done", label: "完成" },
  { value: "critical", label: "关键" },
  { value: "milestone", label: "里程碑" },
];

const sourceText = computed(() => serializeGanttDocument(doc.value));
const isDirty = computed(() => sourceText.value !== lastSavedSource.value);
const orderedTasks = computed(() => doc.value.tasks);
const selectedTask = computed(() => doc.value.tasks.find((task) => task.id === selectedTaskId.value) ?? null);
const selectedSubtask = computed(() => {
  const task = selectedTask.value;

  if (!task) {
    return null;
  }

  return task.subtasks.find((subtask) => subtask.id === selectedSubtaskId.value) ?? task.subtasks[0] ?? null;
});

const renderRange = computed(() => renderRangeAroundToday());
const visibleStart = computed(() => renderRange.value.start);
const visibleDayCount = computed(() => renderRange.value.days);

const dayWidth = computed(() => {
  if (doc.value.view === "week") {
    return 96;
  }

  if (doc.value.view === "month") {
    return 54;
  }

  if (doc.value.view === "quarter") {
    return 14;
  }

  return 2.7;
});

const timelineWidth = computed(() => Math.ceil(visibleDayCount.value * dayWidth.value));
const rangeLabel = computed(() => `${formatDisplayDate(renderRange.value.start)} - ${formatDisplayDate(addDays(renderRange.value.end, -1))}`);

const yearSegments = computed<UnitSegment[]>(() => {
  const segments: UnitSegment[] = [];
  let cursor = renderRange.value.start;

  while (cursor < renderRange.value.end) {
    const start = cursor;
    const end = addMonths(start, 12);
    const date = parseIso(start);

    segments.push({
      key: start,
      label: `${date.getUTCFullYear()}年`,
      start,
      end,
      days: differenceInDays(start, end),
    });

    cursor = end;
  }

  return segments;
});

const unitSegments = computed<UnitSegment[]>(() => {
  const segments: UnitSegment[] = [];
  let cursor = renderRange.value.start;

  while (cursor < renderRange.value.end) {
    const start = cursor;
    const rawEnd = nextUnit(cursor);
    const end = rawEnd > renderRange.value.end ? renderRange.value.end : rawEnd;

    segments.push({
      key: `${doc.value.view}-${cursor}`,
      label: unitLabel(start, end),
      start,
      end,
      days: differenceInDays(start, end),
    });

    cursor = rawEnd;
  }

  return segments;
});

const todayLineStyle = computed(() => {
  const offset = differenceInDays(visibleStart.value, todayIso());

  if (offset < 0 || offset >= visibleDayCount.value) {
    return { display: "none" };
  }

  return {
    left: `${dateToX(todayIso()) + dayWidth.value / 2}px`,
  };
});

async function newDocument() {
  if (isDirty.value && !window.confirm("当前文件尚未保存，确定新建吗？")) {
    return;
  }

  doc.value = createSampleDocument();
  currentPath.value = null;
  selectTask(doc.value.tasks[0]);
  warnings.value = [];
  lastSavedSource.value = serializeGanttDocument(doc.value);
  refreshSourceDraft();
  statusMessage.value = "已创建新甘特图";
  await nextTick();
  jumpToToday();
}

async function openDocument() {
  const selected = await open({
    multiple: false,
    filters: [{ name: "Mermaid Gantt", extensions: ["mmd", "mermaid", "gantt"] }],
  });

  if (typeof selected !== "string") {
    return;
  }

  const content = await invoke<string>("read_gantt_file", { path: selected });
  const result = parseGanttSource(content);

  doc.value = result.doc;
  currentPath.value = selected;
  selectTask(doc.value.tasks[0]);
  warnings.value = result.warnings;
  lastSavedSource.value = content;
  refreshSourceDraft();
  statusMessage.value = `已打开 ${fileName(selected)}`;
  await nextTick();
  scrollToTaskRange();
}

async function saveDocument() {
  if (!currentPath.value) {
    await saveDocumentAs();
    return;
  }

  await invoke("write_gantt_file", { path: currentPath.value, content: sourceText.value });
  lastSavedSource.value = sourceText.value;
  statusMessage.value = `已保存 ${fileName(currentPath.value)}`;
}

async function saveDocumentAs() {
  const target = await save({
    defaultPath: currentPath.value ?? `${safeFileName(doc.value.title)}.mmd`,
    filters: [{ name: "Mermaid Gantt", extensions: ["mmd", "mermaid", "gantt"] }],
  });

  if (typeof target !== "string") {
    return;
  }

  currentPath.value = target;
  await saveDocument();
}

function addTask() {
  const section = doc.value.sections[0] ?? { id: "section-main", name: "默认分组" };

  if (!doc.value.sections.length) {
    doc.value.sections.push(section);
  }

  const start = selectedSubtask.value ? endDate(selectedSubtask.value) : todayIso();
  const task = createTask(section.id, doc.value.tasks.length + 1, start);
  doc.value.tasks.push(task);
  selectTask(task);
  statusMessage.value = "已添加任务";
}

function deleteSelectedTask() {
  const task = selectedTask.value;

  if (!task) {
    return;
  }

  doc.value.tasks = doc.value.tasks.filter((item) => item.id !== task.id);
  selectTask(doc.value.tasks[0]);
  statusMessage.value = `已删除 ${task.name}`;
}

function selectTask(task: GanttTask | undefined, subtask?: GanttSubtask) {
  if (!task) {
    selectedTaskId.value = "";
    selectedSubtaskId.value = "";
    return;
  }

  selectedTaskId.value = task.id;
  selectedSubtaskId.value = subtask?.id ?? ensureTaskSubtasks(task)[0]?.id ?? "";
}

function selectSubtask(task: GanttTask, subtask: GanttSubtask) {
  selectTask(task, subtask);
}

function setScale(scale: GanttScale) {
  const anchorDate = centeredTimelineDate();
  doc.value.view = scale;
  nextTick(() => scrollToDate(anchorDate, 0.5));
}

function jumpToToday() {
  scrollToDate(todayIso(), 0.45);
}

function scrollToTaskRange() {
  if (!doc.value.tasks.length) {
    jumpToToday();
    return;
  }

  const firstStart = doc.value.tasks.map(taskStart).sort()[0];
  scrollToDate(firstStart, 0.2);
}

function beginSubtaskDrag(event: PointerEvent, task: GanttTask, subtask: GanttSubtask, mode: DragMode) {
  if (task.locked) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  selectSubtask(task, subtask);

  dragState.value = {
    taskId: task.id,
    subtaskId: subtask.id,
    mode,
    startX: event.clientX,
    initialStart: subtask.start,
    initialDuration: subtask.duration,
  };

  window.addEventListener("pointermove", updateSubtaskDrag);
  window.addEventListener("pointerup", endSubtaskDrag, { once: true });
}

function updateSubtaskDrag(event: PointerEvent) {
  const drag = dragState.value;

  if (!drag) {
    return;
  }

  const task = doc.value.tasks.find((item) => item.id === drag.taskId);
  const subtask = task?.subtasks.find((item) => item.id === drag.subtaskId);

  if (!subtask) {
    return;
  }

  const deltaDays = Math.round((event.clientX - drag.startX) / dayWidth.value);

  if (drag.mode === "move") {
    subtask.start = addDays(drag.initialStart, deltaDays);
    return;
  }

  subtask.duration = normalizeDuration(drag.initialDuration + deltaDays);
}

function endSubtaskDrag() {
  dragState.value = null;
  window.removeEventListener("pointermove", updateSubtaskDrag);
}

function beginTimelinePan(event: PointerEvent) {
  const target = event.target as HTMLElement;

  if (target.closest("button, input, select, textarea, .context-menu")) {
    return;
  }

  const pane = timelinePane.value;

  if (!pane) {
    return;
  }

  contextMenu.value = null;
  panState.value = {
    startX: event.clientX,
    startScrollLeft: pane.scrollLeft,
  };
  pane.classList.add("panning");
  window.addEventListener("pointermove", updateTimelinePan);
  window.addEventListener("pointerup", endTimelinePan, { once: true });
}

function updateTimelinePan(event: PointerEvent) {
  const pan = panState.value;
  const pane = timelinePane.value;

  if (!pan || !pane) {
    return;
  }

  pane.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startX);
}

function endTimelinePan() {
  timelinePane.value?.classList.remove("panning");
  panState.value = null;
  window.removeEventListener("pointermove", updateTimelinePan);
}

function openContextMenu(event: MouseEvent, task: GanttTask, subtask?: GanttSubtask) {
  event.preventDefault();
  selectTask(task, subtask);
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    taskId: task.id,
    subtaskId: subtask?.id,
    date: dateFromTimelineEvent(event),
  };
}

function renameSubtask(task: GanttTask, subtask: GanttSubtask) {
  const nextName = window.prompt("编辑子任务名", subtask.name);

  if (!nextName) {
    return;
  }

  subtask.name = nextName.trim() || subtask.name;
  selectSubtask(task, subtask);
}

function closeContextMenu() {
  contextMenu.value = null;
}

function addSubtaskFromContext() {
  const task = contextTask();

  if (!task) {
    return;
  }

  const anchor = contextSubtask() ?? task.subtasks[task.subtasks.length - 1];
  const start = contextMenu.value?.date ?? anchor?.start ?? todayIso();
  const subtask = createSubtask(
    doc.value.tasks.indexOf(task) + 1,
    task.subtasks.length + 1,
    `子任务 ${task.subtasks.length + 1}`,
    start,
    task.color,
  );
  task.subtasks.push(subtask);
  selectSubtask(task, subtask);
  statusMessage.value = `已为 ${task.name} 添加子任务`;
  closeContextMenu();
}

function deleteSubtaskFromContext() {
  const task = contextTask();
  const subtask = contextSubtask();

  if (!task || !subtask || task.subtasks.length <= 1) {
    closeContextMenu();
    return;
  }

  task.subtasks = task.subtasks.filter((item) => item.id !== subtask.id);
  selectTask(task, task.subtasks[0]);
  statusMessage.value = `已删除子任务 ${subtask.name}`;
  closeContextMenu();
}

function contextTask() {
  return contextMenu.value ? doc.value.tasks.find((task) => task.id === contextMenu.value?.taskId) ?? null : null;
}

function contextSubtask() {
  const task = contextTask();

  if (!task || !contextMenu.value?.subtaskId) {
    return null;
  }

  return task.subtasks.find((subtask) => subtask.id === contextMenu.value?.subtaskId) ?? null;
}

function subtaskBarStyle(task: GanttTask, subtask: GanttSubtask) {
  const left = dateToX(subtask.start);
  const width = Math.max(dayWidth.value * normalizeDuration(subtask.duration), 34);

  return {
    left: `${left}px`,
    top: "21px",
    width: `${width}px`,
    background: subtask.color || task.color || statusColor(task.status),
  };
}

function rowStyle() {
  return {
    height: `${TASK_ROW_HEIGHT}px`,
  };
}

function segmentStyle(segment: UnitSegment) {
  return {
    width: `${Math.max(1, dateToX(segment.end) - dateToX(segment.start))}px`,
  };
}

function normalizeTask(task: GanttTask) {
  task.progress = normalizeProgress(task.progress);
}

function syncTaskColor(task: GanttTask) {
  if (!task.color || Object.values(statusColorMap()).includes(task.color)) {
    task.color = statusColor(task.status);
  }

  task.subtasks.forEach((subtask) => {
    if (!subtask.color || Object.values(statusColorMap()).includes(subtask.color)) {
      subtask.color = task.color;
    }
  });
}

function toggleTaskLock(task: GanttTask) {
  task.locked = !task.locked;
}

function toggleSourcePanel() {
  sourcePanelOpen.value = !sourcePanelOpen.value;
  refreshSourceDraft();
}

function refreshSourceDraft() {
  sourceDraft.value = sourceText.value;
}

function applySourceDraft() {
  const result = parseGanttSource(sourceDraft.value);

  doc.value = result.doc;
  warnings.value = result.warnings;
  selectTask(doc.value.tasks[0]);
  refreshSourceDraft();
  statusMessage.value = "源码已应用到图表";
  nextTick(() => scrollToTaskRange());
}

function nextUnit(iso: string) {
  if (doc.value.view === "quarter") {
    return addDays(iso, 7);
  }

  if (doc.value.view === "year") {
    return addMonths(iso, 1);
  }

  return addDays(iso, 1);
}

function unitLabel(start: string, end: string) {
  const date = parseIso(start);

  if (doc.value.view === "quarter") {
    return `${shortDate(start)}-${shortDate(addDays(end, -1))}`;
  }

  if (doc.value.view === "year") {
    return `${date.getUTCMonth() + 1}月`;
  }

  return shortDate(start);
}

function dateToX(iso: string) {
  return differenceInDays(visibleStart.value, iso) * dayWidth.value;
}

function xToDate(x: number) {
  const clampedX = Math.max(0, Math.min(timelineWidth.value, x));
  return addDays(visibleStart.value, Math.floor(clampedX / dayWidth.value));
}

function dateFromTimelineEvent(event: MouseEvent) {
  const pane = timelinePane.value;

  if (!pane || !pane.contains(event.target as Node)) {
    return undefined;
  }

  const rect = pane.getBoundingClientRect();
  return xToDate(pane.scrollLeft + event.clientX - rect.left);
}

function centeredTimelineDate() {
  const pane = timelinePane.value;

  if (!pane) {
    return todayIso();
  }

  return xToDate(pane.scrollLeft + pane.clientWidth / 2);
}

function scrollToDate(iso: string, viewportRatio: number) {
  const pane = timelinePane.value;

  if (!pane) {
    return;
  }

  const left = dateToX(iso) - pane.clientWidth * viewportRatio;
  pane.scrollLeft = Math.max(0, left);
}

function shortDate(iso: string): string {
  const date = parseIso(iso);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

function formatDisplayDate(iso: string): string {
  const date = parseIso(iso);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(
    date.getUTCDate(),
  ).padStart(2, "0")}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-") || "markmymind-gantt"
  );
}

function statusColorMap() {
  return {
    todo: statusColor("todo"),
    active: statusColor("active"),
    done: statusColor("done"),
    critical: statusColor("critical"),
    milestone: statusColor("milestone"),
  };
}
</script>

<template>
  <main class="app-shell" @click="closeContextMenu">
    <header class="topbar">
      <div class="brand">
        <CalendarDays :size="22" />
        <input v-model="doc.title" class="title-input" aria-label="甘特图标题" />
      </div>

      <div class="toolbar">
        <button type="button" title="新建" @click="newDocument">
          <FilePlus2 :size="17" />
          <span>新建</span>
        </button>
        <button type="button" title="打开" @click="openDocument">
          <FolderOpen :size="17" />
          <span>打开</span>
        </button>
        <button type="button" title="保存" @click="saveDocument">
          <Save :size="17" />
          <span>保存</span>
        </button>
        <button type="button" title="源码" :class="{ active: sourcePanelOpen }" @click="toggleSourcePanel">
          <Code2 :size="17" />
          <span>源码</span>
        </button>
      </div>

      <div class="file-state">
        <span class="path">{{ currentPath ?? "未保存文件" }}</span>
        <span v-if="isDirty" class="dirty-dot">未保存</span>
      </div>
    </header>

    <section class="workspace" :class="{ 'with-source': sourcePanelOpen }">
      <section class="gantt-surface">
        <div class="board-head">
          <div class="range-control">
            <button type="button" class="today-button" title="跳转到今天" @click="jumpToToday">
              <LocateFixed :size="17" />
              <span>今天</span>
            </button>
            <button type="button" class="range-label" title="跳到任务范围" @click="scrollToTaskRange">
              {{ rangeLabel }}
            </button>
          </div>

          <div class="scale-tabs" role="tablist" aria-label="时间视图">
            <button
              v-for="option in scaleOptions"
              :key="option.value"
              type="button"
              :class="{ active: doc.view === option.value }"
              @click="setScale(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="gantt-board">
          <aside class="task-table" @contextmenu.prevent="closeContextMenu">
            <div class="task-header">
              <span class="index-cell"></span>
              <span>任务名</span>
            </div>

            <div class="task-rows">
              <div
                v-for="(task, index) in orderedTasks"
                :key="task.id"
                class="task-row"
                :class="{ selected: task.id === selectedTaskId }"
                :style="rowStyle()"
                @click="selectTask(task)"
              >
                <span class="index-cell">{{ index + 1 }}</span>
                <input v-model="task.name" class="name-input main-name" aria-label="主任务名" @blur="normalizeTask(task)" />
              </div>
            </div>

            <button type="button" class="add-row" @click="addTask">
              <Plus :size="17" />
              <span>添加任务</span>
            </button>
          </aside>

          <section
            ref="timelinePane"
            class="timeline-pane"
            aria-label="甘特图时间轴"
            @pointerdown="beginTimelinePan"
          >
            <div class="timeline-content" :style="{ width: `${timelineWidth}px` }">
              <div class="year-row">
                <div v-for="segment in yearSegments" :key="segment.key" class="year-segment" :style="segmentStyle(segment)">
                  {{ segment.label }}
                </div>
              </div>

              <div class="unit-row">
                <div v-for="segment in unitSegments" :key="segment.key" class="unit-cell" :style="segmentStyle(segment)">
                  {{ segment.label }}
                </div>
              </div>

              <div class="timeline-body">
                <div
                  v-for="task in orderedTasks"
                  :key="task.id"
                  class="timeline-row"
                  :class="{ selected: task.id === selectedTaskId }"
                  :style="rowStyle()"
                  @click="selectTask(task)"
                  @contextmenu="openContextMenu($event, task)"
                >
                  <div class="today-line" :style="todayLineStyle"></div>
                  <div
                    v-for="segment in unitSegments"
                    :key="`${task.id}-${segment.key}`"
                    class="grid-unit"
                    :style="segmentStyle(segment)"
                  ></div>

                  <button
                    v-for="subtask in task.subtasks"
                    :key="subtask.id"
                    type="button"
                    class="subtask-bar"
                    :class="{ locked: task.locked, selected: subtask.id === selectedSubtaskId }"
                    :style="subtaskBarStyle(task, subtask)"
                    :title="`${task.name} / ${subtask.name}: ${subtask.start} - ${endDate(subtask)}`"
                    @click.stop="selectSubtask(task, subtask)"
                    @dblclick.stop="renameSubtask(task, subtask)"
                    @contextmenu.stop="openContextMenu($event, task, subtask)"
                    @pointerdown="beginSubtaskDrag($event, task, subtask, 'move')"
                  >
                    <span>{{ subtask.name }}</span>
                    <span>{{ subtask.duration }} 天</span>
                    <i class="resize-handle" title="调整工期" @pointerdown.stop="beginSubtaskDrag($event, task, subtask, 'resize')"></i>
                  </button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer class="task-inspector">
          <template v-if="selectedTask">
            <div class="inspector-field wide">
              <label>分组</label>
              <select v-model="selectedTask.sectionId">
                <option v-for="section in doc.sections" :key="section.id" :value="section.id">
                  {{ section.name }}
                </option>
              </select>
            </div>

            <div class="inspector-field">
              <label>状态</label>
              <select v-model="selectedTask.status" @change="syncTaskColor(selectedTask)">
                <option v-for="option in statusOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>

            <div class="inspector-field progress-field">
              <label>进度</label>
              <input v-model.number="selectedTask.progress" type="range" min="0" max="100" @input="normalizeTask(selectedTask)" />
              <span>{{ selectedTask.progress }}%</span>
            </div>

            <div v-if="selectedSubtask" class="inspector-field color-field">
              <label>子任务颜色</label>
              <input v-model="selectedSubtask.color" type="color" />
            </div>

            <button type="button" class="icon-command" :title="selectedTask.locked ? '解锁' : '锁定'" @click="toggleTaskLock(selectedTask)">
              <Lock v-if="selectedTask.locked" :size="17" />
              <Unlock v-else :size="17" />
            </button>

            <button type="button" class="danger-command" title="删除任务" @click="deleteSelectedTask">
              <Trash2 :size="17" />
            </button>
          </template>
        </footer>
      </section>

      <aside v-if="sourcePanelOpen" class="source-panel">
        <div class="source-head">
          <strong>Mermaid 源码</strong>
          <div class="source-actions">
            <button type="button" @click="refreshSourceDraft">刷新</button>
            <button type="button" class="primary" @click="applySourceDraft">应用</button>
          </div>
        </div>
        <textarea v-model="sourceDraft" spellcheck="false"></textarea>
        <div class="source-notes">
          <span>{{ statusMessage }}</span>
          <span v-if="warnings.length">{{ warnings.length }} 条解析提醒</span>
        </div>
      </aside>
    </section>

    <div
      v-if="contextMenu"
      class="context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="addSubtaskFromContext">添加子任务</button>
      <button type="button" :disabled="!contextMenu.subtaskId || (selectedTask?.subtasks.length ?? 0) <= 1" @click="deleteSubtaskFromContext">
        删除子任务
      </button>
    </div>
  </main>
</template>

<style>
:root {
  color: #202733;
  background: #f4f6f8;
  font-family:
    Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  font-size: 16px;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 980px;
  min-height: 100vh;
}

button,
input,
select,
textarea {
  font: inherit;
}

button {
  border: 1px solid #d8dee8;
  border-radius: 6px;
  background: #ffffff;
  color: #2f3947;
  cursor: pointer;
}

button:hover {
  border-color: #9fb0c8;
  background: #f8fafc;
}

button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

button.active,
button.primary {
  border-color: #2f6fed;
  background: #eaf1ff;
  color: #1c55c7;
}

.app-shell {
  display: flex;
  min-height: 100vh;
  flex-direction: column;
}

.topbar {
  display: grid;
  grid-template-columns: minmax(260px, 1fr) auto minmax(260px, 1fr);
  align-items: center;
  gap: 18px;
  height: 64px;
  padding: 0 18px;
  border-bottom: 1px solid #d9dee6;
  background: #ffffff;
}

.brand,
.toolbar,
.file-state,
.range-control,
.scale-tabs,
.source-actions {
  display: flex;
  align-items: center;
}

.brand {
  min-width: 0;
  gap: 10px;
}

.title-input {
  min-width: 0;
  width: 100%;
  border: 0;
  outline: 0;
  color: #1d2530;
  background: transparent;
  font-size: 18px;
  font-weight: 650;
}

.toolbar {
  gap: 8px;
}

.toolbar button,
.range-control button,
.source-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  padding: 0 10px;
  white-space: nowrap;
}

.file-state {
  min-width: 0;
  justify-content: flex-end;
  gap: 10px;
  color: #6b7480;
  font-size: 13px;
}

.path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dirty-dot {
  flex: 0 0 auto;
  border-radius: 999px;
  background: #fff4d8;
  color: #7a5420;
  padding: 2px 8px;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

.workspace.with-source {
  grid-template-columns: minmax(0, 1fr) 390px;
}

.gantt-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  background: #f8fafc;
}

.board-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 10px 14px;
  border-bottom: 1px solid #dbe1ea;
  background: #ffffff;
}

.range-control {
  gap: 8px;
}

.range-label {
  min-width: 260px;
  font-weight: 650;
}

.today-button {
  padding: 0 14px !important;
}

.scale-tabs {
  overflow: hidden;
  border: 1px solid #d8dee8;
  border-radius: 8px;
}

.scale-tabs button {
  height: 32px;
  min-width: 42px;
  border: 0;
  border-radius: 0;
  background: #ffffff;
}

.scale-tabs button.active {
  background: #dfeaff;
  color: #1959d1;
  font-weight: 700;
}

.gantt-board {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: 0;
  flex: 1;
  border-bottom: 1px solid #dbe1ea;
}

.task-table {
  min-width: 0;
  overflow: auto;
  border-right: 1px solid #dbe1ea;
  background: #ffffff;
}

.task-header,
.task-row {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
}

.task-header {
  position: sticky;
  top: 0;
  z-index: 5;
  height: 76px;
  padding: 0 12px;
  border-bottom: 1px solid #dbe1ea;
  color: #6c7581;
  background: #ffffff;
  font-size: 13px;
  font-weight: 700;
}

.task-row {
  padding: 8px 12px;
  border-bottom: 1px solid #edf1f5;
}

.task-row.selected {
  background: #eef4ff;
}

.index-cell {
  color: #8b95a1;
  text-align: right;
}

.name-input,
.date-input,
.duration-input,
.task-inspector input,
.task-inspector select {
  width: 100%;
  min-width: 0;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 6px;
  outline: 0;
  background: transparent;
  color: #27313d;
}

.main-name {
  font-weight: 700;
}

.date-input {
  flex: 0 0 132px;
  padding: 0 6px;
}

.duration-input {
  flex: 0 0 56px;
  text-align: center;
}

.name-input:focus,
.date-input:focus,
.duration-input:focus,
.task-inspector input:focus,
.task-inspector select:focus,
.name-input.active,
.date-input.active,
.duration-input.active {
  border-color: #9cb8f4;
  background: #ffffff;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: calc(100% - 24px);
  height: 38px;
  margin: 10px 12px;
  justify-content: center;
}

.timeline-pane {
  min-width: 0;
  overflow: auto;
  background: #ffffff;
  cursor: grab;
}

.timeline-pane.panning {
  cursor: grabbing;
  user-select: none;
}

.timeline-content {
  position: relative;
  min-width: 100%;
}

.year-row,
.unit-row {
  display: flex;
  position: sticky;
  z-index: 4;
  background: #ffffff;
}

.year-row {
  top: 0;
  height: 38px;
  border-bottom: 1px solid #edf1f5;
}

.unit-row {
  top: 38px;
  height: 38px;
  border-bottom: 1px solid #dbe1ea;
}

.year-segment,
.unit-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-right: 1px solid #edf1f5;
  color: #68727f;
  white-space: nowrap;
}

.year-segment {
  justify-content: flex-start;
  padding-left: 16px;
  font-weight: 700;
}

.unit-cell {
  font-size: 12px;
}

.timeline-body {
  position: relative;
}

.timeline-row {
  position: relative;
  display: flex;
  border-bottom: 1px solid #edf1f5;
  overflow: hidden;
}

.timeline-row.selected {
  background: rgba(47, 111, 237, 0.07);
}

.grid-unit {
  flex: 0 0 auto;
  height: 100%;
  border-right: 1px solid #edf1f5;
}

.today-line {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 2px;
  background: #5b7cfa;
  pointer-events: none;
}

.subtask-bar {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 30px;
  min-width: 34px;
  overflow: hidden;
  border: 0;
  border-radius: 7px;
  color: #ffffff;
  padding: 0 24px 0 11px;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 1px 2px rgba(22, 35, 52, 0.18);
  touch-action: none;
  cursor: grab;
}

.subtask-bar:hover {
  filter: brightness(1.02);
}

.subtask-bar.selected {
  outline: 2px solid rgba(38, 94, 210, 0.34);
  outline-offset: 1px;
}

.subtask-bar.locked {
  cursor: default;
  opacity: 0.72;
}

.subtask-bar span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resize-handle {
  position: absolute;
  top: 5px;
  right: 5px;
  bottom: 5px;
  width: 10px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.45);
  cursor: ew-resize;
}

.task-inspector {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 72px;
  padding: 10px 14px;
  background: #ffffff;
}

.inspector-field {
  display: grid;
  grid-template-columns: auto minmax(96px, 1fr);
  align-items: center;
  gap: 8px;
  min-width: 150px;
}

.inspector-field.wide {
  min-width: 220px;
}

.inspector-field label {
  color: #68727f;
  font-size: 13px;
  font-weight: 700;
}

.progress-field {
  grid-template-columns: auto minmax(120px, 1fr) 48px;
  min-width: 240px;
}

.color-field {
  min-width: 170px;
}

.color-field input {
  padding: 0;
}

.icon-command,
.danger-command {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
}

.danger-command {
  border-color: #f0c5c2;
  color: #bb302b;
}

.source-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  border-left: 1px solid #d9dee6;
  background: #ffffff;
}

.source-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 56px;
  padding: 0 14px;
  border-bottom: 1px solid #dbe1ea;
}

.source-actions {
  gap: 8px;
}

.source-panel textarea {
  min-height: 0;
  flex: 1;
  resize: none;
  border: 0;
  outline: 0;
  padding: 14px;
  color: #1f2937;
  background: #fbfcfe;
  font-family: "JetBrains Mono", Consolas, "SFMono-Regular", monospace;
  font-size: 13px;
  line-height: 1.55;
}

.source-notes {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  min-height: 38px;
  padding: 9px 14px;
  border-top: 1px solid #dbe1ea;
  color: #68727f;
  font-size: 12px;
}

.context-menu {
  position: fixed;
  z-index: 20;
  display: flex;
  width: 150px;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 32px rgba(30, 42, 58, 0.18);
}

.context-menu button {
  height: 36px;
  border: 0;
  border-radius: 0;
  text-align: left;
}

@media (max-width: 1180px) {
  .topbar {
    grid-template-columns: minmax(220px, 1fr) auto;
  }

  .file-state {
    display: none;
  }

  .gantt-board {
    grid-template-columns: 300px minmax(0, 1fr);
  }

  .task-header,
  .task-row {
    grid-template-columns: 40px minmax(0, 1fr);
  }
}
</style>

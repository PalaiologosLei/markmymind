<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  FilePlus2,
  Folder,
  FolderOpen,
  GripVertical,
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
  createSection,
  createSampleDocument,
  createSubtask,
  createTask,
  differenceInDays,
  endDate,
  normalizeDuration,
  parseGanttSource,
  parseIso,
  renderRangeAroundToday,
  serializeGanttDocument,
  taskStart,
  todayIso,
  type GanttDocument,
  type GanttSection,
  type GanttScale,
  type GanttSecondLevelSubtask,
  type GanttSubtask,
  type GanttTask,
} from "./domain/gantt";

type DragMode = "move" | "resize";

interface DragState {
  taskId: string;
  subtaskId: string;
  mode: DragMode;
  startX: number;
  pointerX: number;
  pointerY: number;
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

interface TaskListMenuState {
  x: number;
  y: number;
  target: "blank" | "task" | "section";
  taskId?: string;
  sectionId?: string;
}

type TaskListRow =
  | {
      type: "section";
      key: string;
      section: GanttSection;
    }
  | {
      type: "task";
      key: string;
      task: GanttTask;
      section: GanttSection | null;
      depth: 0 | 1;
    };

interface TaskListDragState {
  type: "task" | "section";
  id: string;
  rowKey: string;
}

interface TaskListDropTarget {
  kind: "top" | "section";
  index: number;
  indicator: "before" | "after" | "inside" | "end";
  rowKey?: string;
  sectionId?: string;
}

interface SubtaskLayout {
  left: number;
  width: number;
  height: number;
}

interface UnitSegment {
  key: string;
  label: string;
  start: string;
  end: string;
  days: number;
}

const TASK_ROW_HEIGHT = 82;
const SECTION_ROW_HEIGHT = 44;
const SUBTASK_BAR_TOP = 38;
const SUBTASK_META_TOP = 9;
const SUBTASK_ROW_BOTTOM = 12;
const EXPANDED_LINE_HEIGHT = 22;
const EXPANDED_VERTICAL_PADDING = 18;
const LAST_FILE_PATH_KEY = "markmymind:lastFilePath";
const DEFAULT_BAR_COLOR = "#9ac7ff";

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
const subtaskDropTargetId = ref<string | null>(null);
const panState = ref<PanState | null>(null);
const contextMenu = ref<ContextMenuState | null>(null);
const taskListMenu = ref<TaskListMenuState | null>(null);
const taskListDrag = ref<TaskListDragState | null>(null);
const taskListDropTarget = ref<TaskListDropTarget | null>(null);
const taskTablePane = ref<HTMLElement | null>(null);
const timelinePane = ref<HTMLElement | null>(null);
const editingSubtaskId = ref<string | null>(null);
const editingSubtaskText = ref("");
const subtaskTextEditor = ref<HTMLTextAreaElement | null>(null);
const copiedSubtask = ref<GanttSubtask | null>(null);
let syncingVerticalScroll = false;

const scaleOptions: Array<{ value: GanttScale; label: string }> = [
  { value: "day", label: "天" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季" },
  { value: "year", label: "年" },
];

const sourceText = computed(() => serializeGanttDocument(doc.value));
const isDirty = computed(() => sourceText.value !== lastSavedSource.value);
const sectionById = computed(() => new Map(doc.value.sections.map((section) => [section.id, section])));
const taskListRows = computed<TaskListRow[]>(() => {
  const rows: TaskListRow[] = [];
  const consumedSections = new Set<string>();
  const consumedRootTasks = new Set<string>();

  doc.value.outline.forEach((item) => {
    if (item.type === "section") {
      const section = sectionById.value.get(item.id);

      if (!section || consumedSections.has(section.id)) {
        return;
      }

      rows.push({ type: "section", key: `section-${section.id}`, section });
      consumedSections.add(section.id);

      if (!section.collapsed) {
        tasksInSection(section.id).forEach((task) => {
          rows.push({ type: "task", key: `task-${task.id}`, task, section, depth: 1 });
        });
      }

      return;
    }

    const task = doc.value.tasks.find((itemTask) => itemTask.id === item.id);

    if (task && !task.sectionId && !consumedRootTasks.has(task.id)) {
      rows.push({ type: "task", key: `task-${task.id}`, task, section: null, depth: 0 });
      consumedRootTasks.add(task.id);
    }
  });

  doc.value.sections.forEach((section) => {
    if (consumedSections.has(section.id)) {
      return;
    }

    rows.push({ type: "section", key: `section-${section.id}`, section });
    consumedSections.add(section.id);

    if (!section.collapsed) {
      tasksInSection(section.id).forEach((task) => {
        rows.push({ type: "task", key: `task-${task.id}`, task, section, depth: 1 });
      });
    }
  });

  doc.value.tasks.forEach((task) => {
    if (!task.sectionId && !consumedRootTasks.has(task.id)) {
      rows.push({ type: "task", key: `task-${task.id}`, task, section: null, depth: 0 });
      consumedRootTasks.add(task.id);
    }
  });

  return rows;
});
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
  if (doc.value.view === "day") {
    return 220;
  }

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

onMounted(async () => {
  window.addEventListener("keydown", handleGlobalKeydown);

  const restored = await restoreLastOpenedFile();
  await nextTick();

  if (!restored) {
    jumpToToday();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
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

  await loadDocumentFromPath(selected);
  window.localStorage.setItem(LAST_FILE_PATH_KEY, selected);
  await nextTick();
  scrollToTaskRange();
}

async function loadDocumentFromPath(path: string) {
  const content = await invoke<string>("read_gantt_file", { path });
  const result = parseGanttSource(content);

  doc.value = result.doc;
  currentPath.value = path;
  selectTask(doc.value.tasks[0]);
  warnings.value = result.warnings;
  lastSavedSource.value = content;
  refreshSourceDraft();
  statusMessage.value = `已打开 ${fileName(path)}`;
}

async function restoreLastOpenedFile() {
  const path = window.localStorage.getItem(LAST_FILE_PATH_KEY);

  if (!path) {
    return false;
  }

  try {
    await loadDocumentFromPath(path);
    await nextTick();
    jumpToToday();
    return true;
  } catch {
    window.localStorage.removeItem(LAST_FILE_PATH_KEY);
    statusMessage.value = "上次打开的文件不可用，已创建新甘特图";
    return false;
  }
}

async function saveDocument() {
  if (!currentPath.value) {
    await saveDocumentAs();
    return;
  }

  await invoke("write_gantt_file", { path: currentPath.value, content: sourceText.value });
  lastSavedSource.value = sourceText.value;
  window.localStorage.setItem(LAST_FILE_PATH_KEY, currentPath.value);
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

function addTask(sectionId = "") {
  const task = createTask(sectionId, doc.value.tasks.length + 1, todayIso());
  insertTaskIntoSection(task, sectionId, tasksInSection(sectionId).length);

  if (!sectionId) {
    doc.value.outline.push({ type: "task", id: task.id });
  }

  selectTask(task);
  statusMessage.value = "已添加任务";
}

function deleteSelectedTask() {
  const task = selectedTask.value;

  if (!task) {
    return;
  }

  deleteTask(task);
}

function deleteTask(task: GanttTask) {
  doc.value.tasks = doc.value.tasks.filter((item) => item.id !== task.id);
  doc.value.outline = doc.value.outline.filter((item) => !(item.type === "task" && item.id === task.id));

  if (selectedTaskId.value === task.id) {
    selectTask(firstVisibleTask());
  }

  statusMessage.value = `已删除 ${task.name}`;
}

function firstVisibleTask() {
  return taskListRows.value.find((row) => row.type === "task")?.task ?? doc.value.tasks[0];
}

function tasksInSection(sectionId: string) {
  return doc.value.tasks.filter((task) => task.sectionId === sectionId);
}

function insertTaskIntoSection(task: GanttTask, sectionId: string, index: number) {
  const existingIndex = doc.value.tasks.findIndex((item) => item.id === task.id);

  if (existingIndex >= 0) {
    doc.value.tasks.splice(existingIndex, 1);
  }

  task.sectionId = sectionId;

  const siblings = tasksInSection(sectionId);
  const clampedIndex = Math.max(0, Math.min(index, siblings.length));
  const beforeTask = siblings[clampedIndex];

  if (beforeTask) {
    doc.value.tasks.splice(doc.value.tasks.indexOf(beforeTask), 0, task);
    return;
  }

  const lastSibling = siblings[siblings.length - 1];

  if (lastSibling) {
    doc.value.tasks.splice(doc.value.tasks.indexOf(lastSibling) + 1, 0, task);
    return;
  }

  doc.value.tasks.push(task);
}

function selectTask(task: GanttTask | undefined, subtask?: GanttSubtask) {
  if (!task) {
    selectedTaskId.value = "";
    selectedSubtaskId.value = "";
    return;
  }

  selectedTaskId.value = task.id;
  selectedSubtaskId.value = subtask?.id ?? task.subtasks[0]?.id ?? "";
}

function selectSubtask(task: GanttTask, subtask: GanttSubtask) {
  selectTask(task, subtask);
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    finishSubtaskTextEdit();
    void saveDocument();
    return;
  }

  if (isEditableTarget(event.target)) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
    event.preventDefault();
    copySelectedSubtask();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
    event.preventDefault();
    pasteCopiedSubtask();
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    event.preventDefault();
    deleteSelectedSubtask();
  }
}

function copySelectedSubtask() {
  const subtask = selectedSubtask.value;

  if (!subtask) {
    return;
  }

  copiedSubtask.value = {
    ...subtask,
    children: subtask.children.map((child) => ({ ...child })),
  };
  statusMessage.value = `已复制子任务 ${subtask.name}`;
}

function pasteCopiedSubtask() {
  const source = copiedSubtask.value;
  const targetTask = selectedTask.value;

  if (!source || !targetTask) {
    return;
  }

  const subtask = createSubtask(
    doc.value.tasks.indexOf(targetTask) + 1,
    targetTask.subtasks.length + 1,
    source.name,
    endDate(source),
    source.color || targetTask.color,
  );
  subtask.duration = normalizeDuration(source.duration);
  subtask.completed = source.completed;
  subtask.expanded = source.children.length > 0 && source.expanded;
  subtask.children = source.children.map((child, index) => ({
    id: createSecondLevelId(subtask.id, index),
    name: child.name,
    completed: child.completed,
  }));
  targetTask.subtasks.push(subtask);
  selectSubtask(targetTask, subtask);
  statusMessage.value = `已粘贴子任务 ${subtask.name}`;
}

function deleteSelectedSubtask() {
  const task = selectedTask.value;
  const subtask = selectedSubtask.value;

  if (!task || !subtask) {
    return;
  }

  task.subtasks = task.subtasks.filter((item) => item.id !== subtask.id);
  selectTask(task, task.subtasks[0]);
  statusMessage.value = `已删除子任务 ${subtask.name}`;
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
    pointerX: event.clientX,
    pointerY: event.clientY,
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

  drag.pointerX = event.clientX;
  drag.pointerY = event.clientY;

  const task = doc.value.tasks.find((item) => item.id === drag.taskId);
  const subtask = task?.subtasks.find((item) => item.id === drag.subtaskId);

  if (!subtask) {
    subtaskDropTargetId.value = null;
    return;
  }

  subtaskDropTargetId.value = null;

  if (drag.mode === "move") {
    const targetTask = taskFromTimelinePoint(event.clientX, event.clientY);
    subtaskDropTargetId.value =
      targetTask && targetTask.id !== task?.id && !targetTask.locked ? targetTask.id : null;
  }

  const deltaDays = Math.round((event.clientX - drag.startX) / dayWidth.value);

  if (drag.mode === "move") {
    subtask.start = addDays(drag.initialStart, deltaDays);
    return;
  }

  subtask.duration = normalizeDuration(drag.initialDuration + deltaDays);
}

function endSubtaskDrag(event?: PointerEvent) {
  if (dragState.value?.mode === "move") {
    moveDraggedSubtaskToDropTarget(
      event ? { pointerX: event.clientX, pointerY: event.clientY } : dragState.value,
    );
  }

  dragState.value = null;
  subtaskDropTargetId.value = null;
  window.removeEventListener("pointermove", updateSubtaskDrag);
}

function moveDraggedSubtaskToDropTarget(pointer: Pick<DragState, "pointerX" | "pointerY">) {
  const drag = dragState.value;

  if (!drag) {
    return;
  }

  const sourceTask = doc.value.tasks.find((task) => task.id === drag.taskId);
  const targetTask = taskFromTimelinePoint(pointer.pointerX, pointer.pointerY);

  if (!sourceTask || !targetTask || sourceTask.id === targetTask.id || targetTask.locked) {
    return;
  }

  const subtaskIndex = sourceTask.subtasks.findIndex((subtask) => subtask.id === drag.subtaskId);

  if (subtaskIndex < 0) {
    return;
  }

  const [subtask] = sourceTask.subtasks.splice(subtaskIndex, 1);
  targetTask.subtasks.push(subtask);
  selectSubtask(targetTask, subtask);
  statusMessage.value = `已将子任务 ${subtask.name} 移动到 ${targetTask.name}`;
}

function taskFromTimelinePoint(clientX: number, clientY: number) {
  const pane = timelinePane.value;

  if (!pane) {
    return null;
  }

  const rect = pane.getBoundingClientRect();

  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }

  let yInBody = clientY - rect.top + pane.scrollTop - 76;

  if (yInBody < 0) {
    return null;
  }

  for (const row of taskListRows.value) {
    const height = taskListRowHeight(row);

    if (yInBody < height) {
      return row.type === "task" ? row.task : null;
    }

    yInBody -= height;
  }

  return null;
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

function syncTaskTableScroll() {
  if (syncingVerticalScroll || !taskTablePane.value || !timelinePane.value) {
    return;
  }

  syncingVerticalScroll = true;
  timelinePane.value.scrollTop = taskTablePane.value.scrollTop;
  requestAnimationFrame(() => {
    syncingVerticalScroll = false;
  });
}

function syncTimelineScroll() {
  if (syncingVerticalScroll || !taskTablePane.value || !timelinePane.value) {
    return;
  }

  syncingVerticalScroll = true;
  taskTablePane.value.scrollTop = timelinePane.value.scrollTop;
  requestAnimationFrame(() => {
    syncingVerticalScroll = false;
  });
}

function openContextMenu(event: MouseEvent, task: GanttTask, subtask?: GanttSubtask) {
  event.preventDefault();
  finishSubtaskTextEdit();
  taskListMenu.value = null;
  selectTask(task, subtask);
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    taskId: task.id,
    subtaskId: subtask?.id,
    date: dateFromTimelineEvent(event),
  };
}

function startSubtaskTextEdit(task: GanttTask, subtask: GanttSubtask) {
  selectSubtask(task, subtask);
  if (subtask.children.length > 0) {
    subtask.expanded = true;
  }
  editingSubtaskId.value = subtask.id;
  editingSubtaskText.value = [subtask.name, ...subtask.children.map((child) => child.name)].join("\n");
  nextTick(() => {
    subtaskTextEditor.value?.focus();
    subtaskTextEditor.value?.select();
  });
}

function finishSubtaskTextEdit() {
  if (!editingSubtaskId.value) {
    return;
  }

  const subtask = findSubtaskById(editingSubtaskId.value);

  if (subtask) {
    applySubtaskLocalText(subtask, editingSubtaskText.value);
  }

  editingSubtaskId.value = null;
  editingSubtaskText.value = "";
}

function cancelSubtaskTextEdit() {
  editingSubtaskId.value = null;
  editingSubtaskText.value = "";
}

function applySubtaskLocalText(subtask: GanttSubtask, text: string) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
  const nextName = lines[0] || subtask.name;
  const childNames = lines.slice(1).filter(Boolean);

  subtask.name = nextName;
  subtask.children = childNames.map((name, index) => ({
    id: subtask.children[index]?.id ?? createSecondLevelId(subtask.id, index),
    name,
    completed: subtask.children[index]?.completed ?? false,
  }));
  subtask.expanded = subtask.children.length > 0;
}

function setSubtaskCompleted(subtask: GanttSubtask, event: Event) {
  subtask.completed = (event.target as HTMLInputElement).checked;
}

function setSecondLevelCompleted(child: GanttSecondLevelSubtask, event: Event) {
  child.completed = (event.target as HTMLInputElement).checked;
}

function createSecondLevelId(subtaskId: string, index: number) {
  return `${subtaskId}-child-${Date.now().toString(36)}-${index + 1}`;
}

function findSubtaskById(id: string) {
  for (const task of doc.value.tasks) {
    const subtask = task.subtasks.find((item) => item.id === id);

    if (subtask) {
      return subtask;
    }
  }

  return null;
}

function toggleSubtaskExpanded(task: GanttTask, subtask: GanttSubtask) {
  selectSubtask(task, subtask);

  if (!subtask.children.length) {
    subtask.expanded = false;
    return;
  }

  if (subtask.expanded) {
    subtask.expanded = false;
    return;
  }

  const targetScale = expansionScaleForSubtask(subtask);
  if (doc.value.view !== targetScale) {
    doc.value.view = targetScale;
    nextTick(() => scrollToDate(subtask.start, 0.35));
  }

  subtask.expanded = true;
}

function expansionScaleForSubtask(subtask: GanttSubtask): GanttScale {
  const duration = normalizeDuration(subtask.duration);

  if (canRenderExpandedInScale(doc.value.view, duration)) {
    return doc.value.view;
  }

  if (duration <= 1) {
    return "day";
  }

  if (duration === 2) {
    return "week";
  }

  if (duration <= 9) {
    return "month";
  }

  return "quarter";
}

function closeContextMenu() {
  contextMenu.value = null;
  taskListMenu.value = null;
}

function openTaskListBlankMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;

  if (target.closest("[data-row-key], .context-menu")) {
    return;
  }

  event.preventDefault();
  finishSubtaskTextEdit();
  contextMenu.value = null;
  taskListMenu.value = {
    x: event.clientX,
    y: event.clientY,
    target: "blank",
  };
}

function openTaskListRowMenu(event: MouseEvent, row: TaskListRow) {
  event.preventDefault();
  finishSubtaskTextEdit();
  contextMenu.value = null;

  if (row.type === "task") {
    selectTask(row.task);
    taskListMenu.value = {
      x: event.clientX,
      y: event.clientY,
      target: "task",
      taskId: row.task.id,
      sectionId: row.task.sectionId || undefined,
    };
    return;
  }

  taskListMenu.value = {
    x: event.clientX,
    y: event.clientY,
    target: "section",
    sectionId: row.section.id,
  };
}

function addTaskFromListMenu() {
  const menu = taskListMenu.value;

  if (!menu || menu.target === "blank") {
    addTask();
    closeContextMenu();
    return;
  }

  if (menu.target === "section" && menu.sectionId) {
    addTask(menu.sectionId);
    closeContextMenu();
    return;
  }

  const anchorTask = menu.taskId ? doc.value.tasks.find((task) => task.id === menu.taskId) : null;

  if (!anchorTask) {
    addTask();
    closeContextMenu();
    return;
  }

  const task = createTask(anchorTask.sectionId, doc.value.tasks.length + 1, todayIso());
  const siblingIndex = tasksInSection(anchorTask.sectionId).findIndex((item) => item.id === anchorTask.id);
  insertTaskIntoSection(task, anchorTask.sectionId, siblingIndex + 1);

  if (!anchorTask.sectionId) {
    const outlineIndex = outlineIndexOfRootTask(anchorTask.id);
    doc.value.outline.splice(outlineIndex >= 0 ? outlineIndex + 1 : doc.value.outline.length, 0, {
      type: "task",
      id: task.id,
    });
  }

  selectTask(task);
  statusMessage.value = "已添加任务";
  closeContextMenu();
}

function addSectionFromListMenu() {
  const section = createSection(doc.value.sections.length + 1);
  const insertIndex = topInsertionIndexForMenu(taskListMenu.value);

  doc.value.sections.push(section);
  doc.value.outline.splice(insertIndex, 0, { type: "section", id: section.id });
  statusMessage.value = `已新建分组 ${section.name}`;
  closeContextMenu();
}

function deleteTaskFromListMenu() {
  const task = taskListMenu.value?.taskId
    ? doc.value.tasks.find((item) => item.id === taskListMenu.value?.taskId)
    : null;

  if (!task) {
    closeContextMenu();
    return;
  }

  if (!window.confirm(`确定删除任务“${task.name}”吗？`)) {
    closeContextMenu();
    return;
  }

  deleteTask(task);
  closeContextMenu();
}

function dissolveSectionFromListMenu() {
  const sectionId = taskListMenu.value?.sectionId;
  const section = sectionId ? sectionById.value.get(sectionId) : null;

  if (!section) {
    closeContextMenu();
    return;
  }

  const sectionTasks = tasksInSection(section.id);
  const outlineIndex = outlineIndexOfSection(section.id);

  sectionTasks.forEach((task) => {
    task.sectionId = "";
  });

  doc.value.sections = doc.value.sections.filter((item) => item.id !== section.id);
  doc.value.outline = doc.value.outline.filter((item) => !(item.type === "section" && item.id === section.id));

  const insertIndex = outlineIndex >= 0 ? outlineIndex : doc.value.outline.length;
  doc.value.outline.splice(
    insertIndex,
    0,
    ...sectionTasks.map((task) => ({ type: "task" as const, id: task.id })),
  );

  statusMessage.value = `已解散分组 ${section.name}`;
  closeContextMenu();
}

function toggleSectionCollapsed(section: GanttSection) {
  section.collapsed = !section.collapsed;
}

function setSelectedTaskSection(event: Event) {
  const task = selectedTask.value;
  const target = event.target as HTMLSelectElement;

  if (!task) {
    return;
  }

  moveTaskToSection(task, target.value);
}

function moveTaskToSection(task: GanttTask, sectionId: string) {
  if (task.sectionId === sectionId) {
    return;
  }

  doc.value.outline = doc.value.outline.filter((item) => !(item.type === "task" && item.id === task.id));
  insertTaskIntoSection(task, sectionId, tasksInSection(sectionId).length);

  if (!sectionId) {
    doc.value.outline.push({ type: "task", id: task.id });
  }

  selectTask(task);
  statusMessage.value = sectionId ? "已移动任务到分组" : "已移动任务到根目录";
}

function topInsertionIndexForMenu(menu: TaskListMenuState | null) {
  if (!menu || menu.target === "blank") {
    return doc.value.outline.length;
  }

  if (menu.target === "section" && menu.sectionId) {
    const index = outlineIndexOfSection(menu.sectionId);
    return index >= 0 ? index + 1 : doc.value.outline.length;
  }

  const task = menu.taskId ? doc.value.tasks.find((item) => item.id === menu.taskId) : null;

  if (!task) {
    return doc.value.outline.length;
  }

  if (!task.sectionId) {
    const index = outlineIndexOfRootTask(task.id);
    return index >= 0 ? index + 1 : doc.value.outline.length;
  }

  const sectionIndex = outlineIndexOfSection(task.sectionId);
  return sectionIndex >= 0 ? sectionIndex + 1 : doc.value.outline.length;
}

function beginTaskListDrag(event: PointerEvent, row: TaskListRow) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  finishSubtaskTextEdit();
  closeContextMenu();
  taskListDrag.value = {
    type: row.type,
    id: row.type === "section" ? row.section.id : row.task.id,
    rowKey: row.key,
  };
  taskListDropTarget.value = null;
  window.addEventListener("pointermove", updateTaskListDrag);
  window.addEventListener("pointerup", endTaskListDrag, { once: true });
}

function updateTaskListDrag(event: PointerEvent) {
  if (!taskListDrag.value) {
    return;
  }

  taskListDropTarget.value = resolveTaskListDropTarget(event);
}

function endTaskListDrag() {
  if (taskListDrag.value && taskListDropTarget.value) {
    applyTaskListDrop(taskListDrag.value, taskListDropTarget.value);
  }

  taskListDrag.value = null;
  taskListDropTarget.value = null;
  window.removeEventListener("pointermove", updateTaskListDrag);
}

function resolveTaskListDropTarget(event: PointerEvent): TaskListDropTarget | null {
  const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;

  if (!element?.closest(".task-table")) {
    return null;
  }

  const rowElement = element.closest("[data-row-key]") as HTMLElement | null;

  if (!rowElement) {
    return {
      kind: "top",
      index: doc.value.outline.length,
      indicator: "end",
    };
  }

  const row = taskListRows.value.find((item) => item.key === rowElement.dataset.rowKey);
  const drag = taskListDrag.value;

  if (!row || !drag) {
    return null;
  }

  const rect = rowElement.getBoundingClientRect();
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;

  if (row.type === "section") {
    const topIndex = outlineIndexOfSection(row.section.id);

    if (drag.type === "task" && ratio >= 0.28 && ratio <= 0.72) {
      return {
        kind: "section",
        sectionId: row.section.id,
        index: tasksInSection(row.section.id).length,
        indicator: "inside",
        rowKey: row.key,
      };
    }

    return {
      kind: "top",
      index: topIndex + (ratio >= 0.5 ? 1 : 0),
      indicator: ratio >= 0.5 ? "after" : "before",
      rowKey: row.key,
    };
  }

  if (row.task.sectionId) {
    if (drag.type === "section") {
      const sectionRowKey = `section-${row.task.sectionId}`;
      const sectionIndex = outlineIndexOfSection(row.task.sectionId);

      return {
        kind: "top",
        index: sectionIndex + (ratio >= 0.5 ? 1 : 0),
        indicator: ratio >= 0.5 ? "after" : "before",
        rowKey: sectionRowKey,
      };
    }

    const siblings = tasksInSection(row.task.sectionId);
    const siblingIndex = siblings.findIndex((task) => task.id === row.task.id);

    return {
      kind: "section",
      sectionId: row.task.sectionId,
      index: siblingIndex + (ratio >= 0.5 ? 1 : 0),
      indicator: ratio >= 0.5 ? "after" : "before",
      rowKey: row.key,
    };
  }

  const topIndex = outlineIndexOfRootTask(row.task.id);

  return {
    kind: "top",
    index: topIndex + (ratio >= 0.5 ? 1 : 0),
    indicator: ratio >= 0.5 ? "after" : "before",
    rowKey: row.key,
  };
}

function applyTaskListDrop(drag: TaskListDragState, target: TaskListDropTarget) {
  if (drag.type === "section") {
    applySectionDrop(drag.id, target);
    return;
  }

  applyTaskDrop(drag.id, target);
}

function applySectionDrop(sectionId: string, target: TaskListDropTarget) {
  if (target.kind !== "top") {
    return;
  }

  const sourceIndex = outlineIndexOfSection(sectionId);

  if (sourceIndex < 0) {
    return;
  }

  let insertIndex = target.index;
  doc.value.outline.splice(sourceIndex, 1);

  if (sourceIndex < insertIndex) {
    insertIndex -= 1;
  }

  insertIndex = Math.max(0, Math.min(insertIndex, doc.value.outline.length));
  doc.value.outline.splice(insertIndex, 0, { type: "section", id: sectionId });
}

function applyTaskDrop(taskId: string, target: TaskListDropTarget) {
  const task = doc.value.tasks.find((item) => item.id === taskId);

  if (!task) {
    return;
  }

  if (target.kind === "section" && target.sectionId) {
    const sourceSectionId = task.sectionId;
    const sourceIndex = tasksInSection(sourceSectionId).findIndex((item) => item.id === task.id);
    let targetIndex = target.index;

    if (sourceSectionId === target.sectionId && sourceIndex >= 0 && sourceIndex < targetIndex) {
      targetIndex -= 1;
    }

    doc.value.outline = doc.value.outline.filter((item) => !(item.type === "task" && item.id === task.id));
    insertTaskIntoSection(task, target.sectionId, targetIndex);
    selectTask(task);
    return;
  }

  let insertIndex = target.index;
  const sourceRootIndex = outlineIndexOfRootTask(task.id);

  doc.value.outline = doc.value.outline.filter((item) => !(item.type === "task" && item.id === task.id));

  if (sourceRootIndex >= 0 && sourceRootIndex < insertIndex) {
    insertIndex -= 1;
  }

  insertTaskIntoSection(task, "", tasksInSection("").length);
  insertIndex = Math.max(0, Math.min(insertIndex, doc.value.outline.length));
  doc.value.outline.splice(insertIndex, 0, { type: "task", id: task.id });
  selectTask(task);
}

function outlineIndexOfSection(sectionId: string) {
  return doc.value.outline.findIndex((item) => item.type === "section" && item.id === sectionId);
}

function outlineIndexOfRootTask(taskId: string) {
  return doc.value.outline.findIndex((item) => item.type === "task" && item.id === taskId);
}

function isTaskListDrop(row: TaskListRow, indicator: TaskListDropTarget["indicator"]) {
  return taskListDropTarget.value?.rowKey === row.key && taskListDropTarget.value.indicator === indicator;
}

function isTaskListDragging(row: TaskListRow) {
  return taskListDrag.value?.rowKey === row.key;
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

  if (!task || !subtask) {
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
  const layout = subtaskLayout(task, subtask);
  const color = subtask.color || task.color || DEFAULT_BAR_COLOR;

  return {
    left: `${layout.left}px`,
    top: `${SUBTASK_BAR_TOP}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`,
    background: color,
    color: readableTextColor(color),
    "--bar-color": color,
  };
}

function subtaskMetaStyle(task: GanttTask, subtask: GanttSubtask) {
  const layout = subtaskLayout(task, subtask);

  return {
    left: `${layout.left}px`,
    top: `${SUBTASK_META_TOP}px`,
  };
}

function taskListRowStyle(row: TaskListRow) {
  return {
    height: `${taskListRowHeight(row)}px`,
  };
}

function taskListRowHeight(row: TaskListRow) {
  return row.type === "section" ? SECTION_ROW_HEIGHT : taskRowHeight(row.task);
}

function taskNumber(task: GanttTask) {
  return doc.value.tasks.findIndex((item) => item.id === task.id) + 1;
}

function taskRowHeight(task: GanttTask) {
  return Math.max(
    TASK_ROW_HEIGHT,
    ...task.subtasks.map((subtask) => {
      const layout = subtaskLayout(task, subtask);
      return layout.height + SUBTASK_BAR_TOP + SUBTASK_ROW_BOTTOM;
    }),
  );
}

function subtaskLayout(task: GanttTask, target: GanttSubtask) {
  const layouts = subtaskLayouts(task);
  return layouts.get(target.id) ?? {
    left: dateToX(target.start),
    width: baseSubtaskWidth(target),
    height: 30,
  };
}

function subtaskLayouts(task: GanttTask) {
  const layouts = new Map<string, SubtaskLayout>();
  const ordered = [...task.subtasks].sort((first, second) => {
    const dateOrder = first.start.localeCompare(second.start);
    return dateOrder || task.subtasks.indexOf(first) - task.subtasks.indexOf(second);
  });
  let cursor = Number.NEGATIVE_INFINITY;
  let previous: GanttSubtask | null = null;

  ordered.forEach((subtask) => {
    const width = renderedSubtaskWidth(subtask);
    const naturalLeft = dateToX(subtask.start);
    const gap = previous && isPuzzleConnection(previous, subtask) ? 0 : 6;
    const left = Math.max(naturalLeft, cursor + gap);
    layouts.set(subtask.id, {
      left,
      width,
      height: renderedSubtaskHeight(subtask, width),
    });
    cursor = left + width;
    previous = subtask;
  });

  return layouts;
}

function hasPuzzleOut(task: GanttTask, subtask: GanttSubtask) {
  const ordered = orderedSubtasksForPuzzle(task);
  const index = ordered.findIndex((item) => item.id === subtask.id);
  return index >= 0 && index < ordered.length - 1 && isPuzzleConnection(subtask, ordered[index + 1]);
}

function hasPuzzleIn(task: GanttTask, subtask: GanttSubtask) {
  const ordered = orderedSubtasksForPuzzle(task);
  const index = ordered.findIndex((item) => item.id === subtask.id);
  return index > 0 && isPuzzleConnection(ordered[index - 1], subtask);
}

function orderedSubtasksForPuzzle(task: GanttTask) {
  return [...task.subtasks].sort((first, second) => {
    const dateOrder = first.start.localeCompare(second.start);
    return dateOrder || task.subtasks.indexOf(first) - task.subtasks.indexOf(second);
  });
}

function isPuzzleConnection(left: GanttSubtask, right: GanttSubtask) {
  return canRenderPuzzleConnections() && endDate(left) === right.start;
}

function canRenderPuzzleConnections() {
  return doc.value.view === "day" || doc.value.view === "week" || doc.value.view === "month";
}

function readableTextColor(color: string) {
  const rgb = parseHexColor(color);

  if (!rgb) {
    return "#ffffff";
  }

  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

  return luminance > 0.48 ? "#1f2937" : "#ffffff";
}

function parseHexColor(color: string): [number, number, number] | null {
  const normalized = color.trim().replace(/^#/, "");

  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return Array.from(normalized).map((char) => Number.parseInt(`${char}${char}`, 16)) as [number, number, number];
  }

  if (/^[0-9a-f]{6}$/i.test(normalized)) {
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }

  return null;
}

function baseSubtaskWidth(subtask: GanttSubtask) {
  return Math.max(dayWidth.value * normalizeDuration(subtask.duration), 34);
}

function renderedSubtaskWidth(subtask: GanttSubtask) {
  return baseSubtaskWidth(subtask);
}

function renderedSubtaskHeight(subtask: GanttSubtask, width: number) {
  if (editingSubtaskId.value === subtask.id) {
    const lineCount = Math.max(3, editingSubtaskText.value.split(/\r?\n/).length);
    return EXPANDED_VERTICAL_PADDING + lineCount * EXPANDED_LINE_HEIGHT;
  }

  if (!isSubtaskExpandedVisible(subtask)) {
    return 30;
  }

  const lineCount = expandedSubtaskLines(subtask).reduce((total, line) => total + wrappedLineCount(line, width - 58), 0);
  return Math.max(34, EXPANDED_VERTICAL_PADDING + lineCount * EXPANDED_LINE_HEIGHT);
}

function expandedSubtaskLines(subtask: GanttSubtask) {
  return [subtask.name, ...subtask.children.map((child) => child.name)];
}

function wrappedLineCount(text: string, width: number) {
  const charactersPerLine = Math.max(3, Math.floor(width / 12));
  return Math.max(1, Math.ceil(Array.from(text || " ").length / charactersPerLine));
}

function isSubtaskExpandedVisible(subtask: GanttSubtask) {
  return (
    subtask.expanded &&
    subtask.children.length > 0 &&
    canRenderExpandedInScale(doc.value.view, normalizeDuration(subtask.duration))
  );
}

function canRenderExpandedInScale(scale: GanttScale, duration: number) {
  if (scale === "day") {
    return true;
  }

  if (scale === "week") {
    return duration >= 2;
  }

  if (scale === "month") {
    return duration >= 3;
  }

  if (scale === "quarter") {
    return duration >= 10;
  }

  return false;
}

function segmentStyle(segment: UnitSegment) {
  return {
    width: `${Math.max(1, dateToX(segment.end) - dateToX(segment.start))}px`,
  };
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

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
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
          <aside ref="taskTablePane" class="task-table" @scroll="syncTaskTableScroll" @contextmenu.prevent="openTaskListBlankMenu">
            <div class="task-header">
              <span class="index-cell"></span>
              <span>任务 / 分组</span>
            </div>

            <div class="task-rows" :class="{ 'drop-at-end': taskListDropTarget?.indicator === 'end' }">
              <div
                v-for="row in taskListRows"
                :key="row.key"
                :data-row-key="row.key"
                class="task-row"
                :class="{
                  selected: row.type === 'task' && row.task.id === selectedTaskId,
                  'section-row': row.type === 'section',
                  'child-task-row': row.type === 'task' && row.depth === 1,
                  collapsed: row.type === 'section' && row.section.collapsed,
                  dragging: isTaskListDragging(row),
                  'drop-before': isTaskListDrop(row, 'before'),
                  'drop-after': isTaskListDrop(row, 'after'),
                  'drop-inside': isTaskListDrop(row, 'inside'),
                }"
                :style="taskListRowStyle(row)"
                @click="row.type === 'task' && selectTask(row.task)"
                @contextmenu.stop.prevent="openTaskListRowMenu($event, row)"
              >
                <template v-if="row.type === 'section'">
                  <button
                    type="button"
                    class="drag-handle"
                    title="拖动排序"
                    @pointerdown="beginTaskListDrag($event, row)"
                  >
                    <GripVertical :size="15" />
                  </button>
                  <button type="button" class="section-toggle" title="折叠/展开" @click.stop="toggleSectionCollapsed(row.section)">
                    <ChevronRight v-if="row.section.collapsed" :size="15" />
                    <ChevronDown v-else :size="15" />
                  </button>
                  <Folder :size="16" class="section-icon" />
                  <input v-model="row.section.name" class="name-input main-name section-name" aria-label="分组名" />
                </template>

                <template v-else>
                  <button
                    type="button"
                    class="drag-handle"
                    title="拖动排序"
                    @pointerdown="beginTaskListDrag($event, row)"
                  >
                    <GripVertical :size="15" />
                  </button>
                  <span class="index-cell">{{ taskNumber(row.task) }}</span>
                  <input v-model="row.task.name" class="name-input main-name" aria-label="主任务名" />
                  <input
                    v-model="row.task.color"
                    class="task-color-input"
                    type="color"
                    title="默认子任务颜色"
                    aria-label="默认子任务颜色"
                    @click.stop
                    @pointerdown.stop
                  />
                </template>
              </div>
            </div>

            <button type="button" class="add-row" @click="() => addTask()">
              <Plus :size="17" />
              <span>添加任务</span>
            </button>
          </aside>

          <section
            ref="timelinePane"
            class="timeline-pane"
            aria-label="甘特图时间轴"
            @scroll="syncTimelineScroll"
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
                  v-for="row in taskListRows"
                  :key="row.key"
                  class="timeline-row"
                  :class="{
                    selected: row.type === 'task' && row.task.id === selectedTaskId,
                    'section-timeline-row': row.type === 'section',
                    'subtask-drop-target': row.type === 'task' && row.task.id === subtaskDropTargetId,
                  }"
                  :style="taskListRowStyle(row)"
                  @click="row.type === 'task' && selectTask(row.task)"
                  @contextmenu="row.type === 'task' && openContextMenu($event, row.task)"
                >
                  <div class="today-line" :style="todayLineStyle"></div>
                  <div
                    v-for="segment in unitSegments"
                    :key="`${row.key}-${segment.key}`"
                    class="grid-unit"
                    :style="segmentStyle(segment)"
                  ></div>

                  <div
                    v-if="row.type === 'section'"
                    class="section-timeline-label"
                  >
                    {{ row.section.name }}
                  </div>

                  <template v-for="subtask in row.type === 'task' ? row.task.subtasks : []" :key="subtask.id">
                    <div
                      v-if="row.type === 'task'"
                      class="subtask-meta"
                      :style="subtaskMetaStyle(row.task, subtask)"
                    >
                      <button
                        type="button"
                        class="fold-button"
                        :class="{ disabled: !subtask.children.length }"
                        :title="subtask.expanded ? '折叠' : '展开'"
                        @click.stop="toggleSubtaskExpanded(row.task, subtask)"
                        @pointerdown.stop
                      >
                        <ChevronDown v-if="subtask.expanded && subtask.children.length" :size="16" />
                        <ChevronRight v-else :size="16" />
                      </button>
                      <span v-if="subtask.duration >= 3" class="duration-label">
                        {{ subtask.duration }} 天
                      </span>
                    </div>

                    <div
                      v-if="row.type === 'task'"
                      role="button"
                      tabindex="0"
                      class="subtask-bar"
                      :class="{
                        locked: row.task.locked,
                        selected: subtask.id === selectedSubtaskId,
                        expanded: isSubtaskExpandedVisible(subtask),
                        editing: editingSubtaskId === subtask.id,
                        'puzzle-out-right': hasPuzzleOut(row.task, subtask),
                        'puzzle-in-left': hasPuzzleIn(row.task, subtask),
                      }"
                      :style="subtaskBarStyle(row.task, subtask)"
                      :title="`${row.task.name} / ${subtask.name}: ${subtask.start} - ${endDate(subtask)}`"
                      @click.stop="selectSubtask(row.task, subtask)"
                      @dblclick.stop="startSubtaskTextEdit(row.task, subtask)"
                      @contextmenu.stop="openContextMenu($event, row.task, subtask)"
                      @pointerdown="beginSubtaskDrag($event, row.task, subtask, 'move')"
                    >
                      <textarea
                        v-if="editingSubtaskId === subtask.id"
                        ref="subtaskTextEditor"
                        v-model="editingSubtaskText"
                        class="subtask-text-editor"
                        aria-label="子任务局部编辑"
                        @blur="finishSubtaskTextEdit"
                        @click.stop
                        @dblclick.stop
                        @keydown.ctrl.enter.stop.prevent="finishSubtaskTextEdit"
                        @keydown.meta.enter.stop.prevent="finishSubtaskTextEdit"
                        @keydown.esc.stop.prevent="cancelSubtaskTextEdit"
                        @pointerdown.stop
                      ></textarea>
                      <button
                        v-if="editingSubtaskId === subtask.id"
                        type="button"
                        class="subtask-edit-save"
                        title="保存编辑"
                        @click.stop="finishSubtaskTextEdit"
                        @pointerdown.stop
                      >
                        <Check :size="18" />
                      </button>
                      <span v-else-if="isSubtaskExpandedVisible(subtask)" class="expanded-subtask-lines">
                        <span class="task-name-line primary-line" :class="{ completed: subtask.completed }">
                          <span class="task-name-text">{{ subtask.name }}</span>
                          <input
                            class="completion-checkbox"
                            type="checkbox"
                            :checked="subtask.completed"
                            aria-label="标记一级子任务完成"
                            @change="setSubtaskCompleted(subtask, $event)"
                            @click.stop
                            @pointerdown.stop
                          />
                        </span>
                        <span
                          v-for="child in subtask.children"
                          :key="child.id"
                          class="task-name-line secondary-line"
                          :class="{ completed: child.completed }"
                        >
                          <span class="task-name-text">{{ child.name }}</span>
                          <input
                            class="completion-checkbox"
                            type="checkbox"
                            :checked="child.completed"
                            aria-label="标记二级子任务完成"
                            @change="setSecondLevelCompleted(child, $event)"
                            @click.stop
                            @pointerdown.stop
                          />
                        </span>
                      </span>
                      <span v-else class="task-name-line primary-line" :class="{ completed: subtask.completed }">
                        <span class="task-name-text">{{ subtask.name }}</span>
                        <input
                          class="completion-checkbox"
                          type="checkbox"
                          :checked="subtask.completed"
                          aria-label="标记一级子任务完成"
                          @change="setSubtaskCompleted(subtask, $event)"
                          @click.stop
                          @pointerdown.stop
                        />
                      </span>
                      <i
                        v-if="editingSubtaskId !== subtask.id"
                        class="resize-handle"
                        title="调整工期"
                        @pointerdown.stop="beginSubtaskDrag($event, row.task, subtask, 'resize')"
                      ></i>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </section>
        </div>

        <footer class="task-inspector">
          <template v-if="selectedTask">
            <div class="inspector-field wide">
              <label>分组</label>
              <select :value="selectedTask.sectionId" @change="setSelectedTaskSection">
                <option value="">根目录</option>
                <option v-for="section in doc.sections" :key="section.id" :value="section.id">
                  {{ section.name }}
                </option>
              </select>
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
      <button type="button" :disabled="!contextMenu.subtaskId" @click="deleteSubtaskFromContext">
        删除子任务
      </button>
    </div>

    <div
      v-if="taskListMenu"
      class="context-menu task-list-menu"
      :style="{ left: `${taskListMenu.x}px`, top: `${taskListMenu.y}px` }"
      @click.stop
    >
      <button v-if="taskListMenu.target === 'task'" type="button" @click="deleteTaskFromListMenu">删除任务</button>
      <button type="button" @click="addTaskFromListMenu">新建任务</button>
      <button type="button" @click="addSectionFromListMenu">新建分组</button>
      <button type="button" :disabled="!taskListMenu.sectionId" @click="dissolveSectionFromListMenu">解散分组</button>
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

html,
body,
#app {
  height: 100%;
  overflow: hidden;
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
  height: 100vh;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
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
  overflow: hidden;
}

.workspace.with-source {
  grid-template-columns: minmax(0, 1fr) 390px;
}

.gantt-surface {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
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
  overflow: hidden;
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
  align-items: center;
  gap: 8px;
}

.task-header {
  grid-template-columns: 48px minmax(0, 1fr);
}

.task-row {
  position: relative;
  grid-template-columns: 26px 48px minmax(0, 1fr) 34px;
}

.task-row.section-row {
  grid-template-columns: 26px 26px 20px minmax(0, 1fr);
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

.task-row.dragging {
  opacity: 0.48;
}

.task-row.drop-before::before,
.task-row.drop-after::after {
  content: "";
  position: absolute;
  right: 12px;
  left: 12px;
  z-index: 2;
  height: 2px;
  border-radius: 999px;
  background: #2f6fed;
}

.task-row.drop-before::before {
  top: 0;
}

.task-row.drop-after::after {
  bottom: 0;
}

.task-row.drop-inside {
  background: #eaf1ff;
  outline: 2px solid rgba(47, 111, 237, 0.36);
  outline-offset: -2px;
}

.task-rows {
  position: relative;
}

.task-rows.drop-at-end::after {
  content: "";
  display: block;
  height: 2px;
  margin: 2px 12px;
  border-radius: 999px;
  background: #2f6fed;
}

.child-task-row .main-name {
  padding-left: 14px;
}

.index-cell {
  color: #8b95a1;
  text-align: right;
}

.drag-handle,
.section-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 5px;
  padding: 0;
  color: #7a8491;
  background: transparent;
}

.drag-handle {
  cursor: grab;
}

.drag-handle:active {
  cursor: grabbing;
}

.section-icon {
  color: #6b7480;
}

.section-row {
  background: #fbfcfe;
}

.section-row.collapsed {
  border-bottom-color: #dbe1ea;
}

.section-name {
  color: #1d2b3a;
}

.task-color-input {
  width: 30px;
  height: 28px;
  border: 1px solid #d8dee8;
  border-radius: 6px;
  padding: 2px;
  background: #ffffff;
  cursor: pointer;
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
  --row-bg: #ffffff;
}

.timeline-row.selected {
  background: rgba(47, 111, 237, 0.07);
  --row-bg: #eef4ff;
}

.timeline-row.subtask-drop-target {
  background: rgba(47, 111, 237, 0.1);
  outline: 2px solid rgba(47, 111, 237, 0.38);
  outline-offset: -2px;
}

.timeline-row.subtask-drop-target::after {
  content: "移动到此任务";
  position: absolute;
  left: 16px;
  top: 8px;
  z-index: 8;
  display: inline-flex;
  align-items: center;
  height: 26px;
  border: 1px solid rgba(47, 111, 237, 0.28);
  border-radius: 999px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.92);
  color: #1f56c7;
  font-size: 12px;
  font-weight: 700;
  pointer-events: none;
}

.section-timeline-row {
  background: #fbfcfe;
}

.section-timeline-label {
  position: sticky;
  left: 14px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  height: 100%;
  color: #68727f;
  font-size: 13px;
  font-weight: 700;
  pointer-events: none;
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
  --puzzle-radius: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: 30px;
  min-width: 34px;
  overflow: visible;
  border: 0;
  border-radius: 7px;
  color: #ffffff;
  padding: 0 24px 0 14px;
  font-size: 13px;
  font-weight: 700;
  box-shadow: 0 1px 2px rgba(22, 35, 52, 0.18);
  touch-action: none;
  cursor: grab;
}

.subtask-bar.puzzle-out-right {
  z-index: 4;
}

.subtask-bar.puzzle-out-right::after {
  content: "";
  position: absolute;
  top: calc((30px - var(--puzzle-radius) * 2) / 2);
  right: calc(var(--puzzle-radius) * -0.72);
  width: calc(var(--puzzle-radius) * 2);
  height: calc(var(--puzzle-radius) * 2);
  border-radius: 999px;
  background: var(--bar-color);
  box-shadow: 1px 0 1px rgba(22, 35, 52, 0.08);
  pointer-events: none;
}

.subtask-bar.puzzle-in-left {
  -webkit-mask-image: radial-gradient(
    circle var(--puzzle-radius) at 0 15px,
    transparent 0 calc(var(--puzzle-radius) - 0.5px),
    #000 var(--puzzle-radius)
  );
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-image: radial-gradient(
    circle var(--puzzle-radius) at 0 15px,
    transparent 0 calc(var(--puzzle-radius) - 0.5px),
    #000 var(--puzzle-radius)
  );
  mask-repeat: no-repeat;
  mask-size: 100% 100%;
}

.subtask-bar:hover {
  filter: brightness(1.02);
}

.subtask-bar.selected {
  outline: 2px solid rgba(38, 94, 210, 0.34);
  outline-offset: 1px;
  z-index: 5;
}

.subtask-bar.expanded {
  align-items: flex-start;
  padding-top: 6px;
  padding-bottom: 6px;
}

.subtask-bar.editing {
  align-items: stretch;
  padding: 8px 58px 8px 12px;
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

.subtask-bar > .primary-line {
  flex: 1 1 auto;
  justify-content: flex-start;
}

.subtask-meta {
  position: absolute;
  z-index: 6;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  pointer-events: none;
}

.fold-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 22px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #4c5561;
  padding: 0;
  pointer-events: auto;
  transition:
    background 0.15s ease,
    color 0.15s ease,
    transform 0.15s ease;
}

.fold-button:hover {
  background: #eef2f6;
  color: #1f2937;
}

.fold-button.disabled {
  opacity: 0.42;
}

.expanded-subtask-lines {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  overflow: visible !important;
  white-space: normal !important;
}

.task-name-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: 100%;
  min-width: 0;
}

.task-name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-name-line.completed .task-name-text {
  opacity: 0.78;
  text-decoration: line-through;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
}

.completion-checkbox {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  margin: 0;
  border-radius: 4px;
  opacity: 0;
  accent-color: #55c979;
  cursor: pointer;
  pointer-events: none;
  transition: opacity 0.12s ease;
}

.task-name-line:hover .completion-checkbox,
.completion-checkbox:focus-visible {
  opacity: 1;
  pointer-events: auto;
}

.primary-line,
.secondary-line {
  line-height: 18px;
  white-space: normal !important;
  overflow-wrap: anywhere;
}

.secondary-line {
  opacity: 0.88;
  font-weight: 600;
}

.secondary-line::before {
  content: "";
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.95;
}

.duration-label {
  display: inline-flex;
  align-items: center;
  height: 22px;
  flex: 0 0 auto;
  border: 1px solid #75a85e;
  border-radius: 6px;
  padding: 0 7px;
  background: #ffffff;
  color: #24303d;
  font-size: 14px;
  font-weight: 650;
  line-height: 1;
  box-shadow: 0 1px 1px rgba(22, 35, 52, 0.06);
}

.subtask-text-editor {
  min-width: 0;
  width: 100%;
  height: 100%;
  min-height: 58px;
  border: 0;
  border-radius: 5px;
  outline: 0;
  padding: 4px 6px;
  resize: none;
  color: #1e2b3a;
  background: rgba(255, 255, 255, 0.92);
  font-weight: 700;
  line-height: 18px;
}

.subtask-edit-save {
  position: absolute;
  top: 8px;
  right: 14px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 26px;
  border: 1px solid #75a85e;
  border-radius: 6px;
  background: #ffffff;
  color: #172033;
  padding: 0;
}

.subtask-edit-save:hover {
  border-color: #5f984b;
  background: #f8fff4;
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

.task-list-menu {
  width: 160px;
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

  .task-row {
    grid-template-columns: 24px 40px minmax(0, 1fr) 32px;
  }

  .task-row.section-row {
    grid-template-columns: 24px 24px 18px minmax(0, 1fr);
  }
}
</style>

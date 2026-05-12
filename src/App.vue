<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BookOpen,
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
  PaintBucket,
  Plus,
  Save,
  Settings,
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
  startOfWeek,
  taskStart,
  todayIso,
  type GanttDocument,
  type GanttLinkedItem,
  type GanttSection,
  type GanttScale,
  type GanttSecondLevelSubtask,
  type GanttSubtask,
  type GanttTask,
} from "./domain/gantt";

type DragMode = "move" | "resize";
type DragItemKind = "subtask" | "link";
type RecurrenceMode = "interval" | "weekly" | "monthly" | "yearly";

interface DragState {
  kind: DragItemKind;
  taskId: string;
  subtaskId: string;
  linkId?: string;
  mode: DragMode;
  startX: number;
  pointerX: number;
  pointerY: number;
  initialStart: string;
  initialDuration: number;
  initialLinkStarts?: Record<string, string>;
}

interface PanState {
  startX: number;
  startY: number;
  startScrollLeft: number;
  startScrollTop: number;
}

interface WeekNumberSegment extends UnitSegment {
  weekStart: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  taskId: string;
  subtaskId?: string;
  linkId?: string;
  date?: string;
}

interface TaskListMenuState {
  x: number;
  y: number;
  target: "blank" | "task" | "section";
  taskId?: string;
  sectionId?: string;
}

interface WeekNumberMenuState {
  x: number;
  y: number;
  weekStart: string;
}

interface RecurrenceDialogState {
  taskId: string;
  subtaskId: string;
  mode: RecurrenceMode;
  intervalDays: number;
  untilDate: string;
  weeklyDays: number[];
  monthlyDay: number;
  untilMonth: string;
  yearlyDatesText: string;
  untilYear: number;
  message: string;
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

interface AppSettings {
  defaultTaskColor: string;
  defaultSubtaskColor: string;
  dayScaleWidth: number;
  weekScaleWidth: number;
  monthScaleWidth: number;
  quarterScaleWidth: number;
  yearScaleWidth: number;
  rangeYearsBefore: number;
  rangeYearsAfter: number;
  autoSwitchViewOnExpand: boolean;
  showPuzzleJoins: boolean;
  restoreLastFile: boolean;
  collapsedBarHeight: number;
  collapsedBarFontSize: number;
  gridLineWidth: number;
  gridLineColor: string;
  gridLineOpacity: number;
  timeFlagFormat: "24h" | "12h";
  taskListLineWidth: number;
  taskListLineOpacity: number;
  showWeekNumberAxis: boolean;
  firstWeekStart: string;
  workdayBackground: string;
  weekendBackground: string;
  workdayBackgroundEnabled: boolean;
  weekendBackgroundEnabled: boolean;
  defaultSubtaskDuration: number;
}

const TASK_ROW_HEIGHT = 56;
const SECTION_ROW_HEIGHT = 44;
const SUBTASK_META_TOP = 4;
const SUBTASK_META_HEIGHT = 18;
const SUBTASK_META_BAR_GAP = 3;
const SUBTASK_BAR_TOP = SUBTASK_META_TOP + SUBTASK_META_HEIGHT + SUBTASK_META_BAR_GAP;
const SUBTASK_ROW_BOTTOM = 2;
const LINK_ROW_GAP = SUBTASK_META_HEIGHT + SUBTASK_META_BAR_GAP + 4;
const EXPANDED_LINE_HEIGHT = 22;
const EXPANDED_VERTICAL_PADDING = 18;
const LAST_FILE_PATH_KEY = "markmymind:lastFilePath";
const APP_SETTINGS_KEY = "markmymind:settings";
const DEFAULT_BAR_COLOR = "#9ac7ff";
const TIMELINE_HEADER_ROW_HEIGHT = 38;
const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultTaskColor: "#9ac7ff",
  defaultSubtaskColor: "#9ac7ff",
  dayScaleWidth: 220,
  weekScaleWidth: 96,
  monthScaleWidth: 54,
  quarterScaleWidth: 14,
  yearScaleWidth: 2.7,
  rangeYearsBefore: 5,
  rangeYearsAfter: 5,
  autoSwitchViewOnExpand: true,
  showPuzzleJoins: true,
  restoreLastFile: true,
  collapsedBarHeight: 30,
  collapsedBarFontSize: 13,
  gridLineWidth: 1,
  gridLineColor: "#edf1f5",
  gridLineOpacity: 1,
  timeFlagFormat: "24h",
  taskListLineWidth: 1,
  taskListLineOpacity: 1,
  showWeekNumberAxis: true,
  firstWeekStart: "2026-01-05",
  workdayBackground: "#ffffff",
  weekendBackground: "#f6f8fb",
  workdayBackgroundEnabled: false,
  weekendBackgroundEnabled: false,
  defaultSubtaskDuration: 1,
};

const doc = ref<GanttDocument>(createSampleDocument());
const appSettings = ref<AppSettings>(loadAppSettings());
const currentPath = ref<string | null>(null);
const lastSavedSource = ref(serializeGanttDocument(doc.value));
const selectedTaskId = ref(doc.value.tasks[0]?.id ?? "");
const selectedSubtaskId = ref(doc.value.tasks[0]?.subtasks[0]?.id ?? "");
const statusMessage = ref("已创建新甘特图");
const warnings = ref<string[]>([]);
const sourcePanelOpen = ref(false);
const settingsPanelOpen = ref(false);
const sourceDraft = ref("");
const dragState = ref<DragState | null>(null);
const subtaskDropTargetId = ref<string | null>(null);
const panState = ref<PanState | null>(null);
const contextMenu = ref<ContextMenuState | null>(null);
const taskListMenu = ref<TaskListMenuState | null>(null);
const weekNumberMenu = ref<WeekNumberMenuState | null>(null);
const recurrenceDialog = ref<RecurrenceDialogState | null>(null);
const taskListDrag = ref<TaskListDragState | null>(null);
const taskListDropTarget = ref<TaskListDropTarget | null>(null);
const taskTablePane = ref<HTMLElement | null>(null);
const timelinePane = ref<HTMLElement | null>(null);
const editingSubtaskId = ref<string | null>(null);
const editingSubtaskText = ref("");
const subtaskTextEditor = ref<HTMLTextAreaElement | null>(null);
const copiedSubtask = ref<GanttSubtask | null>(null);
const currentNow = ref(new Date());
let syncingVerticalScroll = false;
let titleRenameTimer: ReturnType<typeof setTimeout> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

const scaleOptions: Array<{ value: GanttScale; label: string }> = [
  { value: "day", label: "天" },
  { value: "week", label: "周" },
  { value: "month", label: "月" },
  { value: "quarter", label: "季" },
  { value: "year", label: "年" },
];
const weekdayOptions = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

const sourceText = computed(() => serializeGanttDocument(doc.value));
const isDirty = computed(() => sourceText.value !== lastSavedSource.value);
const sidePanelOpen = computed(() => sourcePanelOpen.value || settingsPanelOpen.value);
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
const selectedLinkContext = computed(() => {
  const task = selectedTask.value;

  if (!task) {
    return null;
  }

  for (const subtask of task.subtasks) {
    const link = subtask.links.find((item) => item.id === selectedSubtaskId.value);

    if (link) {
      return { task, parent: subtask, link };
    }
  }

  return null;
});
const selectedSubtask = computed(() => {
  const task = selectedTask.value;

  if (!task) {
    return null;
  }

  const exactSubtask = task.subtasks.find((subtask) => subtask.id === selectedSubtaskId.value);

  if (exactSubtask) {
    return exactSubtask;
  }

  return selectedLinkContext.value?.parent ?? task.subtasks[0] ?? null;
});
const selectedTimelineItem = computed<GanttSubtask | GanttLinkedItem | null>(
  () => selectedLinkContext.value?.link ?? selectedSubtask.value,
);
const subtaskDropPreview = computed(() => {
  const drag = dragState.value;

  if (!drag || drag.mode !== "move" || !subtaskDropTargetId.value) {
    return null;
  }

  const sourceTask = doc.value.tasks.find((task) => task.id === drag.taskId);
  const targetTask = doc.value.tasks.find((task) => task.id === subtaskDropTargetId.value);
  const subtask = sourceTask?.subtasks.find((item) => item.id === drag.subtaskId);

  if (!sourceTask || !targetTask || !subtask) {
    return null;
  }

  const layouts = buildSubtaskLayouts([...targetTask.subtasks, subtask]);
  const fallbackWidth = renderedSubtaskWidth(subtask);
  const layout = layouts.get(subtask.id) ?? {
    left: dateToX(subtask.start),
    width: fallbackWidth,
    height: renderedSubtaskHeight(subtask, fallbackWidth),
  };
  const color = subtask.color || targetTask.color || appSettings.value.defaultSubtaskColor || DEFAULT_BAR_COLOR;
  const previewColor = lightenColor(color, 0.46);

  return {
    targetTaskId: subtaskDropTargetId.value,
    name: subtask.name,
    style: {
      left: `${layout.left}px`,
      top: `${SUBTASK_BAR_TOP}px`,
      width: `${layout.width}px`,
      height: `${layout.height}px`,
      background: previewColor,
      color: readableTextColor(previewColor),
      "--bar-color": previewColor,
      "--bar-height": `${appSettings.value.collapsedBarHeight}px`,
      fontSize: `${appSettings.value.collapsedBarFontSize}px`,
    },
  };
});

const renderRange = computed(() =>
  renderRangeAroundToday(appSettings.value.rangeYearsBefore, appSettings.value.rangeYearsAfter),
);
const visibleStart = computed(() => renderRange.value.start);
const visibleDayCount = computed(() => renderRange.value.days);
const timelinePaneStyle = computed(() => ({
  "--grid-line-width": `${appSettings.value.gridLineWidth}px`,
  "--grid-line-color": colorWithOpacity(appSettings.value.gridLineColor, appSettings.value.gridLineOpacity),
}));
const taskTableStyle = computed(() => ({
  "--task-list-line-width": `${appSettings.value.taskListLineWidth}px`,
  "--task-list-line-color": colorWithOpacity("#dbe1ea", appSettings.value.taskListLineOpacity),
}));
const weekNumberAxisVisible = computed(
  () =>
    appSettings.value.showWeekNumberAxis &&
    (doc.value.view === "day" || doc.value.view === "week" || doc.value.view === "month"),
);
const timelineHeaderHeight = computed(
  () => TIMELINE_HEADER_ROW_HEIGHT * (weekNumberAxisVisible.value ? 3 : 2),
);
const taskHeaderStyle = computed(() => ({
  height: `${timelineHeaderHeight.value}px`,
}));
const currentDateIso = computed(() => localDateIso(currentNow.value));
const currentTimeLabel = computed(() => formatTimeFlag(currentNow.value, appSettings.value.timeFlagFormat));
const titleModel = computed({
  get: () => doc.value.title,
  set: (value: string) => updateDocumentTitle(value),
});

const dayWidth = computed(() => {
  if (doc.value.view === "day") {
    return appSettings.value.dayScaleWidth;
  }

  if (doc.value.view === "week") {
    return appSettings.value.weekScaleWidth;
  }

  if (doc.value.view === "month") {
    return appSettings.value.monthScaleWidth;
  }

  if (doc.value.view === "quarter") {
    return appSettings.value.quarterScaleWidth;
  }

  return appSettings.value.yearScaleWidth;
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

const weekNumberSegments = computed<WeekNumberSegment[]>(() => {
  const segments: WeekNumberSegment[] = [];
  let cursor = startOfWeek(renderRange.value.start);
  const firstWeekStart = startOfWeek(appSettings.value.firstWeekStart);

  while (cursor < renderRange.value.end) {
    const rawEnd = addDays(cursor, 7);
    const start = cursor < renderRange.value.start ? renderRange.value.start : cursor;
    const end = rawEnd > renderRange.value.end ? renderRange.value.end : rawEnd;
    const weekIndex = Math.floor(differenceInDays(firstWeekStart, cursor) / 7) + 1;

    segments.push({
      key: `week-number-${cursor}`,
      label: `${weekIndex}`,
      start,
      end,
      days: differenceInDays(start, end),
      weekStart: cursor,
    });

    cursor = rawEnd;
  }

  return segments;
});

const todayLineStyle = computed(() => {
  const offset = differenceInDays(visibleStart.value, currentDateIso.value);

  if (offset < 0 || offset >= visibleDayCount.value) {
    return { display: "none" };
  }

  return {
    left: `${dateToX(currentDateIso.value) + dayWidth.value * localDayProgress(currentNow.value)}px`,
    "--timeline-header-height": `${timelineHeaderHeight.value}px`,
  };
});

watch(
  appSettings,
  (value) => {
    const normalized = normalizeSettings(value);

    if (JSON.stringify(normalized) !== JSON.stringify(value)) {
      appSettings.value = normalized;
      return;
    }

    window.localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(normalized));
  },
  { deep: true },
);

onMounted(async () => {
  window.addEventListener("keydown", handleGlobalKeydown);
  currentNow.value = new Date();
  clockTimer = window.setInterval(() => {
    currentNow.value = new Date();
  }, 30_000);

  const restored = appSettings.value.restoreLastFile ? await restoreLastOpenedFile() : false;
  await nextTick();

  if (!restored) {
    jumpToToday();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleGlobalKeydown);
  if (titleRenameTimer) {
    window.clearTimeout(titleRenameTimer);
  }
  if (clockTimer) {
    window.clearInterval(clockTimer);
  }
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
  setTitleFromPath(path);
  currentPath.value = path;
  selectTask(doc.value.tasks[0]);
  warnings.value = result.warnings;
  lastSavedSource.value = sourceText.value;
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
  setTitleFromPath(target);
  await saveDocument();
}

function addTask(sectionId = "") {
  const task = createTask(sectionId, doc.value.tasks.length + 1, todayIso());
  task.color = appSettings.value.defaultTaskColor;
  insertTaskIntoSection(task, sectionId, tasksInSection(sectionId).length);

  if (!sectionId) {
    doc.value.outline.push({ type: "task", id: task.id });
  }

  selectTask(task);
  statusMessage.value = "已添加任务";
}

function applyTaskColorToSubtasks(task: GanttTask) {
  task.subtasks.forEach((subtask) => {
    subtask.color = task.color;
    subtask.links.forEach((link) => {
      link.color = linkedItemColor(subtask);
    });
  });
  statusMessage.value = "已应用默认颜色";
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

function selectLink(task: GanttTask, parent: GanttSubtask, link: GanttLinkedItem) {
  selectTask(task, parent);
  selectedSubtaskId.value = link.id;
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
    links: subtask.links.map((link) => ({
      ...link,
      children: link.children.map((child) => ({ ...child })),
    })),
  };
  statusMessage.value = `已复制子任务 ${subtask.name}`;
}

function pasteCopiedSubtask() {
  const source = copiedSubtask.value;
  const targetTask = selectedTask.value;

  if (!source || !targetTask) {
    return;
  }

  const subtask = cloneSubtaskForStart(targetTask, source, endDate(source), targetTask.subtasks.length);
  targetTask.subtasks.push(subtask);
  selectSubtask(targetTask, subtask);
  statusMessage.value = `已粘贴子任务 ${subtask.name}`;
}

function deleteSelectedSubtask() {
  const linkContext = selectedLinkContext.value;

  if (linkContext) {
    linkContext.parent.links = linkContext.parent.links.filter((item) => item.id !== linkContext.link.id);
    selectSubtask(linkContext.task, linkContext.parent);
    statusMessage.value = `已删除关联项 ${linkContext.link.name}`;
    return;
  }

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
    kind: "subtask",
    taskId: task.id,
    subtaskId: subtask.id,
    mode,
    startX: event.clientX,
    pointerX: event.clientX,
    pointerY: event.clientY,
    initialStart: subtask.start,
    initialDuration: subtask.duration,
    initialLinkStarts: Object.fromEntries(subtask.links.map((link) => [link.id, link.start])),
  };

  window.addEventListener("pointermove", updateSubtaskDrag);
  window.addEventListener("pointerup", endSubtaskDrag, { once: true });
}

function beginLinkDrag(
  event: PointerEvent,
  task: GanttTask,
  subtask: GanttSubtask,
  link: GanttLinkedItem,
  mode: DragMode,
) {
  if (task.locked) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  selectSubtask(task, subtask);
  selectedSubtaskId.value = link.id;

  dragState.value = {
    kind: "link",
    taskId: task.id,
    subtaskId: subtask.id,
    linkId: link.id,
    mode,
    startX: event.clientX,
    pointerX: event.clientX,
    pointerY: event.clientY,
    initialStart: link.start,
    initialDuration: link.duration,
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
  const link = subtask && drag.kind === "link" ? subtask.links.find((item) => item.id === drag.linkId) : null;

  if (!subtask || (drag.kind === "link" && !link)) {
    subtaskDropTargetId.value = null;
    return;
  }

  subtaskDropTargetId.value = null;

  if (drag.mode === "move" && drag.kind === "subtask") {
    const targetTask = taskFromTimelinePoint(event.clientX, event.clientY);
    subtaskDropTargetId.value =
      targetTask && targetTask.id !== task?.id && !targetTask.locked ? targetTask.id : null;
  }

  const deltaDays = Math.round((event.clientX - drag.startX) / dayWidth.value);

  if (drag.kind === "link" && link) {
    updateLinkedItemDrag(subtask, link, drag, deltaDays);
    return;
  }

  if (drag.mode === "move") {
    subtask.start = addDays(drag.initialStart, deltaDays);
    subtask.links.forEach((item) => {
      const initialStart = drag.initialLinkStarts?.[item.id] ?? item.start;
      item.start = clampLinkStart(subtask, item, addDays(initialStart, deltaDays));
    });
    return;
  }

  const requestedDuration = normalizeDuration(drag.initialDuration + deltaDays);
  const minimumDuration = minimumSubtaskDurationForLinks(subtask);
  subtask.duration = Math.max(requestedDuration, minimumDuration);
  if (requestedDuration < minimumDuration) {
    statusMessage.value = "请先删除或调整关联项，再继续缩短一级子任务";
  }
}

function endSubtaskDrag(event?: PointerEvent) {
  if (dragState.value?.kind === "subtask" && dragState.value.mode === "move") {
    moveDraggedSubtaskToDropTarget(
      event ? { pointerX: event.clientX, pointerY: event.clientY } : dragState.value,
    );
  }

  dragState.value = null;
  subtaskDropTargetId.value = null;
  window.removeEventListener("pointermove", updateSubtaskDrag);
}

function updateLinkedItemDrag(
  parent: GanttSubtask,
  link: GanttLinkedItem,
  drag: DragState,
  deltaDays: number,
) {
  if (drag.mode === "move") {
    const nextStart = clampLinkStart(parent, link, addDays(drag.initialStart, deltaDays));
    if (!linkConflicts(parent, link, nextStart, link.duration)) {
      link.start = nextStart;
    }
    return;
  }

  const parentEnd = endDate(parent);
  const maxDuration = Math.max(1, differenceInDays(link.start, parentEnd));
  const nextDuration = Math.min(normalizeDuration(drag.initialDuration + deltaDays), maxDuration);
  if (!linkConflicts(parent, link, link.start, nextDuration)) {
    link.duration = nextDuration;
  }
}

function clampLinkStart(parent: GanttSubtask, link: GanttLinkedItem, start: string) {
  const latestStart = addDays(endDate(parent), -Math.min(normalizeDuration(link.duration), normalizeDuration(parent.duration)));

  if (start < parent.start) {
    return parent.start;
  }

  if (start > latestStart) {
    return latestStart;
  }

  return start;
}

function minimumSubtaskDurationForLinks(subtask: GanttSubtask) {
  const requiredEnds = subtask.links.map((link) => differenceInDays(subtask.start, endDate(link)));
  return Math.max(1, ...requiredEnds);
}

function linkConflicts(parent: GanttSubtask, link: GanttLinkedItem, start: string, duration: number) {
  const end = addDays(start, normalizeDuration(duration));

  return parent.links.some((sibling) => {
    if (sibling.id === link.id) {
      return false;
    }

    return start < endDate(sibling) && end > sibling.start;
  });
}

function firstAvailableLinkStart(parent: GanttSubtask, preferredStart: string, duration: number) {
  const link = { id: "__new__", duration: normalizeDuration(duration) } as GanttLinkedItem;
  const clampedPreferred = clampLinkStart(parent, link, preferredStart);

  if (!linkConflicts(parent, link, clampedPreferred, link.duration)) {
    return clampedPreferred;
  }

  const maxOffset = Math.max(0, normalizeDuration(parent.duration) - link.duration);

  for (let offset = 0; offset <= maxOffset; offset += 1) {
    const start = addDays(parent.start, offset);

    if (!linkConflicts(parent, link, start, link.duration)) {
      return start;
    }
  }

  return "";
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

  let yInBody = clientY - rect.top + pane.scrollTop - timelineHeaderHeight.value;

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

  closeContextMenu();
  panState.value = {
    startX: event.clientX,
    startY: event.clientY,
    startScrollLeft: pane.scrollLeft,
    startScrollTop: pane.scrollTop,
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
  pane.scrollTop = pan.startScrollTop - (event.clientY - pan.startY);
  syncTimelineScroll();
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

function scrollTaskTableWheel(event: WheelEvent) {
  const pane = timelinePane.value;

  if (!pane) {
    return;
  }

  pane.scrollTop += event.deltaY;
  pane.scrollLeft += event.deltaX;
  syncTimelineScroll();
}

function openContextMenu(event: MouseEvent, task: GanttTask, subtask?: GanttSubtask) {
  event.preventDefault();
  finishSubtaskTextEdit();
  taskListMenu.value = null;
  weekNumberMenu.value = null;
  selectTask(task, subtask);
  const date = dateFromTimelineEvent(event);
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    taskId: task.id,
    subtaskId: subtask?.id,
    date,
  };
}

function openLinkContextMenu(event: MouseEvent, task: GanttTask, subtask: GanttSubtask, link: GanttLinkedItem) {
  event.preventDefault();
  finishSubtaskTextEdit();
  taskListMenu.value = null;
  weekNumberMenu.value = null;
  selectSubtask(task, subtask);
  selectedSubtaskId.value = link.id;
  contextMenu.value = {
    x: event.clientX,
    y: event.clientY,
    taskId: task.id,
    subtaskId: subtask.id,
    linkId: link.id,
    date: dateFromTimelineEvent(event),
  };
}

function startSubtaskTextEdit(task: GanttTask, subtask: GanttSubtask) {
  selectSubtask(task, subtask);
  ensureSubtaskInteractionScale(subtask);
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

function startLinkTextEdit(task: GanttTask, parent: GanttSubtask, link: GanttLinkedItem) {
  selectSubtask(task, parent);
  selectedSubtaskId.value = link.id;
  ensureSubtaskInteractionScale(link);
  if (link.children.length > 0) {
    link.expanded = true;
  }
  editingSubtaskId.value = link.id;
  editingSubtaskText.value = [link.name, ...link.children.map((child) => child.name)].join("\n");
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

function applySubtaskLocalText(subtask: GanttSubtask | GanttLinkedItem, text: string) {
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

function setSubtaskCompleted(subtask: GanttSubtask | GanttLinkedItem, event: Event) {
  subtask.completed = (event.target as HTMLInputElement).checked;
}

function setSecondLevelCompleted(child: GanttSecondLevelSubtask, event: Event) {
  child.completed = (event.target as HTMLInputElement).checked;
}

function createSecondLevelId(subtaskId: string, index: number) {
  return `${subtaskId}-child-${Date.now().toString(36)}-${index + 1}`;
}

function createLinkId(subtaskId: string, index: number) {
  return `${subtaskId}-link-${Date.now().toString(36)}-${index + 1}`;
}

function findSubtaskById(id: string) {
  for (const task of doc.value.tasks) {
    const subtask = task.subtasks.find((item) => item.id === id);

    if (subtask) {
      return subtask;
    }

    for (const parent of task.subtasks) {
      const link = parent.links.find((item) => item.id === id);

      if (link) {
        return link;
      }
    }
  }

  return null;
}

function toggleSubtaskExpanded(task: GanttTask, subtask: GanttSubtask | GanttLinkedItem, parent?: GanttSubtask) {
  if (parent) {
    selectSubtask(task, parent);
    selectedSubtaskId.value = subtask.id;
  } else {
    selectSubtask(task, subtask as GanttSubtask);
  }

  if (!subtask.children.length) {
    subtask.expanded = false;
    return;
  }

  if (subtask.expanded) {
    subtask.expanded = false;
    return;
  }

  ensureSubtaskInteractionScale(subtask);
  subtask.expanded = true;
}

function ensureSubtaskInteractionScale(subtask: GanttSubtask | GanttLinkedItem) {
  if (!appSettings.value.autoSwitchViewOnExpand) {
    return;
  }

  const targetScale = expansionScaleForSubtask(subtask);

  if (doc.value.view !== targetScale) {
    doc.value.view = targetScale;
    nextTick(() => scrollToDate(subtask.start, 0.35));
  }
}

function expansionScaleForSubtask(subtask: GanttSubtask | GanttLinkedItem): GanttScale {
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
  weekNumberMenu.value = null;
}

function openTaskListBlankMenu(event: MouseEvent) {
  const target = event.target as HTMLElement;

  if (target.closest("[data-row-key], .context-menu")) {
    return;
  }

  event.preventDefault();
  finishSubtaskTextEdit();
  contextMenu.value = null;
  weekNumberMenu.value = null;
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
  weekNumberMenu.value = null;

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
  task.color = appSettings.value.defaultTaskColor;
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
    "子任务",
    start,
    task.color || appSettings.value.defaultSubtaskColor,
  );
  subtask.duration = normalizeDuration(appSettings.value.defaultSubtaskDuration);
  task.subtasks.push(subtask);
  selectSubtask(task, subtask);
  statusMessage.value = `已为 ${task.name} 添加子任务`;
  closeContextMenu();
}

function addLinkFromContext() {
  const task = contextTask();
  const subtask = contextSubtask();

  if (!task || !subtask) {
    closeContextMenu();
    return;
  }

  const start = firstAvailableLinkStart(subtask, contextMenu.value?.date ?? subtask.start, 1);

  if (!start) {
    statusMessage.value = "当前一级子任务下方没有空间创建新的关联项";
    closeContextMenu();
    return;
  }

  const link: GanttLinkedItem = {
    id: createLinkId(subtask.id, subtask.links.length),
    name: "关联项",
    start,
    duration: 1,
    color: linkedItemColor(subtask),
    completed: false,
    expanded: false,
    children: [],
  };

  subtask.links.push(link);
  selectSubtask(task, subtask);
  selectedSubtaskId.value = link.id;
  statusMessage.value = `已为 ${subtask.name} 添加关联项`;
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

function deleteLinkFromContext() {
  const task = contextTask();
  const subtask = contextSubtask();
  const link = contextLink();

  if (!task || !subtask || !link) {
    closeContextMenu();
    return;
  }

  subtask.links = subtask.links.filter((item) => item.id !== link.id);
  selectSubtask(task, subtask);
  statusMessage.value = `已删除关联项 ${link.name}`;
  closeContextMenu();
}

function openRecurrenceDialogFromContext() {
  const task = contextTask();
  const subtask = contextSubtask();

  if (!task || !subtask || contextMenu.value?.linkId) {
    closeContextMenu();
    return;
  }

  const startDate = parseIso(subtask.start);
  const startYear = startDate.getUTCFullYear();
  const startMonth = String(startDate.getUTCMonth() + 1).padStart(2, "0");
  const startDay = startDate.getUTCDate();
  recurrenceDialog.value = {
    taskId: task.id,
    subtaskId: subtask.id,
    mode: "interval",
    intervalDays: Math.max(1, normalizeDuration(subtask.duration)),
    untilDate: addDays(subtask.start, Math.max(7, normalizeDuration(subtask.duration) * 4)),
    weeklyDays: [startDate.getUTCDay()],
    monthlyDay: startDay,
    untilMonth: addMonths(subtask.start, 12).slice(0, 7),
    yearlyDatesText: `${startMonth}-${String(startDay).padStart(2, "0")}`,
    untilYear: startYear + 1,
    message: "",
  };
  closeContextMenu();
}

function closeRecurrenceDialog() {
  recurrenceDialog.value = null;
}

function toggleRecurrenceWeekday(day: number) {
  const dialog = recurrenceDialog.value;

  if (!dialog) {
    return;
  }

  dialog.weeklyDays = dialog.weeklyDays.includes(day)
    ? dialog.weeklyDays.filter((item) => item !== day)
    : [...dialog.weeklyDays, day].sort((first, second) => first - second);
}

function applyRecurrenceDialog() {
  const dialog = recurrenceDialog.value;
  const task = dialog ? doc.value.tasks.find((item) => item.id === dialog.taskId) : null;
  const source = task?.subtasks.find((item) => item.id === dialog?.subtaskId);

  if (!dialog || !task || !source) {
    recurrenceDialog.value = null;
    return;
  }

  const startsResult = recurringStarts(dialog, source);

  if (!startsResult.ok) {
    dialog.message = startsResult.message;
    return;
  }

  const starts = uniqueSortedDates(startsResult.starts);

  if (!starts.length) {
    dialog.message = "没有符合条件的重复日期。";
    return;
  }

  const conflict = recurrenceConflict(task, source, starts);

  if (conflict) {
    dialog.message = conflict;
    return;
  }

  const baseIndex = task.subtasks.length;
  const copies = starts.map((start, index) => cloneSubtaskForStart(task, source, start, baseIndex + index));
  task.subtasks.push(...copies);
  selectSubtask(task, copies[copies.length - 1]);
  statusMessage.value = `已生成 ${copies.length} 个重复子任务`;
  recurrenceDialog.value = null;
}

function recurringStarts(
  dialog: RecurrenceDialogState,
  source: GanttSubtask,
): { ok: true; starts: string[] } | { ok: false; message: string } {
  if (dialog.mode === "interval") {
    const interval = Math.round(Number(dialog.intervalDays));

    if (interval < 1) {
      return { ok: false, message: "重复间隔必须大于等于 1 天。" };
    }

    if (!isIsoDateInput(dialog.untilDate)) {
      return { ok: false, message: "请指定有效的截止日期。" };
    }

    const starts: string[] = [];
    let cursor = addDays(source.start, interval);

    while (cursor <= dialog.untilDate) {
      starts.push(cursor);
      cursor = addDays(cursor, interval);
    }

    return { ok: true, starts };
  }

  if (dialog.mode === "weekly") {
    if (!dialog.weeklyDays.length) {
      return { ok: false, message: "请至少选择一个星期。" };
    }

    if (!isIsoDateInput(dialog.untilDate)) {
      return { ok: false, message: "请指定有效的截止日期。" };
    }

    const selectedDays = new Set(dialog.weeklyDays);
    const starts: string[] = [];
    let cursor = addDays(source.start, 1);

    while (cursor <= dialog.untilDate) {
      if (selectedDays.has(parseIso(cursor).getUTCDay())) {
        starts.push(cursor);
      }

      cursor = addDays(cursor, 1);
    }

    return { ok: true, starts };
  }

  if (dialog.mode === "monthly") {
    const day = Math.round(Number(dialog.monthlyDay));
    const until = parseMonthInput(dialog.untilMonth);

    if (day < 1 || day > 31) {
      return { ok: false, message: "每月日期必须在 1 到 31 之间。" };
    }

    if (!until) {
      return { ok: false, message: "请指定有效的截止月份。" };
    }

    const start = parseIso(source.start);
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth() + 1;
    const starts: string[] = [];

    while (year < until.year || (year === until.year && month <= until.month)) {
      if (day <= daysInMonth(year, month)) {
        const candidate = isoFromParts(year, month, day);

        if (candidate > source.start) {
          starts.push(candidate);
        }
      }

      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }

    return { ok: true, starts };
  }

  const dates = parseYearlyDateList(dialog.yearlyDatesText);
  const untilYear = Math.round(Number(dialog.untilYear));

  if (!dates.length) {
    return { ok: false, message: "请至少输入一个有效日期，例如 05-12、10-01。" };
  }

  if (untilYear < parseIso(source.start).getUTCFullYear()) {
    return { ok: false, message: "截止年份不能早于子任务开始年份。" };
  }

  const startYear = parseIso(source.start).getUTCFullYear();
  const starts: string[] = [];

  for (let year = startYear; year <= untilYear; year += 1) {
    dates.forEach((date) => {
      if (date.day > daysInMonth(year, date.month)) {
        return;
      }

      const candidate = isoFromParts(year, date.month, date.day);

      if (candidate > source.start) {
        starts.push(candidate);
      }
    });
  }

  return { ok: true, starts };
}

function recurrenceConflict(task: GanttTask, source: GanttSubtask, starts: string[]) {
  const duration = normalizeDuration(source.duration);
  const copies = starts.map((start) => ({ start, duration, name: source.name }));

  for (let index = 0; index < copies.length; index += 1) {
    for (let nextIndex = index + 1; nextIndex < copies.length; nextIndex += 1) {
      if (subtaskIntervalsOverlap(copies[index], copies[nextIndex])) {
        return `重复生成失败：${subtaskRangeLabel(copies[index])} 与 ${subtaskRangeLabel(copies[nextIndex])} 相互重叠。`;
      }
    }
  }

  for (const copy of copies) {
    const existing = task.subtasks.find((subtask) => subtaskIntervalsOverlap(copy, subtask));

    if (existing) {
      return `重复生成失败：${subtaskRangeLabel(copy)} 与已有子任务“${existing.name}”重叠。`;
    }
  }

  return "";
}

function cloneSubtaskForStart(task: GanttTask, source: GanttSubtask, start: string, index: number): GanttSubtask {
  const subtask = createSubtask(
    doc.value.tasks.indexOf(task) + 1,
    index + 1,
    source.name,
    start,
    source.color || task.color || appSettings.value.defaultSubtaskColor,
  );
  subtask.duration = normalizeDuration(source.duration);
  subtask.completed = source.completed;
  subtask.expanded = source.children.length > 0 && source.expanded;
  subtask.children = source.children.map((child, childIndex) => ({
    id: createSecondLevelId(subtask.id, childIndex),
    name: child.name,
    completed: child.completed,
  }));
  const offsetDays = differenceInDays(source.start, subtask.start);
  subtask.links = source.links.map((link, linkIndex) => ({
    ...link,
    id: createLinkId(subtask.id, linkIndex),
    start: clampLinkStart(subtask, link, addDays(link.start, offsetDays)),
    color: linkedItemColor(subtask),
    children: link.children.map((child, childIndex) => ({
      id: createSecondLevelId(`${subtask.id}-link-${linkIndex + 1}`, childIndex),
      name: child.name,
      completed: child.completed,
    })),
  }));

  return subtask;
}

function subtaskIntervalsOverlap(
  first: Pick<GanttSubtask, "start" | "duration">,
  second: Pick<GanttSubtask, "start" | "duration">,
) {
  return first.start < endDate(second) && second.start < endDate(first);
}

function subtaskRangeLabel(item: Pick<GanttSubtask, "start" | "duration">) {
  return `${formatDisplayDate(item.start)} 至 ${formatDisplayDate(addDays(endDate(item), -1))}`;
}

function uniqueSortedDates(values: string[]) {
  return Array.from(new Set(values)).sort();
}

function isIsoDateInput(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseMonthInput(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})$/);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);

  return month >= 1 && month <= 12 ? { year, month } : null;
}

function parseYearlyDateList(value: string) {
  return value
    .split(/[\s,，、;；]+/)
    .map((raw) => {
      const match = raw.trim().match(/^(\d{1,2})[-/](\d{1,2})$/);

      if (!match) {
        return null;
      }

      const month = Number(match[1]);
      const day = Number(match[2]);

      if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2024, month)) {
        return null;
      }

      return { month, day };
    })
    .filter((item): item is { month: number; day: number } => Boolean(item));
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoFromParts(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
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

function contextLink() {
  const subtask = contextSubtask();

  if (!subtask || !contextMenu.value?.linkId) {
    return null;
  }

  return subtask.links.find((link) => link.id === contextMenu.value?.linkId) ?? null;
}

function canAddLinkFromContext() {
  const subtask = contextSubtask();

  if (!subtask || contextMenu.value?.linkId) {
    return false;
  }

  return Boolean(firstAvailableLinkStart(subtask, contextMenu.value?.date ?? subtask.start, 1));
}

function subtaskBarStyle(task: GanttTask, subtask: GanttSubtask) {
  const layout = subtaskLayout(task, subtask);
  const color = subtask.color || task.color || appSettings.value.defaultSubtaskColor || DEFAULT_BAR_COLOR;

  return {
    left: `${layout.left}px`,
    top: `${SUBTASK_BAR_TOP}px`,
    width: `${layout.width}px`,
    height: `${layout.height}px`,
    background: color,
    color: readableTextColor(color),
    "--bar-color": color,
    "--bar-height": `${appSettings.value.collapsedBarHeight}px`,
    fontSize: `${appSettings.value.collapsedBarFontSize}px`,
  };
}

function linkBarStyle(task: GanttTask, parent: GanttSubtask, link: GanttLinkedItem) {
  const layout = subtaskLayout(task, parent);
  const top = linkTop(parent, layout.height);
  const color = linkedItemColor(parent);

  return {
    left: `${dateToX(link.start)}px`,
    top: `${top}px`,
    width: `${renderedSubtaskWidth(link)}px`,
    height: `${renderedSubtaskHeight(link, renderedSubtaskWidth(link))}px`,
    background: color,
    color: readableTextColor(color),
    "--bar-color": color,
    "--bar-height": `${appSettings.value.collapsedBarHeight}px`,
    fontSize: `${appSettings.value.collapsedBarFontSize}px`,
  };
}

function linkMetaStyle(task: GanttTask, parent: GanttSubtask, link: GanttLinkedItem) {
  const layout = subtaskLayout(task, parent);
  const top = linkTop(parent, layout.height);

  return {
    left: `${dateToX(link.start)}px`,
    top: `${top - SUBTASK_META_HEIGHT - SUBTASK_META_BAR_GAP}px`,
  };
}

function linkedItemColor(parent: GanttSubtask) {
  return lightenColor(parent.color || appSettings.value.defaultSubtaskColor || DEFAULT_BAR_COLOR, 0.28);
}

function shouldHideDraggedSourceSubtask(task: GanttTask, subtask: GanttSubtask) {
  const drag = dragState.value;

  return (
    !!drag &&
    drag.mode === "move" &&
    !!subtaskDropTargetId.value &&
    drag.taskId === task.id &&
    drag.subtaskId === subtask.id
  );
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

function taskRowHeight(task: GanttTask) {
  return Math.max(
    TASK_ROW_HEIGHT,
    ...task.subtasks.map((subtask) => {
      const layout = subtaskLayout(task, subtask);
      return subtaskGroupHeight(subtask, layout.height) + SUBTASK_BAR_TOP + SUBTASK_ROW_BOTTOM;
    }),
  );
}

function subtaskGroupHeight(subtask: GanttSubtask, subtaskHeight: number) {
  if (!subtask.links.length) {
    return subtaskHeight;
  }

  const linkHeight = Math.max(
    ...subtask.links.map((link) => renderedSubtaskHeight(link, renderedSubtaskWidth(link))),
  );

  return subtaskHeight + LINK_ROW_GAP + linkHeight;
}

function linkTop(_parent: GanttSubtask, parentHeight: number) {
  return SUBTASK_BAR_TOP + parentHeight + LINK_ROW_GAP;
}

function subtaskLayout(task: GanttTask, target: GanttSubtask) {
  const layouts = subtaskLayouts(task);
  return layouts.get(target.id) ?? {
    left: dateToX(target.start),
    width: baseSubtaskWidth(target),
    height: appSettings.value.collapsedBarHeight,
  };
}

function subtaskLayouts(task: GanttTask) {
  return buildSubtaskLayouts(task.subtasks);
}

function buildSubtaskLayouts(subtasks: GanttSubtask[]) {
  const layouts = new Map<string, SubtaskLayout>();
  const ordered = [...subtasks].sort((first, second) => {
    const dateOrder = first.start.localeCompare(second.start);
    return dateOrder || subtasks.indexOf(first) - subtasks.indexOf(second);
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
  return (
    appSettings.value.showPuzzleJoins &&
    (doc.value.view === "day" || doc.value.view === "week" || doc.value.view === "month")
  );
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

function lightenColor(color: string, amount: number) {
  const rgb = parseHexColor(color);

  if (!rgb) {
    return color;
  }

  const mixed = rgb.map((channel) => Math.round(channel + (255 - channel) * amount));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
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

function baseSubtaskWidth(subtask: GanttSubtask | GanttLinkedItem) {
  return Math.max(dayWidth.value * normalizeDuration(subtask.duration), 34);
}

function renderedSubtaskWidth(subtask: GanttSubtask | GanttLinkedItem) {
  return baseSubtaskWidth(subtask);
}

function renderedSubtaskHeight(subtask: GanttSubtask | GanttLinkedItem, width: number) {
  if (editingSubtaskId.value === subtask.id) {
    const lineCount = Math.max(3, editingSubtaskText.value.split(/\r?\n/).length);
    return EXPANDED_VERTICAL_PADDING + lineCount * EXPANDED_LINE_HEIGHT;
  }

  if (!isSubtaskExpandedVisible(subtask)) {
    return appSettings.value.collapsedBarHeight;
  }

  const lineCount = expandedSubtaskLines(subtask).reduce((total, line) => total + wrappedLineCount(line, width - 58), 0);
  return Math.max(appSettings.value.collapsedBarHeight + 4, EXPANDED_VERTICAL_PADDING + lineCount * EXPANDED_LINE_HEIGHT);
}

function expandedSubtaskLines(subtask: GanttSubtask | GanttLinkedItem) {
  return [subtask.name, ...subtask.children.map((child) => child.name)];
}

function wrappedLineCount(text: string, width: number) {
  const charactersPerLine = Math.max(3, Math.floor(width / 12));
  return Math.max(1, Math.ceil(Array.from(text || " ").length / charactersPerLine));
}

function isSubtaskExpandedVisible(subtask: GanttSubtask | GanttLinkedItem) {
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

function timeCellStyle(segment: UnitSegment) {
  return {
    ...segmentStyle(segment),
    background: cellBackground(segment),
  };
}

function cellBackground(segment: UnitSegment) {
  if (!(doc.value.view === "day" || doc.value.view === "week" || doc.value.view === "month")) {
    return undefined;
  }

  const day = parseIso(segment.start).getUTCDay();
  const isWeekend = day === 0 || day === 6;

  if (isWeekend && appSettings.value.weekendBackgroundEnabled) {
    return appSettings.value.weekendBackground;
  }

  if (!isWeekend && appSettings.value.workdayBackgroundEnabled) {
    return appSettings.value.workdayBackground;
  }

  return undefined;
}

function openWeekNumberMenu(event: MouseEvent, segment: WeekNumberSegment) {
  event.preventDefault();
  finishSubtaskTextEdit();
  contextMenu.value = null;
  taskListMenu.value = null;
  weekNumberMenu.value = {
    x: event.clientX,
    y: event.clientY,
    weekStart: segment.weekStart,
  };
}

function applyWeekNumberAnchor() {
  const menu = weekNumberMenu.value;

  if (!menu) {
    return;
  }

  setFirstWeekStart(menu.weekStart);
  closeContextMenu();
}

function setFirstWeekStart(weekStart: string) {
  appSettings.value.firstWeekStart = startOfWeek(weekStart);
  statusMessage.value = `已将 ${formatDisplayDate(appSettings.value.firstWeekStart)} 设为第 1 周`;
}

function toggleTaskLock(task: GanttTask) {
  task.locked = !task.locked;
}

function toggleSourcePanel() {
  sourcePanelOpen.value = !sourcePanelOpen.value;
  if (sourcePanelOpen.value) {
    settingsPanelOpen.value = false;
  }
  refreshSourceDraft();
}

function toggleSettingsPanel() {
  settingsPanelOpen.value = !settingsPanelOpen.value;
  if (settingsPanelOpen.value) {
    sourcePanelOpen.value = false;
  }
}

function resetSettings() {
  appSettings.value = { ...DEFAULT_APP_SETTINGS };
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

function localDateIso(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
    2,
    "0",
  )}`;
}

function localDayProgress(date: Date): number {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return Math.max(0, Math.min(1, (date.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
}

function formatTimeFlag(date: Date, format: AppSettings["timeFlagFormat"]): string {
  const minutes = String(date.getMinutes()).padStart(2, "0");

  if (format === "12h") {
    const suffix = date.getHours() >= 12 ? "PM" : "AM";
    const hour = date.getHours() % 12 || 12;

    return `${hour}:${minutes} ${suffix}`;
  }

  return `${String(date.getHours()).padStart(2, "0")}:${minutes}`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function fileStem(path: string): string {
  const name = fileName(path);
  const dotIndex = name.lastIndexOf(".");

  return dotIndex > 0 ? name.slice(0, dotIndex) : name;
}

function fileExtension(path: string): string {
  const name = fileName(path);
  const dotIndex = name.lastIndexOf(".");

  return dotIndex > 0 ? name.slice(dotIndex) : ".mmd";
}

function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));

  return index >= 0 ? path.slice(0, index + 1) : "";
}

function safeFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-") || "markmymind-gantt"
  );
}

function setTitleFromPath(path: string) {
  doc.value.title = fileStem(path) || doc.value.title;
}

function updateDocumentTitle(value: string) {
  doc.value.title = value.trim() || "未命名甘特图";
  scheduleTitleRename();
}

function scheduleTitleRename() {
  if (titleRenameTimer) {
    window.clearTimeout(titleRenameTimer);
  }

  titleRenameTimer = window.setTimeout(() => {
    titleRenameTimer = null;
    void renameCurrentFileToTitle();
  }, 600);
}

async function renameCurrentFileToTitle() {
  const path = currentPath.value;

  if (!path) {
    return;
  }

  const nextPath = `${directoryOf(path)}${safeFileName(doc.value.title)}${fileExtension(path)}`;

  if (nextPath === path) {
    return;
  }

  try {
    await invoke("rename_gantt_file", { from: path, to: nextPath });
    currentPath.value = nextPath;
    window.localStorage.setItem(LAST_FILE_PATH_KEY, nextPath);
    statusMessage.value = `已重命名为 ${fileName(nextPath)}`;
  } catch (error) {
    statusMessage.value = `重命名失败：${String(error)}`;
  }
}

function loadAppSettings(): AppSettings {
  try {
    const raw = window.localStorage.getItem(APP_SETTINGS_KEY);
    return normalizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

function normalizeSettings(value: Partial<AppSettings>): AppSettings {
  return {
    defaultTaskColor: normalizeColor(value.defaultTaskColor, DEFAULT_APP_SETTINGS.defaultTaskColor),
    defaultSubtaskColor: normalizeColor(value.defaultSubtaskColor, DEFAULT_APP_SETTINGS.defaultSubtaskColor),
    dayScaleWidth: clampSettingNumber(value.dayScaleWidth, 120, 360, DEFAULT_APP_SETTINGS.dayScaleWidth),
    weekScaleWidth: clampSettingNumber(value.weekScaleWidth, 48, 180, DEFAULT_APP_SETTINGS.weekScaleWidth),
    monthScaleWidth: clampSettingNumber(value.monthScaleWidth, 24, 110, DEFAULT_APP_SETTINGS.monthScaleWidth),
    quarterScaleWidth: clampSettingNumber(value.quarterScaleWidth, 6, 42, DEFAULT_APP_SETTINGS.quarterScaleWidth),
    yearScaleWidth: clampSettingNumber(value.yearScaleWidth, 1, 12, DEFAULT_APP_SETTINGS.yearScaleWidth),
    rangeYearsBefore: clampSettingNumber(value.rangeYearsBefore, 0, 20, DEFAULT_APP_SETTINGS.rangeYearsBefore),
    rangeYearsAfter: clampSettingNumber(value.rangeYearsAfter, 0, 20, DEFAULT_APP_SETTINGS.rangeYearsAfter),
    autoSwitchViewOnExpand: value.autoSwitchViewOnExpand !== false,
    showPuzzleJoins: value.showPuzzleJoins !== false,
    restoreLastFile: value.restoreLastFile !== false,
    collapsedBarHeight: clampSettingNumber(
      value.collapsedBarHeight,
      22,
      64,
      DEFAULT_APP_SETTINGS.collapsedBarHeight,
    ),
    collapsedBarFontSize: clampSettingNumber(
      value.collapsedBarFontSize,
      10,
      24,
      DEFAULT_APP_SETTINGS.collapsedBarFontSize,
    ),
    gridLineWidth: clampSettingNumber(value.gridLineWidth, 0, 4, DEFAULT_APP_SETTINGS.gridLineWidth),
    gridLineColor: normalizeColor(value.gridLineColor, DEFAULT_APP_SETTINGS.gridLineColor),
    gridLineOpacity: clampSettingNumber(value.gridLineOpacity, 0, 1, DEFAULT_APP_SETTINGS.gridLineOpacity),
    timeFlagFormat: value.timeFlagFormat === "12h" ? "12h" : DEFAULT_APP_SETTINGS.timeFlagFormat,
    taskListLineWidth: clampSettingNumber(
      value.taskListLineWidth,
      0,
      4,
      DEFAULT_APP_SETTINGS.taskListLineWidth,
    ),
    taskListLineOpacity: clampSettingNumber(
      value.taskListLineOpacity,
      0,
      1,
      DEFAULT_APP_SETTINGS.taskListLineOpacity,
    ),
    showWeekNumberAxis: value.showWeekNumberAxis !== false,
    firstWeekStart: typeof value.firstWeekStart === "string" ? startOfWeek(value.firstWeekStart) : DEFAULT_APP_SETTINGS.firstWeekStart,
    workdayBackground: normalizeColor(value.workdayBackground, DEFAULT_APP_SETTINGS.workdayBackground),
    weekendBackground: normalizeColor(value.weekendBackground, DEFAULT_APP_SETTINGS.weekendBackground),
    workdayBackgroundEnabled: value.workdayBackgroundEnabled === true,
    weekendBackgroundEnabled: value.weekendBackgroundEnabled === true,
    defaultSubtaskDuration: clampSettingNumber(
      value.defaultSubtaskDuration,
      1,
      365,
      DEFAULT_APP_SETTINGS.defaultSubtaskDuration,
    ),
  };
}

function normalizeColor(value: unknown, fallback: string) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function colorWithOpacity(color: string, opacity: number) {
  const rgb = parseHexColor(color);

  if (!rgb) {
    return color;
  }

  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Math.max(0, Math.min(1, opacity))})`;
}

function clampSettingNumber(value: unknown, min: number, max: number, fallback: number) {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, numericValue));
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
        <BookOpen :size="22" />
        <input v-model="titleModel" class="title-input" aria-label="甘特图标题" />
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
        <button type="button" title="设置" :class="{ active: settingsPanelOpen }" @click="toggleSettingsPanel">
          <Settings :size="17" />
          <span>设置</span>
        </button>
      </div>

      <div class="file-state">
        <span class="path">{{ currentPath ?? "未保存文件" }}</span>
        <span v-if="isDirty" class="dirty-dot">未保存</span>
      </div>
    </header>

    <section class="workspace" :class="{ 'with-source': sidePanelOpen }">
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
          <aside
            ref="taskTablePane"
            class="task-table"
            :style="taskTableStyle"
            @scroll="syncTaskTableScroll"
            @wheel.prevent="scrollTaskTableWheel"
            @contextmenu.prevent="openTaskListBlankMenu"
          >
            <div class="task-header" :style="taskHeaderStyle">
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
                  <span class="task-indent" :class="{ nested: row.depth === 1 }"></span>
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
                  <button
                    type="button"
                    class="apply-task-color"
                    title="应用颜色"
                    @click.stop="applyTaskColorToSubtasks(row.task)"
                    @pointerdown.stop
                  >
                    <PaintBucket :size="15" />
                  </button>
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
            :class="{ 'has-week-axis': weekNumberAxisVisible }"
            :style="timelinePaneStyle"
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

              <div v-if="weekNumberAxisVisible" class="week-number-row">
                <button
                  v-for="segment in weekNumberSegments"
                  :key="segment.key"
                  type="button"
                  class="week-number-cell"
                  :class="{ anchor: segment.weekStart === appSettings.firstWeekStart }"
                  :style="segmentStyle(segment)"
                  title="右键选择周数锚点"
                  @contextmenu.prevent.stop="openWeekNumberMenu($event, segment)"
                >
                  {{ segment.label }}
                </button>
              </div>

              <div class="unit-row">
                <div v-for="segment in unitSegments" :key="segment.key" class="unit-cell" :style="timeCellStyle(segment)">
                  {{ segment.label }}
                </div>
              </div>

              <div class="today-line" :style="todayLineStyle">
                <span class="today-time-flag">{{ currentTimeLabel }}</span>
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
                  <div v-for="segment in unitSegments" :key="`${row.key}-${segment.key}`" class="grid-unit" :style="timeCellStyle(segment)"></div>

                  <div v-if="row.type === 'section'" class="section-timeline-label">
                    {{ row.section.name }}
                  </div>

                  <div
                    v-if="row.type === 'task' && subtaskDropPreview?.targetTaskId === row.task.id"
                    class="subtask-drop-preview"
                    :style="subtaskDropPreview.style"
                  >
                    <span class="primary-line">{{ subtaskDropPreview.name }}</span>
                  </div>

                  <template v-for="subtask in row.type === 'task' ? row.task.subtasks : []" :key="subtask.id">
                    <div
                      v-if="row.type === 'task' && !shouldHideDraggedSourceSubtask(row.task, subtask)"
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
                        <ChevronDown v-if="subtask.expanded && subtask.children.length" :size="14" />
                        <ChevronRight v-else :size="14" />
                      </button>
                      <input
                        class="completion-checkbox primary-completion-checkbox"
                        type="checkbox"
                        :checked="subtask.completed"
                        aria-label="标记一级子任务完成"
                        @change="setSubtaskCompleted(subtask, $event)"
                        @click.stop
                        @pointerdown.stop
                      />
                      <span v-if="subtask.duration >= 3" class="duration-label">
                        {{ subtask.duration }} 天
                      </span>
                      <button
                        v-if="editingSubtaskId === subtask.id"
                        type="button"
                        class="subtask-edit-save"
                        title="保存编辑"
                        @click.stop="finishSubtaskTextEdit"
                        @pointerdown.stop
                      >
                        <Check :size="15" />
                      </button>
                    </div>

                    <div
                      v-if="row.type === 'task' && !shouldHideDraggedSourceSubtask(row.task, subtask)"
                      role="button"
                      tabindex="0"
                      class="subtask-bar"
                      :class="{
                        locked: row.task.locked,
                        selected: subtask.id === selectedSubtaskId,
                        completed: subtask.completed,
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
                      <span v-else-if="isSubtaskExpandedVisible(subtask)" class="expanded-subtask-lines">
                        <span class="task-name-line primary-line" :class="{ completed: subtask.completed }">
                          <span class="task-name-text">{{ subtask.name }}</span>
                        </span>
                        <span
                          v-for="child in subtask.children"
                          :key="child.id"
                          class="task-name-line secondary-line"
                          :class="{ completed: child.completed }"
                        >
                          <input
                            class="completion-checkbox secondary-completion-checkbox"
                            type="checkbox"
                            :checked="child.completed"
                            aria-label="标记二级子任务完成"
                            @change="setSecondLevelCompleted(child, $event)"
                            @click.stop
                            @pointerdown.stop
                          />
                          <span class="task-name-text">{{ child.name }}</span>
                        </span>
                      </span>
                      <span v-else class="task-name-line primary-line" :class="{ completed: subtask.completed }">
                        <span class="task-name-text">{{ subtask.name }}</span>
                      </span>
                      <i
                        v-if="editingSubtaskId !== subtask.id"
                        class="resize-handle"
                        title="调整工期"
                        @pointerdown.stop="beginSubtaskDrag($event, row.task, subtask, 'resize')"
                      ></i>
                    </div>

                    <template v-if="row.type === 'task' && !shouldHideDraggedSourceSubtask(row.task, subtask)">
                      <template v-for="link in subtask.links" :key="link.id">
                        <div class="subtask-meta link-meta" :style="linkMetaStyle(row.task, subtask, link)">
                          <button
                            type="button"
                            class="fold-button"
                            :class="{ disabled: !link.children.length }"
                            :title="link.expanded ? '折叠' : '展开'"
                            @click.stop="toggleSubtaskExpanded(row.task, link, subtask)"
                            @pointerdown.stop
                          >
                            <ChevronDown v-if="link.expanded && link.children.length" :size="14" />
                            <ChevronRight v-else :size="14" />
                          </button>
                          <input
                            class="completion-checkbox primary-completion-checkbox"
                            type="checkbox"
                            :checked="link.completed"
                            aria-label="标记关联项完成"
                            @change="setSubtaskCompleted(link, $event)"
                            @click.stop
                            @pointerdown.stop
                          />
                          <span v-if="link.duration >= 3" class="duration-label">
                            {{ link.duration }} 天
                          </span>
                          <button
                            v-if="editingSubtaskId === link.id"
                            type="button"
                            class="subtask-edit-save"
                            title="保存编辑"
                            @click.stop="finishSubtaskTextEdit"
                            @pointerdown.stop
                          >
                            <Check :size="15" />
                          </button>
                        </div>
                        <div
                          role="button"
                          tabindex="0"
                          class="subtask-bar link-bar"
                          :class="{
                            locked: row.task.locked,
                            selected: link.id === selectedSubtaskId,
                            completed: link.completed,
                            expanded: isSubtaskExpandedVisible(link),
                            editing: editingSubtaskId === link.id,
                          }"
                          :style="linkBarStyle(row.task, subtask, link)"
                          :title="`${row.task.name} / ${subtask.name} / ${link.name}: ${link.start} - ${endDate(link)}`"
                          @click.stop="selectLink(row.task, subtask, link)"
                          @dblclick.stop="startLinkTextEdit(row.task, subtask, link)"
                          @contextmenu.stop="openLinkContextMenu($event, row.task, subtask, link)"
                          @pointerdown="beginLinkDrag($event, row.task, subtask, link, 'move')"
                        >
                          <textarea
                            v-if="editingSubtaskId === link.id"
                            ref="subtaskTextEditor"
                            v-model="editingSubtaskText"
                            class="subtask-text-editor"
                            aria-label="关联项局部编辑"
                            @blur="finishSubtaskTextEdit"
                            @click.stop
                            @dblclick.stop
                            @keydown.ctrl.enter.stop.prevent="finishSubtaskTextEdit"
                            @keydown.meta.enter.stop.prevent="finishSubtaskTextEdit"
                            @keydown.esc.stop.prevent="cancelSubtaskTextEdit"
                            @pointerdown.stop
                          ></textarea>
                          <span v-else-if="isSubtaskExpandedVisible(link)" class="expanded-subtask-lines">
                            <span class="task-name-line primary-line" :class="{ completed: link.completed }">
                              <span class="task-name-text">{{ link.name }}</span>
                            </span>
                            <span
                              v-for="child in link.children"
                              :key="child.id"
                              class="task-name-line secondary-line"
                              :class="{ completed: child.completed }"
                            >
                              <input
                                class="completion-checkbox secondary-completion-checkbox"
                                type="checkbox"
                                :checked="child.completed"
                                aria-label="标记关联子项完成"
                                @change="setSecondLevelCompleted(child, $event)"
                                @click.stop
                                @pointerdown.stop
                              />
                              <span class="task-name-text">{{ child.name }}</span>
                            </span>
                          </span>
                          <span v-else class="task-name-line primary-line" :class="{ completed: link.completed }">
                            <span class="task-name-text">{{ link.name }}</span>
                          </span>
                          <i
                            v-if="editingSubtaskId !== link.id"
                            class="resize-handle"
                            title="调整工期"
                            @pointerdown.stop="beginLinkDrag($event, row.task, subtask, link, 'resize')"
                          ></i>
                        </div>
                      </template>
                    </template>
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

            <div v-if="selectedTimelineItem" class="inspector-field color-field">
              <label>子任务颜色</label>
              <input v-model="selectedTimelineItem.color" type="color" />
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

      <aside v-else-if="settingsPanelOpen" class="source-panel settings-panel">
        <div class="source-head">
          <strong>设置</strong>
          <div class="source-actions">
            <button type="button" @click="resetSettings">重置</button>
          </div>
        </div>

        <div class="settings-body">
          <section class="settings-section">
            <h3>默认颜色</h3>
            <label class="settings-row">
              <span>新任务默认子任务颜色</span>
              <input v-model="appSettings.defaultTaskColor" type="color" />
            </label>
            <label class="settings-row">
              <span>新子任务备用颜色</span>
              <input v-model="appSettings.defaultSubtaskColor" type="color" />
            </label>
            <label class="settings-row">
              <span>新子任务默认天数</span>
              <input v-model.number="appSettings.defaultSubtaskDuration" type="number" min="1" max="365" step="1" />
            </label>
          </section>

          <section class="settings-section">
            <h3>时间刻度</h3>
            <label class="settings-row">
              <span>天视图单日宽度</span>
              <input v-model.number="appSettings.dayScaleWidth" type="number" min="120" max="360" step="1" />
            </label>
            <label class="settings-row">
              <span>周视图单日宽度</span>
              <input v-model.number="appSettings.weekScaleWidth" type="number" min="48" max="180" step="1" />
            </label>
            <label class="settings-row">
              <span>月视图单日宽度</span>
              <input v-model.number="appSettings.monthScaleWidth" type="number" min="24" max="110" step="1" />
            </label>
            <label class="settings-row">
              <span>季视图单日宽度</span>
              <input v-model.number="appSettings.quarterScaleWidth" type="number" min="6" max="42" step="1" />
            </label>
            <label class="settings-row">
              <span>年视图单日宽度</span>
              <input v-model.number="appSettings.yearScaleWidth" type="number" min="1" max="12" step="0.1" />
            </label>
          </section>

          <section class="settings-section">
            <h3>任务条</h3>
            <label class="settings-row">
              <span>折叠任务条高度</span>
              <input v-model.number="appSettings.collapsedBarHeight" type="number" min="22" max="64" step="1" />
            </label>
            <label class="settings-row">
              <span>折叠任务条字号</span>
              <input v-model.number="appSettings.collapsedBarFontSize" type="number" min="10" max="24" step="1" />
            </label>
          </section>

          <section class="settings-section">
            <h3>日期网格</h3>
            <label class="settings-row">
              <span>网格线粗细</span>
              <input v-model.number="appSettings.gridLineWidth" type="number" min="0" max="4" step="0.5" />
            </label>
            <label class="settings-row">
              <span>网格线透明度</span>
              <input v-model.number="appSettings.gridLineOpacity" type="number" min="0" max="1" step="0.05" />
            </label>
            <label class="settings-row">
              <span>网格线颜色</span>
              <input v-model="appSettings.gridLineColor" type="color" />
            </label>
            <label class="settings-row">
              <span>当前时间格式</span>
              <select v-model="appSettings.timeFlagFormat">
                <option value="24h">24 小时</option>
                <option value="12h">12 小时</option>
              </select>
            </label>
            <label class="settings-toggle">
              <input v-model="appSettings.showWeekNumberAxis" type="checkbox" />
              <span>显示周数轴</span>
            </label>
            <label class="settings-row">
              <span>第 1 周起始日</span>
              <input v-model="appSettings.firstWeekStart" type="date" />
            </label>
            <label class="settings-toggle">
              <input v-model="appSettings.workdayBackgroundEnabled" type="checkbox" />
              <span>填充工作日背景</span>
            </label>
            <label class="settings-row">
              <span>工作日背景色</span>
              <input v-model="appSettings.workdayBackground" type="color" />
            </label>
            <label class="settings-toggle">
              <input v-model="appSettings.weekendBackgroundEnabled" type="checkbox" />
              <span>填充周末背景</span>
            </label>
            <label class="settings-row">
              <span>周末背景色</span>
              <input v-model="appSettings.weekendBackground" type="color" />
            </label>
          </section>

          <section class="settings-section">
            <h3>主任务列表</h3>
            <label class="settings-row">
              <span>线框粗细</span>
              <input v-model.number="appSettings.taskListLineWidth" type="number" min="0" max="4" step="0.5" />
            </label>
            <label class="settings-row">
              <span>线框透明度</span>
              <input v-model.number="appSettings.taskListLineOpacity" type="number" min="0" max="1" step="0.05" />
            </label>
          </section>

          <section class="settings-section">
            <h3>渲染范围</h3>
            <label class="settings-row">
              <span>向过去渲染年份</span>
              <input v-model.number="appSettings.rangeYearsBefore" type="number" min="0" max="20" step="1" />
            </label>
            <label class="settings-row">
              <span>向未来渲染年份</span>
              <input v-model.number="appSettings.rangeYearsAfter" type="number" min="0" max="20" step="1" />
            </label>
          </section>

          <section class="settings-section">
            <h3>交互</h3>
            <label class="settings-toggle">
              <input v-model="appSettings.autoSwitchViewOnExpand" type="checkbox" />
              <span>展开或编辑时自动切换视图</span>
            </label>
            <label class="settings-toggle">
              <input v-model="appSettings.showPuzzleJoins" type="checkbox" />
              <span>显示相接子任务拼图效果</span>
            </label>
            <label class="settings-toggle">
              <input v-model="appSettings.restoreLastFile" type="checkbox" />
              <span>启动时打开上次文件</span>
            </label>
          </section>
        </div>
      </aside>
    </section>

    <div
      v-if="contextMenu"
      class="context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      @click.stop
    >
      <button v-if="contextMenu.linkId" type="button" @click="deleteLinkFromContext">删除关联项</button>
      <button v-else-if="contextMenu.subtaskId && canAddLinkFromContext()" type="button" @click="addLinkFromContext">添加关联项</button>
      <button v-else type="button" @click="addSubtaskFromContext">添加子任务</button>
      <button v-if="!contextMenu.linkId && contextMenu.subtaskId" type="button" @click="openRecurrenceDialogFromContext">
        重复生成
      </button>
      <button v-if="!contextMenu.linkId && contextMenu.subtaskId" type="button" @click="deleteSubtaskFromContext">
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

    <div
      v-if="weekNumberMenu"
      class="context-menu week-number-menu"
      :style="{ left: `${weekNumberMenu.x}px`, top: `${weekNumberMenu.y}px` }"
      @click.stop
    >
      <button type="button" @click="applyWeekNumberAnchor">设为第 1 周</button>
    </div>

    <div v-if="recurrenceDialog" class="modal-backdrop" @click.self="closeRecurrenceDialog">
      <form class="recurrence-dialog" @submit.prevent="applyRecurrenceDialog" @click.stop>
        <header>
          <strong>重复生成</strong>
          <button type="button" title="关闭" @click="closeRecurrenceDialog">×</button>
        </header>

        <label class="settings-row">
          <span>重复方式</span>
          <select v-model="recurrenceDialog.mode">
            <option value="interval">每 N 天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="yearly">每年</option>
          </select>
        </label>

        <template v-if="recurrenceDialog.mode === 'interval'">
          <label class="settings-row">
            <span>间隔天数</span>
            <input v-model.number="recurrenceDialog.intervalDays" type="number" min="1" max="366" step="1" />
          </label>
          <label class="settings-row">
            <span>截止日期</span>
            <input v-model="recurrenceDialog.untilDate" type="date" />
          </label>
        </template>

        <template v-else-if="recurrenceDialog.mode === 'weekly'">
          <div class="recurrence-weekdays">
            <label v-for="day in weekdayOptions" :key="day.value">
              <input
                type="checkbox"
                :checked="recurrenceDialog.weeklyDays.includes(day.value)"
                @change="toggleRecurrenceWeekday(day.value)"
              />
              <span>{{ day.label }}</span>
            </label>
          </div>
          <label class="settings-row">
            <span>截止日期</span>
            <input v-model="recurrenceDialog.untilDate" type="date" />
          </label>
        </template>

        <template v-else-if="recurrenceDialog.mode === 'monthly'">
          <label class="settings-row">
            <span>每月日期</span>
            <input v-model.number="recurrenceDialog.monthlyDay" type="number" min="1" max="31" step="1" />
          </label>
          <label class="settings-row">
            <span>截止月份</span>
            <input v-model="recurrenceDialog.untilMonth" type="month" />
          </label>
        </template>

        <template v-else>
          <label class="settings-row">
            <span>重复日期</span>
            <input v-model="recurrenceDialog.yearlyDatesText" type="text" placeholder="05-12, 10-01" />
          </label>
          <label class="settings-row">
            <span>截止年份</span>
            <input v-model.number="recurrenceDialog.untilYear" type="number" min="1970" max="2100" step="1" />
          </label>
        </template>

        <p v-if="recurrenceDialog.message" class="recurrence-message">{{ recurrenceDialog.message }}</p>

        <footer>
          <button type="button" @click="closeRecurrenceDialog">取消</button>
          <button type="submit" class="primary">生成</button>
        </footer>
      </form>
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
  --task-list-line-width: 1px;
  --task-list-line-color: #dbe1ea;
  min-width: 0;
  overflow: hidden;
  border-right: var(--task-list-line-width) solid var(--task-list-line-color);
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
  grid-template-columns: 26px 30px minmax(0, 1fr) 34px 30px;
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
  border-bottom: var(--task-list-line-width) solid var(--task-list-line-color);
  color: #6c7581;
  background: #ffffff;
  font-size: 13px;
  font-weight: 700;
}

.task-row {
  padding: 8px 12px;
  border-bottom: var(--task-list-line-width) solid var(--task-list-line-color);
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
  padding-left: 18px;
}

.index-cell {
  color: #8b95a1;
  text-align: right;
}

.task-indent {
  position: relative;
  width: 100%;
  height: 100%;
}

.task-indent.nested::before {
  content: "";
  position: absolute;
  left: 12px;
  top: 50%;
  width: 12px;
  height: var(--task-list-line-width);
  background: var(--task-list-line-color);
}

.task-indent.nested::after {
  content: "";
  position: absolute;
  left: 12px;
  top: 8px;
  bottom: 50%;
  width: var(--task-list-line-width);
  background: var(--task-list-line-color);
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
  border-bottom-color: var(--task-list-line-color);
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

.apply-task-color {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  padding: 0;
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
  --grid-line-width: 1px;
  --grid-line-color: #edf1f5;
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
  z-index: 12;
  background: #ffffff;
}

.year-row {
  top: 0;
  height: 38px;
  border-bottom: var(--grid-line-width) solid var(--grid-line-color);
}

.unit-row {
  top: 38px;
  height: 38px;
  border-bottom: var(--grid-line-width) solid var(--grid-line-color);
}

.week-number-row {
  position: sticky;
  top: 38px;
  z-index: 12;
  display: flex;
  height: 38px;
  border-bottom: var(--grid-line-width) solid var(--grid-line-color);
  background: #ffffff;
}

.timeline-pane.has-week-axis .unit-row {
  top: 76px;
}

.year-segment,
.unit-cell,
.week-number-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  overflow: hidden;
  border-right: var(--grid-line-width) solid var(--grid-line-color);
  color: #68727f;
  white-space: nowrap;
}

.week-number-cell {
  height: 100%;
  border-top: 0;
  border-bottom: 0;
  border-left: 0;
  border-radius: 0;
  padding: 0;
  background: transparent;
  color: #5d6876;
  font-size: 12px;
}

.week-number-cell.anchor {
  color: #1959d1;
  font-weight: 800;
  background: #eef4ff;
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
  border-bottom: var(--grid-line-width) solid var(--grid-line-color);
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

.timeline-row.subtask-drop-target::after {
  content: none;
  display: none;
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
  border-right: var(--grid-line-width) solid var(--grid-line-color);
}

.today-line {
  position: absolute;
  top: var(--timeline-header-height);
  bottom: 0;
  z-index: 7;
  width: 2px;
  transform: translateX(-1px);
  background: #5b7cfa;
  pointer-events: none;
}

.today-time-flag {
  position: sticky;
  top: calc(var(--timeline-header-height) + 4px);
  display: inline-flex;
  align-items: center;
  height: 22px;
  border: 1px solid #0d4e89;
  border-radius: 5px;
  padding: 0 4px;
  transform: translateX(-50%);
  background: #0875c9;
  color: #ffffff;
  font-size: 13px;
  font-weight: 750;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(22, 35, 52, 0.22);
}

.subtask-bar {
  position: absolute;
  --puzzle-radius: 8px;
  --bar-height: 30px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  height: var(--bar-height);
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

.subtask-drop-preview {
  position: absolute;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  overflow: hidden;
  border: 2px solid rgba(47, 111, 237, 0.35);
  border-radius: 7px;
  padding: 0 24px 0 14px;
  font-size: 13px;
  font-weight: 750;
  box-shadow: 0 1px 2px rgba(22, 35, 52, 0.08);
  pointer-events: none;
  opacity: 0.72;
}

.subtask-drop-preview .primary-line {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap !important;
}

.subtask-bar.puzzle-out-right {
  z-index: 4;
}

.subtask-bar.puzzle-out-right::after {
  content: "";
  position: absolute;
  top: calc((var(--bar-height) - var(--puzzle-radius) * 2) / 2);
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
    circle var(--puzzle-radius) at 0 calc(var(--bar-height) / 2),
    transparent 0 calc(var(--puzzle-radius) - 0.5px),
    #000 var(--puzzle-radius)
  );
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: 100% 100%;
  mask-image: radial-gradient(
    circle var(--puzzle-radius) at 0 calc(var(--bar-height) / 2),
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

.subtask-bar.completed {
  opacity: 0.62;
}

.subtask-bar.completed:hover,
.subtask-bar.completed.selected {
  opacity: 0.72;
}

.subtask-bar.expanded {
  align-items: flex-start;
  padding-top: 6px;
  padding-bottom: 6px;
}

.subtask-bar.editing {
  align-items: stretch;
  padding: 8px 12px;
}

.subtask-bar.locked {
  cursor: default;
  opacity: 0.72;
}

.link-bar {
  z-index: 3;
  min-width: 42px;
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
  gap: 3px;
  height: 18px;
  pointer-events: none;
}

.link-meta {
  z-index: 6;
}

.fold-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: 5px;
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

.primary-completion-checkbox,
.secondary-completion-checkbox {
  opacity: 1;
  pointer-events: auto;
}

.primary-completion-checkbox {
  width: 16px;
  height: 16px;
}

.secondary-completion-checkbox {
  width: 16px;
  height: 16px;
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

.duration-label {
  display: inline-flex;
  align-items: center;
  height: 18px;
  flex: 0 0 auto;
  border: 1px solid #75a85e;
  border-radius: 5px;
  padding: 0 5px;
  background: #ffffff;
  color: #24303d;
  font-size: 12px;
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 20px;
  flex: 0 0 auto;
  border: 1px solid #75a85e;
  border-radius: 5px;
  background: #ffffff;
  color: #172033;
  padding: 0;
  pointer-events: auto;
  box-shadow: 0 1px 1px rgba(22, 35, 52, 0.06);
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

.settings-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 14px;
  background: #fbfcfe;
}

.settings-section {
  display: grid;
  gap: 10px;
  padding: 12px 0 16px;
  border-bottom: 1px solid #e4e9f0;
}

.settings-section:first-child {
  padding-top: 0;
}

.settings-section:last-child {
  border-bottom: 0;
}

.settings-section h3 {
  margin: 0;
  color: #253142;
  font-size: 13px;
  font-weight: 750;
}

.settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px;
  align-items: center;
  gap: 12px;
  color: #465364;
  font-size: 13px;
}

.settings-row input,
.settings-row select {
  width: 100%;
  height: 30px;
  border: 1px solid #d8dee8;
  border-radius: 6px;
  background: #ffffff;
  color: #27313d;
}

.settings-row input,
.settings-row select {
  padding: 0 8px;
}

.settings-row input[type="color"] {
  padding: 2px;
}

.settings-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #465364;
  font-size: 13px;
}

.settings-toggle input {
  width: 16px;
  height: 16px;
  accent-color: #2f6fed;
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

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: rgba(23, 32, 45, 0.28);
}

.recurrence-dialog {
  display: grid;
  width: min(430px, calc(100vw - 40px));
  gap: 14px;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  padding: 16px;
  background: #ffffff;
  box-shadow: 0 18px 56px rgba(20, 31, 48, 0.24);
}

.recurrence-dialog header,
.recurrence-dialog footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.recurrence-dialog header strong {
  color: #1f2b3a;
  font-size: 16px;
}

.recurrence-dialog header button {
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  padding: 0;
  background: transparent;
  font-size: 22px;
  line-height: 1;
}

.recurrence-dialog footer {
  justify-content: flex-end;
}

.recurrence-dialog footer button {
  min-width: 72px;
}

.recurrence-weekdays {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.recurrence-weekdays label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: #465364;
  font-size: 13px;
}

.recurrence-weekdays input {
  width: 16px;
  height: 16px;
  accent-color: #2f6fed;
}

.recurrence-message {
  margin: 0;
  border: 1px solid #ffd9a8;
  border-radius: 6px;
  padding: 8px 10px;
  background: #fff7e8;
  color: #8a4a00;
  font-size: 13px;
  line-height: 1.45;
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
    grid-template-columns: 24px 28px minmax(0, 1fr) 32px 28px;
  }

  .task-row.section-row {
    grid-template-columns: 24px 24px 18px minmax(0, 1fr);
  }
}
</style>

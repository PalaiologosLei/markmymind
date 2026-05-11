export type GanttScale = "week" | "month" | "quarter" | "year";
export type GanttStatus = "todo" | "active" | "done" | "critical" | "milestone";

export interface GanttSubtask {
  id: string;
  name: string;
  start: string;
  duration: number;
  color: string;
}

export interface GanttTask {
  id: string;
  name: string;
  sectionId: string;
  status: GanttStatus;
  progress: number;
  locked: boolean;
  color: string;
  subtasks: GanttSubtask[];
}

export interface GanttSection {
  id: string;
  name: string;
}

export interface GanttDocument {
  title: string;
  dateFormat: string;
  axisFormat: string;
  excludes: string;
  todayMarker: string;
  view: GanttScale;
  sections: GanttSection[];
  tasks: GanttTask[];
  directives: string[];
}

export interface GanttParseResult {
  doc: GanttDocument;
  warnings: string[];
}

export const MARKMYMIND_SCHEMA = "markmymind.gantt/v2";
export const DAY_MS = 86_400_000;
export const RANGE_YEARS_BEFORE = 5;
export const RANGE_YEARS_AFTER = 5;

const STATUS_TOKENS: Record<string, GanttStatus> = {
  active: "active",
  done: "done",
  crit: "critical",
  critical: "critical",
  milestone: "milestone",
};

const DEFAULT_COLORS: Record<GanttStatus, string> = {
  todo: "#3867d6",
  active: "#2f6fed",
  done: "#16a085",
  critical: "#d84f4b",
  milestone: "#8e5ad8",
};

export function todayIso(): string {
  return formatIso(new Date());
}

export function parseIso(iso: string): Date {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (!match) {
    return new Date(Date.UTC(1970, 0, 1));
  }

  const [, year, month, day] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

export function formatIso(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

export function addDays(iso: string, days: number): string {
  const date = parseIso(iso);
  date.setUTCDate(date.getUTCDate() + days);

  return formatIso(date);
}

export function addMonths(iso: string, months: number): string {
  const date = parseIso(iso);
  return formatIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1)));
}

export function addYears(iso: string, years: number): string {
  const date = parseIso(iso);
  return formatIso(new Date(Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate())));
}

export function differenceInDays(start: string, end: string): number {
  return Math.round((parseIso(end).getTime() - parseIso(start).getTime()) / DAY_MS);
}

export function endDate(item: Pick<GanttSubtask, "start" | "duration">): string {
  return addDays(item.start, Math.max(1, item.duration));
}

export function startOfMonth(iso: string): string {
  const date = parseIso(iso);
  return formatIso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
}

export function startOfQuarter(iso: string): string {
  const date = parseIso(iso);
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;

  return formatIso(new Date(Date.UTC(date.getUTCFullYear(), quarterMonth, 1)));
}

export function startOfYear(iso: string): string {
  const date = parseIso(iso);
  return formatIso(new Date(Date.UTC(date.getUTCFullYear(), 0, 1)));
}

export function startOfWeek(iso: string): string {
  const date = parseIso(iso);
  const day = date.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + offset);

  return formatIso(date);
}

export function renderRangeAroundToday() {
  const start = startOfYear(addYears(todayIso(), -RANGE_YEARS_BEFORE));
  const end = addYears(startOfYear(todayIso()), RANGE_YEARS_AFTER + 1);

  return {
    start,
    end,
    days: differenceInDays(start, end),
  };
}

export function minIso(values: string[]): string {
  return values.reduce((current, value) => (value < current ? value : current), values[0]);
}

export function maxIso(values: string[]): string {
  return values.reduce((current, value) => (value > current ? value : current), values[0]);
}

export function taskStart(task: GanttTask): string {
  return minIso(ensureTaskSubtasks(task).map((subtask) => subtask.start));
}

export function taskEnd(task: GanttTask): string {
  return maxIso(ensureTaskSubtasks(task).map((subtask) => endDate(subtask)));
}

export function createSampleDocument(): GanttDocument {
  const start = addDays(todayIso(), -2);
  const sectionId = "section-main";

  return {
    title: "项目甘特图",
    dateFormat: "YYYY-MM-DD",
    axisFormat: "%m/%d",
    excludes: "",
    todayMarker: "stroke-width:2px,stroke:#5b7cfa,opacity:0.85",
    view: "month",
    sections: [{ id: sectionId, name: "默认分组" }],
    tasks: [
      createTask(sectionId, 1, start, "毕业论文", ["写初稿", "写综述"]),
      createTask(sectionId, 2, addDays(start, 1), "任务 2", ["任务 2"]),
      createTask(sectionId, 3, addDays(start, 2), "任务 3", ["任务 3"]),
    ],
    directives: [],
  };
}

export function parseGanttSource(source: string): GanttParseResult {
  const warnings: string[] = [];
  const doc = createSampleDocument();
  const taskMetadata = new Map<string, Record<string, unknown>>();
  const subtaskMetadata = new Map<string, Record<string, unknown>>();
  const taskById = new Map<string, GanttTask>();

  doc.title = "未命名甘特图";
  doc.sections = [];
  doc.tasks = [];
  doc.directives = [];

  let currentSection = ensureSection(doc, "默认分组");
  let lastTask: GanttTask | null = null;

  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((rawLine, index) => {
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed === "gantt") {
        return;
      }

      const ganttMeta = readJsonComment(trimmed, "markmymind:gantt");

      if (ganttMeta) {
        if (isGanttScale(ganttMeta.view)) {
          doc.view = ganttMeta.view;
        }

        return;
      }

      const taskMeta = readJsonComment(trimmed, "markmymind:task");

      if (taskMeta && typeof taskMeta.id === "string") {
        taskMetadata.set(taskMeta.id, taskMeta);
        return;
      }

      const subtaskMeta = readJsonComment(trimmed, "markmymind:subtask");

      if (subtaskMeta && typeof subtaskMeta.id === "string") {
        subtaskMetadata.set(subtaskMeta.id, subtaskMeta);
        return;
      }

      if (trimmed.startsWith("%%")) {
        doc.directives.push(trimmed);
        return;
      }

      if (trimmed.startsWith("title ")) {
        doc.title = trimmed.slice("title ".length).trim() || doc.title;
        return;
      }

      if (trimmed.startsWith("dateFormat ")) {
        doc.dateFormat = trimmed.slice("dateFormat ".length).trim() || doc.dateFormat;
        return;
      }

      if (trimmed.startsWith("axisFormat ")) {
        doc.axisFormat = trimmed.slice("axisFormat ".length).trim() || doc.axisFormat;
        return;
      }

      if (trimmed.startsWith("excludes ")) {
        doc.excludes = trimmed.slice("excludes ".length).trim();
        return;
      }

      if (trimmed.startsWith("todayMarker ")) {
        doc.todayMarker = trimmed.slice("todayMarker ".length).trim();
        return;
      }

      if (trimmed.startsWith("section ")) {
        currentSection = ensureSection(doc, trimmed.slice("section ".length).trim() || "默认分组");
        lastTask = null;
        return;
      }

      const customSubtask = parseSubtaskLine(trimmed, doc.tasks.length + 1);

      if (customSubtask) {
        const parent = taskById.get(customSubtask.taskId) ?? lastTask;

        if (parent) {
          parent.subtasks.push(customSubtask.subtask);
          return;
        }
      }

      const parsedTask = parseTaskLine(trimmed, currentSection.id, doc.tasks.length + 1);

      if (parsedTask) {
        doc.tasks.push(parsedTask);
        taskById.set(parsedTask.id, parsedTask);
        lastTask = parsedTask;
        return;
      }

      warnings.push(`第 ${index + 1} 行暂未识别，保存时不会写回：${trimmed}`);
    });

  if (!doc.sections.length) {
    currentSection = ensureSection(doc, "默认分组");
  }

  if (!doc.tasks.length) {
    const sample = createSampleDocument();
    doc.tasks = sample.tasks.map((task) => ({ ...task, sectionId: currentSection.id }));
    warnings.push("没有解析到任务，已创建默认任务。");
  }

  doc.tasks = doc.tasks.map((task) => {
    const meta = taskMetadata.get(task.id);
    const nextTask = applyTaskMetadata(task, meta);

    nextTask.subtasks = ensureTaskSubtasks(nextTask).map((subtask) => {
      const subtaskMeta = subtaskMetadata.get(subtask.id);

      return {
        ...subtask,
        color:
          typeof subtaskMeta?.color === "string" && subtaskMeta.color
            ? subtaskMeta.color
            : subtask.color || nextTask.color,
      };
    });

    return nextTask;
  });

  return { doc, warnings };
}

export function serializeGanttDocument(doc: GanttDocument): string {
  const lines = [
    "gantt",
    `    %% markmymind:gantt ${JSON.stringify({ schema: MARKMYMIND_SCHEMA, version: 2, view: doc.view })}`,
    ...doc.directives.map((line) => `    ${line.trim()}`),
    `    title ${sanitizeLine(doc.title || "未命名甘特图")}`,
    `    dateFormat ${doc.dateFormat || "YYYY-MM-DD"}`,
    `    axisFormat ${doc.axisFormat || "%m/%d"}`,
  ];

  if (doc.excludes.trim()) {
    lines.push(`    excludes ${sanitizeLine(doc.excludes)}`);
  }

  if (doc.todayMarker.trim()) {
    lines.push(`    todayMarker ${sanitizeLine(doc.todayMarker)}`);
  }

  doc.sections.forEach((section) => {
    lines.push(`    section ${sanitizeLine(section.name || "默认分组")}`);

    doc.tasks
      .filter((task) => task.sectionId === section.id)
      .forEach((task) => {
        lines.push(`    ${serializeTask(task)}`);
        lines.push(
          `    %% markmymind:task ${JSON.stringify({
            id: task.id,
            sectionId: task.sectionId,
            status: task.status,
            progress: clampNumber(task.progress, 0, 100, 0),
            locked: task.locked,
            color: task.color || DEFAULT_COLORS[task.status],
          })}`,
        );

        ensureTaskSubtasks(task).forEach((subtask) => {
          lines.push(`    ${serializeSubtask(task, subtask)}`);
          lines.push(
            `    %% markmymind:subtask ${JSON.stringify({
              id: subtask.id,
              taskId: task.id,
              color: subtask.color || task.color || DEFAULT_COLORS[task.status],
            })}`,
          );
        });
      });
  });

  return `${lines.join("\n")}\n`;
}

export function createTask(
  sectionId: string,
  index: number,
  start = todayIso(),
  name = `新任务 ${index}`,
  subtaskNames = [`子任务 ${index}`],
): GanttTask {
  const status: GanttStatus = index === 1 ? "active" : "todo";
  const color = statusColor(status);

  return {
    id: `task-${Date.now().toString(36)}-${index}`,
    name,
    sectionId,
    status,
    progress: status === "active" ? 35 : 0,
    locked: false,
    color,
    subtasks: subtaskNames.map((subtaskName, subtaskIndex) =>
      createSubtask(index, subtaskIndex + 1, subtaskName, addDays(start, subtaskIndex), color),
    ),
  };
}

export function createSubtask(
  taskIndex: number,
  subtaskIndex: number,
  name = `子任务 ${subtaskIndex}`,
  start = todayIso(),
  color = DEFAULT_COLORS.todo,
): GanttSubtask {
  return {
    id: `subtask-${Date.now().toString(36)}-${taskIndex}-${subtaskIndex}`,
    name,
    start,
    duration: 3,
    color,
  };
}

export function ensureTaskSubtasks(task: GanttTask): GanttSubtask[] {
  if (task.subtasks.length) {
    return task.subtasks;
  }

  task.subtasks.push(createSubtask(1, 1, task.name, todayIso(), task.color));
  return task.subtasks;
}

export function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.round(value));
}

export function normalizeProgress(value: number): number {
  return clampNumber(value, 0, 100, 0);
}

export function statusColor(status: GanttStatus): string {
  return DEFAULT_COLORS[status];
}

function parseTaskLine(line: string, sectionId: string, fallbackIndex: number): GanttTask | null {
  const colonIndex = line.indexOf(":");

  if (colonIndex < 0) {
    return null;
  }

  const name = sanitizeLine(line.slice(0, colonIndex).trim() || `任务 ${fallbackIndex}`);
  const tokens = splitTokens(line.slice(colonIndex + 1));

  let id = "";
  let start = "";
  let duration = 1;
  let status: GanttStatus = "todo";
  let isCustomTask = false;

  for (const token of tokens) {
    const lowered = token.toLowerCase();
    const tokenStatus = STATUS_TOKENS[lowered];

    if (lowered === "task") {
      isCustomTask = true;
      continue;
    }

    if (tokenStatus) {
      status = tokenStatus;
      continue;
    }

    if (isIsoDate(token)) {
      if (!start) {
        start = token;
      } else {
        duration = normalizeDuration(differenceInDays(start, token));
      }

      continue;
    }

    const durationMatch = token.match(/^(\d+)\s*d(?:ays?)?$/i);

    if (durationMatch) {
      duration = normalizeDuration(Number(durationMatch[1]));
      continue;
    }

    if (token.startsWith("after ") || token.startsWith("until ")) {
      continue;
    }

    if (!id) {
      id = normalizeTaskId(token, fallbackIndex);
    }
  }

  if (!id) {
    id = normalizeTaskId(name, fallbackIndex);
  }

  const color = DEFAULT_COLORS[status];

  return {
    id,
    name,
    sectionId,
    status,
    progress: status === "done" ? 100 : status === "active" ? 35 : 0,
    locked: false,
    color,
    subtasks: isCustomTask
      ? []
      : [
          {
            id: `${id}-subtask-1`,
            name,
            start: start || todayIso(),
            duration,
            color,
          },
        ],
  };
}

function parseSubtaskLine(
  line: string,
  fallbackIndex: number,
): { taskId: string; subtask: GanttSubtask } | null {
  const colonIndex = line.indexOf(":");

  if (colonIndex < 0) {
    return null;
  }

  const name = sanitizeLine(line.slice(0, colonIndex).trim() || `子任务 ${fallbackIndex}`);
  const tokens = splitTokens(line.slice(colonIndex + 1));

  if (tokens[0]?.toLowerCase() !== "subtask") {
    return null;
  }

  const taskId = tokens[1] || "";
  const id = tokens[2] || normalizeTaskId(name, fallbackIndex);
  const start = tokens.find(isIsoDate) ?? todayIso();
  const durationToken = tokens.find((token) => /^(\d+)\s*d(?:ays?)?$/i.test(token));
  const duration = durationToken ? normalizeDuration(Number(durationToken.match(/^(\d+)/)?.[1] ?? 1)) : 1;

  if (!taskId) {
    return null;
  }

  return {
    taskId,
    subtask: {
      id,
      name,
      start,
      duration,
      color: DEFAULT_COLORS.todo,
    },
  };
}

function serializeTask(task: GanttTask): string {
  const tokens = ["task", task.id].filter(Boolean);

  return `${sanitizeTaskName(task.name)} :${tokens.join(", ")}`;
}

function serializeSubtask(task: GanttTask, subtask: GanttSubtask): string {
  const tokens = ["subtask", task.id, subtask.id, subtask.start, `${normalizeDuration(subtask.duration)}d`];

  return `${sanitizeTaskName(subtask.name)} :${tokens.join(", ")}`;
}

function applyTaskMetadata(task: GanttTask, meta: Record<string, unknown> | undefined): GanttTask {
  if (!meta) {
    return task;
  }

  const status = isGanttStatus(meta.status) ? meta.status : task.status;

  return {
    ...task,
    status,
    sectionId: typeof meta.sectionId === "string" && meta.sectionId ? meta.sectionId : task.sectionId,
    progress: clampNumber(meta.progress, 0, 100, task.progress),
    locked: typeof meta.locked === "boolean" ? meta.locked : task.locked,
    color: typeof meta.color === "string" && meta.color ? meta.color : task.color || DEFAULT_COLORS[status],
  };
}

function ensureSection(doc: GanttDocument, name: string): GanttSection {
  const normalizedName = sanitizeLine(name || "默认分组");
  const existing = doc.sections.find((section) => section.name === normalizedName);

  if (existing) {
    return existing;
  }

  const section = {
    id: `section-${doc.sections.length + 1}`,
    name: normalizedName,
  };

  doc.sections.push(section);
  return section;
}

function readJsonComment(line: string, prefix: string): Record<string, unknown> | null {
  const commentPrefix = `%% ${prefix}`;

  if (!line.startsWith(commentPrefix)) {
    return null;
  }

  const jsonText = line.slice(commentPrefix.length).trim();

  try {
    const value = JSON.parse(jsonText);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function splitTokens(value: string): string[] {
  return value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeTaskId(value: string, fallbackIndex: number): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || `task-${fallbackIndex}`;
}

function sanitizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeTaskName(value: string): string {
  return sanitizeLine(value).replace(/:/g, "-");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.round(numericValue)));
}

function isGanttScale(value: unknown): value is GanttScale {
  return value === "week" || value === "month" || value === "quarter" || value === "year";
}

function isGanttStatus(value: unknown): value is GanttStatus {
  return value === "todo" || value === "active" || value === "done" || value === "critical" || value === "milestone";
}

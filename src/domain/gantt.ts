export type GanttScale = "day" | "week" | "month" | "quarter" | "year";

export interface GanttSubtask {
  id: string;
  name: string;
  start: string;
  duration: number;
  color: string;
  completed: boolean;
  expanded: boolean;
  children: GanttSecondLevelSubtask[];
  links: GanttLinkedItem[];
}

export interface GanttLinkedItem {
  id: string;
  name: string;
  start: string;
  duration: number;
  color: string;
  completed: boolean;
  expanded: boolean;
  children: GanttSecondLevelSubtask[];
}

export interface GanttSecondLevelSubtask {
  id: string;
  name: string;
  completed: boolean;
}

export interface GanttTask {
  id: string;
  name: string;
  sectionId: string;
  locked: boolean;
  color: string;
  subtasks: GanttSubtask[];
}

export interface GanttSection {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface GanttOutlineItem {
  type: "section" | "task";
  id: string;
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
  outline: GanttOutlineItem[];
  directives: string[];
}

export interface GanttParseResult {
  doc: GanttDocument;
  warnings: string[];
}

export const MARKMYMIND_SCHEMA = "markmymind.gantt/v6";
export const DAY_MS = 86_400_000;
export const RANGE_YEARS_BEFORE = 5;
export const RANGE_YEARS_AFTER = 5;

const IGNORED_MERMAID_STATUS_TOKENS = new Set(["active", "done", "crit", "critical", "milestone"]);
const DEFAULT_TASK_COLOR = "#9ac7ff";
const DEFAULT_SUBTASK_COLOR = "#9ac7ff";

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

export function renderRangeAroundToday(yearsBefore = RANGE_YEARS_BEFORE, yearsAfter = RANGE_YEARS_AFTER) {
  const before = Math.max(0, Math.round(yearsBefore));
  const after = Math.max(0, Math.round(yearsAfter));
  const start = startOfYear(addYears(todayIso(), -before));
  const end = addYears(startOfYear(todayIso()), after + 1);

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
  const starts = ensureTaskSubtasks(task).map((subtask) => subtask.start);

  return starts.length ? minIso(starts) : todayIso();
}

export function taskEnd(task: GanttTask): string {
  const ends = ensureTaskSubtasks(task).map((subtask) => endDate(subtask));

  return ends.length ? maxIso(ends) : todayIso();
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
    sections: [{ id: sectionId, name: "默认分组", collapsed: false }],
    tasks: [
      createTask(sectionId, 1, start, "毕业论文", ["写初稿", "写综述"]),
      createTask(sectionId, 2, addDays(start, 1), "任务 2", ["任务 2"]),
      createTask(sectionId, 3, addDays(start, 2), "任务 3", ["任务 3"]),
    ],
    outline: [{ type: "section", id: sectionId }],
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
  doc.outline = [];
  doc.directives = [];

  let currentSection: GanttSection | null = null;
  let lastSection: GanttSection | null = null;
  let lastTask: GanttTask | null = null;

  source
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((rawLine, index) => {
      const trimmed = rawLine.trim();

      if (!trimmed || trimmed === "gantt") {
        return;
      }

      if (trimmed === "%% markmymind:root") {
        currentSection = null;
        lastSection = null;
        lastTask = null;
        return;
      }

      const ganttMeta = readJsonComment(trimmed, "markmymind:gantt");

      if (ganttMeta) {
        if (isGanttScale(ganttMeta.view)) {
          doc.view = ganttMeta.view;
        }

        return;
      }

      const sectionMeta = readJsonComment(trimmed, "markmymind:section");

      if (sectionMeta && lastSection) {
        applySectionMetadata(doc, lastSection, sectionMeta);
        currentSection = lastSection;
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
        doc.outline.push({ type: "section", id: currentSection.id });
        lastSection = currentSection;
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

      const parsedTask = parseTaskLine(trimmed, currentSection?.id ?? "", doc.tasks.length + 1);

      if (parsedTask) {
        doc.tasks.push(parsedTask);
        taskById.set(parsedTask.id, parsedTask);
        if (!parsedTask.sectionId) {
          doc.outline.push({ type: "task", id: parsedTask.id });
        }
        lastTask = parsedTask;
        lastSection = null;
        return;
      }

      warnings.push(`第 ${index + 1} 行暂未识别，保存时不会写回：${trimmed}`);
    });

  if (!doc.tasks.length) {
    const sample = createSampleDocument();
    doc.sections = sample.sections;
    doc.tasks = sample.tasks;
    doc.outline = sample.outline;
    warnings.push("没有解析到任务，已创建默认任务。");
  }

  doc.tasks = doc.tasks.map((task) => {
    const meta = taskMetadata.get(task.id);
    const nextTask = applyTaskMetadata(task, meta);

    nextTask.subtasks = ensureTaskSubtasks(nextTask).map((subtask) => {
      const subtaskMeta = subtaskMetadata.get(subtask.id);
      const children = readSecondLevelSubtasks(subtaskMeta?.children);
      const links = readLinkedItems(subtaskMeta?.links ?? subtaskMeta?.associations, subtask, nextTask.color);

      return {
        ...subtask,
        children,
        links,
        completed: subtaskMeta?.completed === true || subtask.completed === true,
        expanded: children.length > 0 && subtaskMeta?.expanded === true,
        color:
          typeof subtaskMeta?.color === "string" && subtaskMeta.color
            ? subtaskMeta.color
            : subtask.color || nextTask.color,
      };
    });

    return nextTask;
  });

  normalizeDocumentStructure(doc);

  return { doc, warnings };
}

export function serializeGanttDocument(doc: GanttDocument): string {
  const lines = [
    "gantt",
    `    %% markmymind:gantt ${JSON.stringify({ schema: MARKMYMIND_SCHEMA, version: 6, view: doc.view })}`,
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

  const sectionById = new Map(doc.sections.map((section) => [section.id, section]));
  const taskById = new Map(doc.tasks.map((task) => [task.id, task]));
  let writingSection = false;

  function writeTask(task: GanttTask) {
    lines.push(`    ${serializeTask(task)}`);
    lines.push(
      `    %% markmymind:task ${JSON.stringify({
        id: task.id,
        sectionId: task.sectionId,
        locked: task.locked,
        color: task.color || DEFAULT_TASK_COLOR,
      })}`,
    );

    ensureTaskSubtasks(task).forEach((subtask) => {
      lines.push(`    ${serializeSubtask(task, subtask)}`);
      lines.push(
        `    %% markmymind:subtask ${JSON.stringify({
          id: subtask.id,
          taskId: task.id,
          color: subtask.color || task.color || DEFAULT_SUBTASK_COLOR,
          completed: subtask.completed,
          expanded: (subtask.children ?? []).length > 0 && subtask.expanded,
          children: subtask.children ?? [],
          links: subtask.links ?? [],
        })}`,
      );
    });
  }

  normalizedOutlineItems(doc).forEach((item) => {
    if (item.type === "section") {
      const section = sectionById.get(item.id);

      if (!section) {
        return;
      }

      lines.push(`    section ${sanitizeLine(section.name || "默认分组")}`);
      lines.push(
        `    %% markmymind:section ${JSON.stringify({
          id: section.id,
          collapsed: section.collapsed,
        })}`,
      );

      doc.tasks.filter((task) => task.sectionId === section.id).forEach(writeTask);
      writingSection = true;
      return;
    }

    const task = taskById.get(item.id);

    if (!task || task.sectionId) {
      return;
    }

    if (writingSection) {
      lines.push("    %% markmymind:root");
      writingSection = false;
    }

    writeTask(task);
  });

  return `${lines.join("\n")}\n`;
}

export function createTask(
  sectionId: string,
  index: number,
  start = todayIso(),
  name = `新任务 ${index}`,
  subtaskNames: string[] = [],
): GanttTask {
  const color = DEFAULT_TASK_COLOR;

  return {
    id: `task-${Date.now().toString(36)}-${index}`,
    name,
    sectionId,
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
  color = DEFAULT_SUBTASK_COLOR,
): GanttSubtask {
  return {
    id: `subtask-${Date.now().toString(36)}-${taskIndex}-${subtaskIndex}`,
    name,
    start,
    duration: 3,
    color,
    completed: false,
    expanded: false,
    children: [],
    links: [],
  };
}

export function createSection(index: number, name = `新分组 ${index}`): GanttSection {
  return {
    id: `section-${Date.now().toString(36)}-${index}`,
    name,
    collapsed: false,
  };
}

export function ensureTaskSubtasks(task: GanttTask): GanttSubtask[] {
  return task.subtasks;
}

export function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.round(value));
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
  let isCustomTask = false;

  for (const token of tokens) {
    const lowered = token.toLowerCase();

    if (lowered === "task") {
      isCustomTask = true;
      continue;
    }

    if (IGNORED_MERMAID_STATUS_TOKENS.has(lowered)) {
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

  const color = DEFAULT_TASK_COLOR;

  return {
    id,
    name,
    sectionId,
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
            completed: false,
            expanded: false,
            children: [],
            links: [],
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
      color: DEFAULT_SUBTASK_COLOR,
      completed: false,
      expanded: false,
      children: [],
      links: [],
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

  return {
    ...task,
    sectionId: typeof meta.sectionId === "string" && meta.sectionId ? meta.sectionId : task.sectionId,
    locked: typeof meta.locked === "boolean" ? meta.locked : task.locked,
    color: typeof meta.color === "string" && meta.color ? meta.color : task.color || DEFAULT_TASK_COLOR,
  };
}

function applySectionMetadata(doc: GanttDocument, section: GanttSection, meta: Record<string, unknown>) {
  const previousId = section.id;

  if (typeof meta.id === "string" && meta.id) {
    section.id = meta.id;
  }

  section.collapsed = meta.collapsed === true;

  if (section.id === previousId) {
    return;
  }

  doc.outline.forEach((item) => {
    if (item.type === "section" && item.id === previousId) {
      item.id = section.id;
    }
  });

  doc.tasks.forEach((task) => {
    if (task.sectionId === previousId) {
      task.sectionId = section.id;
    }
  });
}

function normalizeDocumentStructure(doc: GanttDocument) {
  doc.sections = doc.sections.map((section, index) => ({
    id: section.id || `section-${index + 1}`,
    name: section.name || `分组 ${index + 1}`,
    collapsed: section.collapsed === true,
  }));

  const sectionIds = new Set(doc.sections.map((section) => section.id));

  doc.tasks = doc.tasks.map((task) => ({
    ...task,
    sectionId: sectionIds.has(task.sectionId) ? task.sectionId : "",
    locked: task.locked === true,
    color: task.color || DEFAULT_TASK_COLOR,
    subtasks: ensureTaskSubtasks(task).map((subtask) => ({
      ...subtask,
      duration: normalizeDuration(subtask.duration),
      color: subtask.color || task.color || DEFAULT_SUBTASK_COLOR,
      completed: subtask.completed === true,
      expanded: (subtask.children ?? []).length > 0 && subtask.expanded === true,
      children: (subtask.children ?? []).map((child, childIndex) => ({
        id: child.id || `child-${childIndex + 1}`,
        name: child.name,
        completed: child.completed === true,
      })),
      links: ((subtask as GanttSubtask & { associations?: GanttLinkedItem[] }).links ??
        (subtask as GanttSubtask & { associations?: GanttLinkedItem[] }).associations ??
        []
      ).map((link, linkIndex) => normalizeLinkedItem(link, subtask, task.color, linkIndex)),
    })),
  }));

  doc.outline = normalizedOutlineItems(doc);
}

function normalizedOutlineItems(doc: GanttDocument): GanttOutlineItem[] {
  const sectionById = new Map(doc.sections.map((section) => [section.id, section]));
  const taskById = new Map(doc.tasks.map((task) => [task.id, task]));
  const seenSections = new Set<string>();
  const seenRootTasks = new Set<string>();
  const items: GanttOutlineItem[] = [];

  (doc.outline ?? []).forEach((item) => {
    if (item.type === "section" && sectionById.has(item.id) && !seenSections.has(item.id)) {
      items.push({ type: "section", id: item.id });
      seenSections.add(item.id);
      return;
    }

    const task = item.type === "task" ? taskById.get(item.id) : null;

    if (task && !task.sectionId && !seenRootTasks.has(task.id)) {
      items.push({ type: "task", id: task.id });
      seenRootTasks.add(task.id);
    }
  });

  doc.sections.forEach((section) => {
    if (!seenSections.has(section.id)) {
      items.push({ type: "section", id: section.id });
      seenSections.add(section.id);
    }
  });

  doc.tasks.forEach((task) => {
    if (!task.sectionId && !seenRootTasks.has(task.id)) {
      items.push({ type: "task", id: task.id });
      seenRootTasks.add(task.id);
    }
  });

  return items;
}

function ensureSection(doc: GanttDocument, name: string): GanttSection {
  const normalizedName = sanitizeLine(name || "默认分组");

  const section = {
    id: `section-${doc.sections.length + 1}`,
    name: normalizedName,
    collapsed: false,
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

function readLinkedItems(value: unknown, parent: GanttSubtask, fallbackColor: string): GanttLinkedItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      return normalizeLinkedItem(item as Partial<GanttLinkedItem>, parent, fallbackColor, index);
    })
    .filter((item): item is GanttLinkedItem => Boolean(item));
}

function normalizeLinkedItem(
  item: Partial<GanttLinkedItem>,
  parent: Pick<GanttSubtask, "id" | "start" | "duration" | "color">,
  fallbackColor: string,
  index: number,
): GanttLinkedItem {
  const parentEnd = endDate(parent);
  const parentDuration = normalizeDuration(parent.duration);
  const duration = Math.min(normalizeDuration(Number(item.duration ?? 1)), parentDuration);
  const latestStart = addDays(parentEnd, -duration);
  const rawStart = typeof item.start === "string" && isIsoDate(item.start) ? item.start : parent.start;
  const start = rawStart < parent.start ? parent.start : rawStart > latestStart ? latestStart : rawStart;
  const maxDuration = Math.max(1, differenceInDays(start, parentEnd));

  return {
    id: typeof item.id === "string" && item.id ? item.id : `${parent.id}-link-${index + 1}`,
    name: typeof item.name === "string" && item.name ? sanitizeLine(item.name) : `关联项 ${index + 1}`,
    start,
    duration: Math.min(duration, maxDuration),
    color: parent.color || fallbackColor || DEFAULT_SUBTASK_COLOR,
    completed: item.completed === true,
    expanded: Array.isArray(item.children) && item.children.length > 0 && item.expanded === true,
    children: readSecondLevelSubtasks(item.children),
  };
}

function readSecondLevelSubtasks(value: unknown): GanttSecondLevelSubtask[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return { id: `child-${index + 1}`, name: sanitizeLine(item), completed: false };
      }

      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const name = typeof record.name === "string" ? sanitizeLine(record.name) : "";

      if (!name) {
        return null;
      }

      return {
        id: typeof record.id === "string" && record.id ? record.id : `child-${index + 1}`,
        name,
        completed: record.completed === true,
      };
    })
    .filter((item): item is GanttSecondLevelSubtask => Boolean(item));
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

function isGanttScale(value: unknown): value is GanttScale {
  return value === "day" || value === "week" || value === "month" || value === "quarter" || value === "year";
}

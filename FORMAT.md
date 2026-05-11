# MarkMyMind Gantt Format

MarkMyMind 的文件以 Mermaid Gantt 源码为唯一真源。数据文件不使用 Markdown、YAML front matter 或外部 JSON sidecar。

扩展约定使用 Mermaid 注释承载。v2 开始，主任务和子任务线分离保存；这已经不追求 Mermaid 原生语义完全兼容，但文件仍然是单一 Mermaid 源码文本。

```mermaid
gantt
    %% markmymind:gantt {"schema":"markmymind.gantt/v2","version":2,"view":"month"}
    title 项目甘特图
    dateFormat YYYY-MM-DD
    axisFormat %m/%d
    todayMarker stroke-width:2px,stroke:#5b7cfa,opacity:0.85
    section 默认分组
    毕业论文 :task, task-1
    %% markmymind:task {"id":"task-1","sectionId":"section-main","status":"active","progress":35,"locked":false,"color":"#2f6fed"}
    写初稿 :subtask, task-1, subtask-1, 2026-05-09, 4d
    %% markmymind:subtask {"id":"subtask-1","taskId":"task-1","color":"#2f6fed"}
    写综述 :subtask, task-1, subtask-2, 2026-05-12, 3d
    %% markmymind:subtask {"id":"subtask-2","taskId":"task-1","color":"#3867d6"}
```

规则：

- 第一行必须是 `gantt`。
- 标题、日期格式、坐标格式使用 Mermaid 原生命令。
- 主任务写作 `主任务名 :task, task-id`。
- 子任务线写作 `子任务名 :subtask, task-id, subtask-id, YYYY-MM-DD, Nd`。
- MarkMyMind 元数据使用 `%% markmymind:* {json}` 注释行。
- 旧的 Mermaid 原生任务行仍会被兼容读取，并自动转换为“主任务 + 一个同名子任务”。
- 保存时会输出规范化源码；暂不支持的 Mermaid 行会在打开时给出解析提醒。

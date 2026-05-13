# MarkMyMind

MarkMyMind 是一个基于 Tauri、Rust 和 Vue 的桌面甘特图编辑器。应用以 Mermaid 甘特源码文件作为唯一真源，在可视化时间轴中编辑任务、分组、子任务、关联项和今日待办状态，并把结果保存回源码文件。

## 功能概览

- 直接打开、编辑和保存 `.mmd` / Mermaid 甘特源码文件
- 支持主任务、任务分组、一级子任务、二级子任务和关联项
- 支持天、周、月、季、年视图，以及今日待办事项视图
- 支持拖拽调整时间、颜色配置、撤销、快捷键和多标签页
- 使用 Mermaid 兼容的扩展注释保存 MarkMyMind 专用元数据

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm run tauri build
```

Windows 可执行文件通常会生成在 `src-tauri/target/release/` 和 `src-tauri/target/release/bundle/` 下。

## License

MIT

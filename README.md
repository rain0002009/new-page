# 拾页 · Page Garden

一个用空间和收藏块整理网页的 Chrome 新标签页扩展。React + TypeScript，使用 Extension.js 构建、pnpm 管理依赖，UnoCSS 与 tailwind-variants 管理样式。奶白色背景与鼠尾草绿主题。

## 开发与安装

```powershell
pnpm install
pnpm dev:chrome
```

开发命令启动独立的 Chrome 配置。生产构建：

```powershell
pnpm typecheck
pnpm build:chrome
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，加载 `dist/chrome`，再打开新标签页。

## 使用

首次打开填写昵称和 HTTPS WebDAV 地址、用户名、密码，并授权扩展访问该服务器。空数据源会初始化“我的空间”和“日常收藏”；已有数据源直接读取收藏。

- 左侧管理空间、全局 Todo、搜索和设置。拖动空间调整默认顺序；每次重开默认进入第一个空间。
- 中间管理收藏块和链接。拖动收藏块左侧手柄排序，拖动链接卡片排序或移到同空间的其他块。折叠块也能接收拖入。
- 右侧显示本新标签页所属窗口的 HTTP/HTTPS 网页。拖入收藏块即保存，原标签页继续保留。右上角批量收藏按钮只要求填写新收藏块名称。窄窗口点击右下角入口打开待选抽屉。
- 卡片悬浮或键盘聚焦时可编辑、删除、移动和切换书签。编辑弹窗中有效改动自动保存；点亮书签即加入全局 Todo，完成只熄灭该卡片的标记。
- `/` 打开全空间搜索，匹配标题、网址和备注，结果可定位原收藏块。
- 设置中修改昵称、查看同步状态、重试同步、配置或迁移数据源、导入/导出 JSON 备份，以及恢复 30 天内删除的内容。

## WebDAV 与数据

所有内容先保存在 `chrome.storage.local`，再由扩展后台同步。离线可继续修改，页面和浏览器重开后保留；联网事件、待上传操作和每分钟后台检查会触发重试。TanStack Query 管理界面读取和刷新，业务工作副本独立持久化。

服务器须支持 HTTPS、Basic 认证、PROPFIND、MKCOL、GET、PUT、DELETE、强 ETag，以及正确执行 `If-Match` / `If-None-Match` 条件写入。首次连接用临时探针检查能力，随后清除探针。服务器应提前存在用户填写的根目录；扩展在其下使用 `new-page/data-v1.json`。重定向不自动跟随。

不同条目的修改自动合并；同一内容发生冲突时，两个版本保留在本机，设置页可选择版本。同步在冲突处理完前暂停上传。删除事实保留为墓碑，30 天后清除对应正文，避免旧设备直接带回删除内容。

切换数据源保留各自的缓存和待上传修改。迁移会先读取目标，已有数据时要求确认合并。导入也先验证格式，并在当前有收藏时确认合并。

密码只保存在当前设备的扩展本地存储，不进入业务 JSON、备份或日志。本地存储没有额外加密，卸载扩展会移除本地数据；建议定期导出备份。首版不包含夸克登录，也不保证兼容所有 WebDAV 服务；目前自动化验证使用受控 HTTPS WebDAV 端点。

## 自动化验证

```powershell
pnpm test
```

测试通过真实 Chrome 新标签页与扩展后台，使用隔离配置、受控 HTTPS WebDAV 服务和两个独立客户端。验证收藏、拖拽、Todo、搜索、回收站、备份、离线编辑、冲突和数据源隔离。

默认使用 Windows 安装的 `C:/Program Files/Google/Chrome/Application/chrome.exe`。其他位置可设置 `CHROME_PATH`。测试使用 Chrome DevTools 的扩展加载能力，需要支持 `Extensions.loadUnpacked` 的 Chrome 版本；仅在隔离的测试配置中启用该调试能力。测试副本预授权 localhost，生产包仍在用户点击连接时申请指定服务器权限。

## 代码导航

- `src/newtab/`：界面、待选网页适配和拖放。
- `src/core/model.ts`：领域约束、操作、删除和恢复。
- `src/core/workspace.ts`：本地持久化、同步协调和数据源隔离。
- `src/core/merge.ts`：合并与冲突解决。
- `src/core/webdav.ts`：WebDAV 验证、版本读取和条件写入。
- `src/background.ts`：消息边界与后台重试。
- `docs/specs/new-tab-bookmarks.md`：完整规格。
- `CONTEXT.md`、`docs/adr/`：领域术语与架构决策。

任务跟踪使用 GitHub Issues（`rain0002009/new-page`）；技能入口为 `AGENTS.md`。

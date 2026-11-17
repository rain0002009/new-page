# 发布材料验证与剩余事项

记录日期：2026-11-14；首版 1.0.0 已发布，1.2.0 版本准备更新于 2026-11-17（Asia/Shanghai）。目标：Chrome Manifest V3，页墟 · Page Garden 1.2.0。

## 1.2.0 版本准备与发布验证（2026-11-17）

- 首版 1.0.0 已成功通过 Chrome 应用商店审核并正式发布：https://chromewebstore.google.com/detail/fonjkepbgbaijaghboomgbkpohhopomm 。
- `package.json` 与 `src/manifest.json` 保持一致，版本均为 1.2.0。
- `pnpm typecheck` 通过。
- `node --test scripts/prepare-chrome-store.test.mjs` 6 项测试全部通过。
- `pnpm build:chrome` 成功完成 1.2.0 生产构建（构建环境：Node 22.23.1、pnpm 12.16.1、Extension.js 4.1.39）。
- `pnpm package:chrome` 成功生成 `dist/page-garden-1.2.0.zip` 及商店材料：
  - 文件数：166
  - 上传包 SHA-256：`79cfee625a88de560b706f553c1f4a26c7551b87de945e04c636a94c82924328`
  - 重新渲染包含 1.2.0 文本分享隐私说明的 `dist/chrome-store/privacy-policy.html`。
- 商店文案（`listing.md`）、权限填报（`permissions.md`）、隐私政策（`privacy-policy.md`）及审核说明（`reviewer-instructions.md`）均已按 1.2.0 新增的 Markdown 笔记文本分享、废纸篓拖拽删除、流体动画等能力全面更新。

## 隐私政策发布（2026-11-15）

- 按用户要求将 `rain0002009/new-page` 仓库从 private 改为 public，GitHub API 已确认 PUBLIC。
- 使用独立 `gh-pages` 分支发布隐私政策 HTML、Markdown、首页和 `.nojekyll`。Pages 来源为该分支根目录，HTTPS 已启用；发布提交为 `b9aa451b00562659906376c133d3453a1a05d840`，构建状态为 built。
- 隐私政策地址：https://rain0002009.github.io/new-page/privacy-policy.html 。通过未附带登录凭据的 HTTPS 请求验证 HTTP 200，返回正文包含产品名称及 English summary。
- 后续政策修改需同步部署到 `gh-pages`；本地打包不会自动发布网站。

## Node.js 打包验证（2026-11-15）

- 使用 `scripts/prepare-chrome-store.mjs` 替代原 PowerShell 脚本，命令为 `pnpm package:chrome`。无新增依赖；ZIP 使用 Node.js 内置 zlib，截图处理使用已有 Playwright 和本机 Chrome。
- `node --test scripts/prepare-chrome-store.test.mjs`：6 项通过，覆盖构建文件收集、缺失资源、版本不一致、开发与凭据文件排除、远程脚本拒绝、ZIP 压缩与 CRC-32、中文与空文件条目、路径检查和隐私政策转义。
- `pnpm typecheck` 通过。实际执行打包命令，并从 dist 目录再次直接运行脚本，两次 ZIP 的 SHA-256 一致。
- 独立使用 .NET ZIP 读取器解压读取全部 166 个条目，内容哈希与 dist/chrome 对应文件逐项一致；manifest.json 位于根目录，路径使用正斜线，无重复或向上跳转路径。ZIP 为 1,333,516 字节，SHA-256：`5562e9ff952b8bc32f624cbb1a01cf097efdd89f91b2c01c6e34ba1f666be893`。后续构建以重新生成的 package-info.json 为准。
- 四张生成的 PNG 均为 1280×800，图标为 128×128。项目未配置 lint 或独立静态分析脚本；本次执行类型检查、脚本回归与包内容检查，未重复运行产品浏览器回归。

## 先前验证（2026-11-14）

- 商店文案、单一用途、逐项权限用途、数据类型建议、中英隐私政策、英文审核步骤和材料索引已保存到本目录。另一次只读审阅对照运行时实现核对，未发现事实错误或关键遗漏。
- `pnpm typecheck` 通过。
- `pnpm build:chrome` 通过，输出为 dist/chrome。实际工具版本为 Node 24.22.1、pnpm 11.25.0、Extension.js 4.1.39；仓库声明 pnpm 12.16.1，未验证跨工具版本的逐字节可重现构建。
- 下方 74 项构建预算、图片、回收站和夸克请求测试全部通过（5.3 秒）。

```powershell
pnpm exec playwright test tests/build-budget.spec.ts tests/see.spec.ts tests/hosted-images.spec.ts tests/image-references.spec.ts tests/local-image-files.spec.ts tests/quark-requests.spec.ts tests/recycle-bin.spec.ts --output test-results/store-preparation-unit-fixed
```

- 下方 4 项真实隔离 Chrome 流程全部通过（25.2 秒），覆盖笔记新建/离线重开/导出、Markdown 接管、首次夸克二维码和首次 WebDAV 连接后的跨设备保存。

```powershell
pnpm exec playwright test tests/workbench.spec.ts --grep '首次连接后添加收藏|托管笔记新建后独立编辑|夸克首次安装直接显示二维码|Markdown 主页面默认接管' --output test-results/store-preparation-smoke
```

- 首次测试发现“迁移到空夸克账号”夹具将源与目标设成相同 folderId，独立重现同源保护错误。只在该测试目标增加 `folderId: 'target-root'`，保留生产代码和同源保护；修正后上述 74 项全部通过。没有将真实服务风险解释成已修复的产品缺陷。
- 当时的 PowerShell 打包脚本已实际执行，并重新执行验证。生成 ZIP 根目录含 manifest.json，165 个条目与当时的 dist/chrome 对应文件逐字节一致；条目名使用正斜线，压缩文件为 1,323,261 字节。该脚本已由上述 Node.js 版本替代。
- 当时 `page-garden-1.0.0.zip` SHA-256：`c252c9aacd72292aab64ab3f1e4adea49ae9dbe900733bf9c41118fb57805875`。此值仅作为历史记录。
- 四张 PNG 截图均为 1280×800，图标为 128×128。由 1440×960 真实示例截图等比缩放并加左右留边，完整保留内容；人工检查缩略图总览，未见裁断、变形或真实凭据。没有新增宣传图，宣传图和视频为可选素材。
- 隐私政策 HTML 通过本机无头 Chrome 打开：标题与正文编码正确，七个二级章节完整，无脚本、外部网络请求、页面错误或横向溢出。预览为 dist/chrome-store/privacy-policy-preview.png。
- 生产 HTML 的脚本引用均为包内路径；针对生产 JS 的 eval/new Function/远程 importScripts 文本检查未发现命中。源码网络入口为数据、文档和图片用途。该检查不等同于完整安全审计或所有依赖分支的运行时网络证明。
- Git diff 空白检查通过。项目未配置 lint 或独立静态分析脚本；执行了类型检查、构建预算与包内容静态检查，没有虚构 lint 结果。未运行完整 workbench 全量回归。

## 提交前仍待完成

| 项目 | 当前状态 / 下一步 |
| --- | --- |
| 开发者账号 | 未操作注册、付费、两步验证或身份验证；由账号所有者完成 |
| 发布者资料 | 确认开发者名称、可联系邮箱、价格、国家/地区 |
| 隐私政策网址 | 已部署到上述 GitHub Pages HTTPS 地址并验证 HTTP 200；后续政策变更需同步部署 |
| 审核访问 | 未提供外网可用的专用 WebDAV 凭据；首次连接没有匿名跳过入口。夸克专属路径另需真实可完成的扫码安排 |
| 权限必要性 | <all_urls> 已解释但尚未完成最小范围决策；显式云端域名与其重复，UC 域名的真实服务必要性尚未验证 |
| 真实服务验收 | 本轮 Chrome 测试使用受控 HTTPS 服务，没有完成真实账号的夸克扫码确认/上传或 s.ee 上传 |
| 系统文件授权 | 真实文件选择器、文件网址访问与原生写入授权需要安装后验收；不要把受控授权测试等同于真实点击 |
| 商店操作 | 隐私政策网站已发布；尚未上传扩展、提交审核、发布扩展或创建测试服务器 |

## 变更范围

商店准备材料涉及 docs/chrome-web-store/、README 的材料入口及 tests/quark-requests.spec.ts 的一个目标目录夹具。打包脚本现为 scripts/prepare-chrome-store.mjs，附有同目录的脚本测试，并通过 package.json 提供 package:chrome 命令。打包脚本迁移未修改生产功能和权限配置。生成文件位于已被 Git 忽略的 dist：ZIP 输出到 dist 根目录，其他材料输出到 dist/chrome-store，可用脚本重新生成。

独立审阅与截图核对已完成。visual-verdict 技能在当前列出的安装目录中不存在，本次使用直接图像检查并将结果保存在 .omx/state/chrome-store/ralph-progress.json，没有启动 OMX 或 Ralph 运行模式。

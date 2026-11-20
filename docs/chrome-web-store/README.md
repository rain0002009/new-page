# Chrome 应用商店发布材料

产品：页墟 · Page Garden；目标版本：1.3.0。首版 1.0.0 已在 [Chrome 应用商店](https://chromewebstore.google.com/detail/fonjkepbgbaijaghboomgbkpohhopomm) 正式发布。材料根据 1.3.0 源码和生产构建更新。

本目录是可审阅的提交材料。隐私政策已发布到 [GitHub Pages](https://rain0002009.github.io/new-page/privacy-policy.html)。商店账号和审核测试凭据尚未配置，最新验证与待办见 [validation.md](validation.md)。

## 文件用途

| 文件 | 用法 |
| --- | --- |
| [listing.md](listing.md) | 复制商店名称、简介、详细介绍与单一用途 |
| [permissions.md](permissions.md) | 复制权限用途、远程代码说明，参考数据披露建议 |
| [privacy-policy.md](privacy-policy.md) | 可公开发布的中英文隐私政策正文 |
| [reviewer-instructions.md](reviewer-instructions.md) | 测试步骤与审核备注；提交前在后台补充真实专用测试凭据 |
| [validation.md](validation.md) | 验证结果、发布前待办和已知限制 |

## 生成上传文件

在项目根目录运行：

```powershell
pnpm typecheck
pnpm build:chrome
pnpm package:chrome
```

脚本为 [scripts/prepare-chrome-store.mjs](../../scripts/prepare-chrome-store.mjs)，也可直接运行 `node scripts/prepare-chrome-store.mjs`，不受当前工作目录影响。需要 Node.js 22.2 或更新版本、已安装的项目依赖和 Google Chrome（通过已有 Playwright 将截图等比缩放）。ZIP 使用 Node.js 内置模块生成，无需 PowerShell 或新增依赖。

脚本仅打包已有的生产构建，不重新构建。ZIP 输出到 `dist/` 根目录，其余材料输出到 `dist/chrome-store/`：

- `dist/page-garden-1.3.0.zip`：扩展上传包，根目录直接包含 manifest.json。
- `dist/chrome-store/assets/icon-128.png`：商店图标。
- `dist/chrome-store/assets/01-overview.png` 至 `04-todo.png`：四张 1280×800 商店截图，使用现有 README 的示例内容，等比缩放并留边，不裁切功能界面。
- `dist/chrome-store/privacy-policy.html`：无需脚本或外部资源的隐私政策网页，部署到公开 HTTPS 地址后填写后台。
- `dist/chrome-store/package-info.json`：ZIP 的 SHA-256、版本和构建文件数量；`zip` 字段为相对此 JSON 的路径，例如 `../page-garden-1.0.0.zip`。

脚本拒绝版本不一致、缺失入口、源码、凭据文件、符号链接和 HTML 中的远程脚本；ZIP 使用固定时间戳，相同构建内容生成相同 ZIP。脚本回归检查：`node --test scripts/prepare-chrome-store.test.mjs`。

安装包不包含文案、截图源文件、浏览器配置、测试夹具或签名私钥。不要上传整个 dist 目录，也无需自行签名 CRX。

## 还需要账号所有者完成的信息

1. Chrome 商店开发者注册、付费、两步验证以及后台要求的身份或联系邮箱验证。
2. 确认公开显示的开发者名称、联系邮箱、是否免费、发布国家/地区。建议主要语言为简体中文、首版免费，但这些不是已经确认的商业决定。
3. 隐私政策 URL 填写 `https://rain0002009.github.io/new-page/privacy-policy.html`。页面已于 2026-11-15 发布并验证无需登录可访问；后续修改政策时须同步更新远端 `gh-pages` 分支的 HTML 与 Markdown，运行打包命令仅更新本地文件。
4. 向审核人员提供可正常联网的专用 WebDAV 测试账号，或确保夸克扫码方式实际可完成。不要把个人 Cookie、API Key 或测试密码提交到 Git。
5. 完成真实夸克账号的扫码与上传、本地文件选择和写入授权验收，处理 validation.md 中的失败项，再提交审核。

## 后台操作顺序

进入开发者后台 → 新建项目 → 上传 ZIP → 填商店信息和截图 → 填隐私政策 URL、单一用途、权限用途和数据使用披露 → 填分发设置 → 填审核测试说明和凭据 → 提交审核。可选择审核通过后手动发布。

## 官方参考

以下官方页面已在本次会话前一轮读取核对；提交时仍以实际后台字段为准。

- [注册开发者账号](https://developer.chrome.com/docs/webstore/register)
- [商店文案与素材要求](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)：128×128 图标、至少一张 1280×800 截图，最多五张；宣传图和视频可选。
- [隐私与权限披露](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [首次发布流程](https://developer.chrome.com/docs/webstore/publish)

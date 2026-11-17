# 审核测试说明

## 提交前必须补充的访问方式

当前首次打开必须连接收藏库，没有“跳过登录”入口。下面的说明已经准备好，但不能代替真实测试账号。建议在开发者后台私密的 Test instructions 字段提供专用 HTTPS WebDAV 服务器地址、用户名和应用密码，使审核人员不依赖个人手机即可测试核心功能。不要将凭据写入本文件或公开仓库。

WebDAV 服务器必须可从外网访问、证书可信，并支持 Basic 认证、PROPFIND、MKCOL、GET、PUT、DELETE、强 ETag 与正确的 If-Match / If-None-Match。本地自动化使用的 localhost 服务不供商店审核访问。

夸克专属登录与同步需使用夸克 App 扫码；WebDAV 账号只解决核心功能的可访问性，不能替代夸克路径的验收。若审核人员无法完成扫码，需要提供审核可用的真实测试安排。不得提供个人 Cookie 或虚构“测试模式”。

## English reviewer note (copy after adding real access details privately)

Page Garden replaces the Chrome new tab page with a personal workspace for saving and organizing web pages and Markdown notes. The UI is in Simplified Chinese. The extension is an independent project and is not affiliated with Google, Quark or s.ee.

Initial workspace creation requires Quark QR sign-in or a compatible HTTPS WebDAV server. There is no skip-sign-in/local-only onboarding button. Please use the dedicated WebDAV test endpoint and credentials provided separately in this private test-instructions field. Those credentials have NOT been included in the source repository or the extension package.

1. Install the extension and open a new tab. Select “WebDAV”. Fill “昵称” (any nickname), “WebDAV 地址” (test server URL), “用户名” (username), and “密码或应用专用密码” (test application password). Click “连接并开始”. A fresh account initializes “我的空间” and “日常收藏”.
2. Open two ordinary web pages in the same window. Return to the extension. They appear in the right-side “待选网页” area. Drag a page into a collection, or use “一键收藏”. The extension saves the links before closing those source tabs.
3. Create a space with the sidebar + button and a collection with “新建收藏块”. Edit saved-link titles and remarks. Use the native group controls in the tab inbox to create/rename/color/ungroup Chrome tab groups; select several items for batch actions.
4. Toggle a saved link's bookmark mark to add it to “Todo”. Open Todo in the sidebar and reorder or complete it. Completing a Todo mark keeps the saved link.
5. Create a note using the document icon on a collection. Edit its title and Markdown body in the separate editor tab. Changes save automatically; export with “导出”. Return to the workspace and use “搜索收藏” or / to find the note text.
6. After a successful connection, go offline and edit existing data. Reopen the extension: local changes remain. Reconnect and check synchronization in “设置”. Test data can be written to and deleted from the dedicated test account.
7. In settings, export a JSON backup and import that backup. Recycle-bin restoration applies to links, collections and spaces. Separately deleting a single note is immediately permanent; use sample notes only.
8. Drag-to-trash deletion: Drag an item from the right-side tab inbox or a collection card directly onto the open trash can icon at the bottom of the sidebar to immediately close/delete it. Click the trash can to inspect the recycle bin; double click to confirm emptying.
9. Note text sharing: With a valid s.ee key configured, click the share icon on any note card to generate a public shortlink with optional password or expiry. View and manage existing shares in the sidebar '分享管理' (Share Management) panel.

Quark-specific path: select “夸克网盘”, click “扫码登录夸克”, and use the Quark mobile app to scan and confirm the displayed QR code. Expired codes can be refreshed. Quark data is stored under “页墟收藏”, with the current 收藏.json and per-note Markdown copies. The extension directly uses the user's account; it has no developer-hosted proxy.

Local Markdown: open/drop a sample .md file. Writing back requires Chrome's file-system permission. Automatic file: URL reading additionally requires “Allow access to file URLs” on the extension detail page. Denying write access should keep a readable/exportable document; a lost permission should preserve an unsaved draft for reauthorization. Opening a folder requires its own Chrome file picker authorization.

Remote Markdown: navigate to a public raw .md or .markdown URL served with a supported text/Markdown Content-Type. The extension opens its reader; an HTML file-viewer page with an .md suffix remains on its original website. Automatic takeover can be disabled in settings. Remote Markdown is read-only.

s.ee image upload and note text sharing are optional and require a user's own valid s.ee API key. Without a key the upload and share controls are hidden. A key is synchronized and included in JSON backups. Uploaded images use public URLs; removing references may trigger delayed deletion after synchronization and reference checks. Note text shares generate public shortlinks with optional password/expiry; deleting local notes does not revoke shortlinks unless removed via Share Management. A dedicated s.ee test key would be required to verify live upload/share; no live key has been fabricated or embedded.

## Build and permission notes

Source: https://github.com/rain0002009/new-page . Build with pnpm install --frozen-lockfile, pnpm typecheck and pnpm build:chrome. The prepared build used Node 22.23.1, pnpm 12.16.1 and Extension.js 4.1.39. package.json declares pnpm 12.16.1; byte-identical reproducibility across different tool versions has not been established. The actual packaged files and SHA-256 are recorded in package-info.json.

All executable JavaScript is bundled locally, including editor/language chunks. Network services supply user data and images, not executable extension code. Permissions support the tab inbox and Chrome tab groups, local persistence, background retry, Markdown navigation, and authenticated Quark requests. The broad host permission supports arbitrary user-selected Markdown/WebDAV hosts and local file URLs; the manifest also explicitly lists Quark/upload domains. See the permission justifications submitted separately.

## 本机验证的边界

自动化使用隔离 Chrome 和受控 HTTPS 服务，不代表真实夸克账号、公开 WebDAV 服务或 s.ee 账号已经通过测试。系统文件选择和真实授权点击也需要单独验收。最新结果见 validation.md。

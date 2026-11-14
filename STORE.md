# Store metadata (unpublished)

Last updated: 2026-11-14

## Listing

- Name: 页墟 · Page Garden
- Summary: 用空间和收藏块整理网页，用书签标记 Todo，通过自己的 WebDAV 同步收藏。
- Language: zh-CN
- License: MIT
- Status: Chrome 本地开发版本，未提交商店。

## Purpose and permissions

新标签页收藏工作台：整理链接、收集当前窗口网页、全局 Todo、搜索、回收站和 WebDAV 同步。

- storage：保存本地工作副本、待同步状态和仅本机使用的 WebDAV 凭据。
- tabs：读取本新标签页所属窗口的网页标题、网址和图标，实时更新待选区域。
- alarms：在扩展后台定期重试同步。
- optional HTTPS host access：在用户点击连接并授权后，访问其指定的 WebDAV 服务器。

收藏数据包含昵称、网页标题、网址、备注、顺序、Todo 标记和删除记录，保存在本机并发送至用户配置的 WebDAV。密码仅保存在本机，不进入业务文件和导出备份。扩展不包含分析统计服务或远程执行代码。

## Build and local verification

本次验证环境：Node 22.23.1、pnpm 12.16.1、Extension.js 4.1.39。

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build:chrome
pnpm test:e2e
```

加载 `dist/chrome` 为已解压扩展，打开新标签页。测试使用隔离 Chrome 配置和本地 HTTPS WebDAV；不提供或使用真实账号。功能与兼容性范围见 README.md。

正式上架前由所有者提供隐私政策、联系方式、商店截图与实际服务商的验证信息。当前支持范围为 Google Chrome，遵循 [浏览器支持规则](docs/agents/platform.md)。

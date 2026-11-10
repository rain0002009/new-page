# 同步方案事实核实

核实日期：2026-11-09。本文记录事实和候选设计，不代表用户已经接受所有技术与交互决策。

## TanStack Query

已读取 TanStack 官方仓库中的持久化和 mutation 文档：

- https://raw.githubusercontent.com/TanStack/query/main/docs/framework/react/plugins/persistQueryClient.md
- https://raw.githubusercontent.com/TanStack/query/main/docs/framework/react/guides/mutations.md

`PersistQueryClientProvider` 可以先恢复持久化缓存，并在恢复后根据数据新鲜程度重新请求，适合本项目先显示本地数据、后台刷新的读取体验。

Query 持久化存在缓存过期和回收策略。文档中的 `maxAge` 默认是 24 小时，`gcTime` 也需要匹配配置，因此不能直接把默认 Query 缓存当作用户数据或未上传修改的唯一持久化存储。

离线 mutation 可以持久化状态，但函数不能序列化；重启后的恢复需要配置默认 mutation 函数。此能力不等同于自动解决多设备修改冲突或网盘文件的并发覆盖。

候选职责划分：本地持久层保存应用数据与未上传操作；TanStack Query 管理读取、刷新及请求状态；远端适配层负责授权与文件读写；同步层合并本地和远端修改。具体方案等待产品规则确认。

## 夸克接入核实与 WebDAV 备选

夸克官网 https://pan.quark.cn 链接到官方「夸克网盘Skill」说明页：
https://b.quark.cn/apps/quarkcloud_skill_info/routes/V-sc7gOBT

官方包 https://pdds.quark.cn/download/stfile/ppvvpxxpupqtprxri/quarkclouddrive_1.0.9.zip 中的 `references/auth.md` 描述的是 CLI 启动本地授权服务器、打开浏览器完成 OAuth 的流程。包中有读文件、上传等操作文档，但尚未找到自建浏览器扩展所需的公开应用注册、二维码登录、凭据续期和远端条件更新协议。该文档中的二维码展示规则属于取消授权，不能作为扫码登录能力的证据。

https://open.quark.cn 自称夸克小程序开发者平台，不能据此推断个人网盘文件 API 已向自建扩展开放。

结论限定：已有官方个人网盘 CLI 能力；未证实本项目所需的直接扩展接入能力。用户已授权采用 WebDAV 作为备选，首版以配置 WebDAV 为实施方向。

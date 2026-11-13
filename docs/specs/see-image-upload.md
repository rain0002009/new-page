# s.ee 图片上传

2026-11-14 用户通过 grill-with-docs 确认需求后调用 implement 执行。

## 已确认范围

- 设置页提供一个全局 s.ee API Key，支持密码框、显示/隐藏、保存与清除。按用户后续修订，与普通配置一样进入收藏库的夸克 / WebDAV 同步和备份；清除也同步到其他设备。配置区使用“s.ee 服务配置”等通用文案，为后续 s.ee 功能共用。
- 用户追加要求：自动接管 Markdown 地址改用 Switch 组件；新增默认开启的流体背景动画 Switch，可立即关闭并释放动画资源，偏好随收藏库同步和备份。
- 所有可编辑文档可上传图片，当前包括扩展托管笔记和获得写入权限的本地 Markdown。在线 Markdown 当前只读，未来获得编辑能力时复用相同编辑器能力。
- 上传入口、图片控件及 Markdown 序列化沿用 Milkdown 文档：Crepe ImageBlock 的 onUpload 回调，支持按钮、粘贴和拖放；保存 s.ee 返回的图片直链。
- 既有普通 Markdown 图片保留替代文本和标题，只有原生图片块的比例格式解释为缩放比。
- 未配置 API Key 时隐藏图片上传入口，粘贴和拖放图片不触发上传；保存或清除 Key 后已打开的编辑器即时更新，已有图片继续显示。
- 仅接受图片，不额外设定前端大小上限；普通上传限制沿用 s.ee 服务。网络失败、API 错误应显示错误，并允许重试；请求前仍校验 Key 以处理配置变动。
- 图片独立于文档保存；本次不实现图片库、删除图床文件、短链或大文件上传。

## 接口依据

- [s.ee API](https://raw.githubusercontent.com/sdotee/skills/refs/heads/main/.claude/skills/see/references/api.md)：`POST https://s.ee/api/v1/file/upload`，Bearer 认证，multipart 字段 `file`；`data.url` 为直链。用户提供的真实成功响应为 `code: 200`、`success: true`、`upload_status: 2`，因此沿用官方 SDK 的处理方式，`upload_status` 只作为服务元数据，不作为成功门槛。其值 `2` 的具体含义未见官方说明。参考文档将可选 `code` 的成功值描述为 `200`，官方 [TypeScript SDK 上传测试](https://github.com/sdotee/sdk.ts/blob/main/src/__tests__/file.test.ts) 与 [Python SDK 上传测试](https://github.com/sdotee/sdk.py/blob/main/tests/test_file.py) 使用 `code: 0`；解析兼容两者及缺省值，仍拒绝 HTTP 错误、其他业务码、明确的 `success: false` 和非法图片地址。格式无效时显示具体错误，不把 `success` 当失败原因。
- [Milkdown Crepe](https://github.com/Milkdown/milkdown/blob/main/docs/api/crepe.md) 与 [ImageBlock](https://github.com/Milkdown/milkdown/blob/main/docs/api/component-image-block.md)：`onUpload(file): Promise<string>`；`proxyDomURL` 仅解析显示用地址。原生图片块以 alt 保存缩放比例、title 保存图片说明。

## 验收边界

通过隔离 Chrome 的设置页、可编辑文档、Markdown 导出与本地文件回写验证。模拟 s.ee HTTP 边界核对认证、multipart、业务失败与非法响应；验证异步上传期间交接编辑权不会插入过期结果。真实 s.ee 上传需有效 Key，自动化不使用真实账号或上传用户文件。

## 首轮实现验证

- 类型检查及 Chrome 生产构建通过。构建仍提示既有文档入口体积超过 1 MiB 预算。
- s.ee 与设置开关的 9 项针对性测试全部通过，桌面和 480px 窄窗口截图已检查。
- 全量运行 119 项，117 项直接通过；两项既有用例在补齐焦点、离线编辑准备和同步完成等待后，各连续复跑 3 次通过。Todo 打开网页用例改用本地测试页面，避免依赖外网。
- 验证过程中观察到既有夸克并发合并可能对同一收藏显示重复冲突；本轮保留同步实现，仅调整测试前置条件。真实 s.ee 服务上传尚未实测。

## 后续修正

- 真实响应确认误判原因是成功上传的 `upload_status: 2` 被原有 `literal(1)` 拒绝；基于真实响应的回归已先失败再通过。`code: 0` 兼容有官方 SDK 依据，但不是此次真实响应的失败原因。
- 无 Key 时隐藏入口，保存或清除后更新已打开的文档；既有图片保留。相关 Chrome 用例通过。
- 夸克每分钟同步的一轮读取与前后检查曾三次下载同一批历史。现在仅在单轮复用已校验且元数据未变的历史，11 份历史的下载相关请求从 66 降至 22；每次仍刷新目录，新一轮重新验证。请求计数、并行提交及元数据变化后损坏检查回归通过。
- 提示统一迁移到共享 Toast，见 [Toast 规格](toast.md)。真实 s.ee 账号仍未执行上传，验证使用用户响应夹具。

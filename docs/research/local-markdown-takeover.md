# 本地 Markdown 的早期接管

2026-11-15，Chrome Manifest V3。目标是在保留真实 `file://` 来源的前提下，避免拖入 Markdown 时先显示原始文本。

## 推荐实现

使用静态声明的本地内容脚本，设置 `run_at: document_start`，只处理顶层 `file://` 的 `.md` / `.markdown` 地址。在首次异步调用前同步隐藏原始内容，再请求后台判断自动接管开关和“打开原网页”的绕过状态。允许接管时，以 `location.replace()` 转到扩展文档页，将完整原始网址通过 `URLSearchParams` 编码传入；拒绝、失败或超时时恢复可见。这样不依赖后台响应速度来阻止原始文本绘制。

Chrome 官方说明，`document_start` 脚本在已声明 CSS 注入之后、构造其它 DOM 或运行其它脚本之前注入；在同一生命周期阶段，静态声明的脚本优先。内容脚本可直接访问 `storage`、`runtime.sendMessage()` 和 `runtime.getURL()`。[内容脚本文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)

匹配模式支持 `file` scheme，用于本地文件的内容脚本需要用户手动授予文件访问权限。[匹配模式文档](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) 文档没有对所有纯文本 MIME 的最终绘制行为作独立保证，必须用真实 Chrome 的本地 `.md`、大小写后缀、空格、百分号和井号文件名验证，不能承诺任意机器或版本绝对零闪屏。

文档页必须声明在 `web_accessible_resources`；从网页来源导航至未公开的扩展资源会被阻止。[可访问资源文档](https://developer.chrome.com/docs/extensions/reference/manifest/web-accessible-resources)

## 为什么后台导航通知不够

MV3 service worker 可在空闲 30 秒后停止，事件会重新唤醒它。[生命周期文档](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) `webNavigation` 通知后再读取存储、查询标签并更新网址是一条异步路径；官方没有保证这些调用完成之前原始页面不会绘制。因此即使优化调用数量，也不能把这条路径当作绘制屏障。

## declarativeNetRequest 的证据边界

官方说明声明式规则可在请求发出前重定向，但仅对进入网络栈的请求生效。[declarativeNetRequest 文档](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) 当前文档没有在这一说明中明确保证本地 `file://` 顶层导航可以被重定向，也不能据此直接断言所有非 HTTP 请求都不支持。未完成实机规则匹配验证之前，不采用 DNR 作为本地文件防闪现方案，也不把“DNR 一定不能处理 file://”写成已证实事实。

## 必须保留的行为

- 关闭自动接管或选择打开原网页时，原始文件正常可见。
- 后台不可用时不能留下永久空白页。
- 缺少文件访问权限时保留现有权限提示和恢复入口。
- 仅处理顶层本地 Markdown；普通本地网页、其它文件与子框架不受影响。
- `replace()` 避免把过渡原始页留下为额外的后退步骤；文档之间的后退/前进仍需回归验证。

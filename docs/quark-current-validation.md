# 夸克当前文件同步验证

2026-11-14，按 [ADR 0006](adr/0006-quark-current-files-only.md) 移除同步历史。验证使用隔离 Chrome 扩展与受控夸克 HTTPS 服务，没有访问或修改真实网盘。

| 场景（目录各一页） | sort 次数 | 夸克网络请求/下载内容 |
| --- | --- | --- |
| 无变化、无笔记 | 1 | 共 3 个请求；只下载当前收藏 JSON |
| 无变化、有笔记（含 20 篇回归） | 1 | 共 3 个请求；不查询笔记目录、不下载 Markdown |
| 更新已有笔记 | 5（原先 7） | 笔记目录只列一次；Markdown 正文下载为 0；JSON 保留上传后回读 |

无变化场景均验证当前文件 ID 不变，没有上传、没有生成历史。普通同步不修复网盘被手工修改或删除的 Markdown，也不下载它们；新建笔记、编辑页保存、导入迁移、删除恢复仅处理受影响笔记。本机持久队列支持离线重启补传及同步期间继续编辑。旧版 JSON 首次补齐同步元数据、清理旧历史或目录分页会增加请求。没有测量真实网盘时延，因此不将本地测试时间作为用户反馈的 4.10 秒的优化结果。

验证命令：

- `pnpm exec playwright test tests/quark-requests.spec.ts --output test-results/quark-editor-unit-final`：24 项通过。先新增回归测试复现多余目录查询、全文发布和 MD 回读，再完成修改；补充首次发布失败再改名或删除、同步中后续保存、导入迁移的队列验证。
- 移除历史阶段运行 `pnpm exec playwright test tests/workbench.spec.ts --grep 夸克 --output test-results/quark-current-browser-final`：当时 21 项通过，约 3.6 分钟。
- 按操作发布 Markdown 阶段针对跨设备笔记冲突、普通同步不触碰 Markdown、编辑仅更新一篇、发布失败恢复、新建空笔记、离线编辑后重启补传、父级删除恢复和 WebDAV 迁移运行 5 项 Chrome 测试：全部通过，55.6 秒；输出 `test-results/quark-editor-browser-final`。
- `pnpm typecheck`、`pnpm build:chrome`、`git diff --check`：通过。项目没有配置独立 lint 命令；构建保留已有的 document/index.js 体积警告。

覆盖旧历史不读取且发布后清理、请求上限、对象键顺序不触发上传、过期写入拒绝、上传期间远端变化检测、旧目录结果不回退数据、更名中途退出恢复、文件损坏保护、重命名和删除失败恢复，以及 Chrome 中的跨设备顺序合并、冲突选择、账号隔离、离线重开和备份往返。测试使用独立输出目录。

夸克缺少已验证的原子条件写入，仍有最后检查至提交之间的竞争窗口；本方案不承诺严格并发隔离，也不提供云端历史恢复。当前数据损坏时保留本地数据并报错，不读取旧历史重建。

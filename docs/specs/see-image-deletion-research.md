# s.ee 图床图片删除接口核对

核对日期：2026-11-14。仅检索公开官方文档和 SDK，没有访问用户账号，也没有执行上传或删除。

## 已确认事实

- 删除接口为 `GET https://s.ee/api/v1/file/delete/{hash}`。参数 `hash` 是 **Delete Key**；API 参考要求 `Authorization: Bearer <API Key>`。不能从公开图片直链推导该凭据。[官方 API：Delete File](https://raw.githubusercontent.com/sdotee/skills/refs/heads/main/.claude/skills/see/references/api.md)
- 普通上传响应的 `data` 可含 `url`、`hash`、`delete`、`file_id`。其中 `url` 为直链，`hash` 明确为删除凭据，`delete` 为删除链接；参考文档将这些字段列为可选。上传返回后应保存 `url` 与 `hash` 的对应关系，字段缺失不能伪造凭据。[官方 API：val.UploadFileRespData](https://raw.githubusercontent.com/sdotee/skills/refs/heads/main/.claude/skills/see/references/api.md)、[TypeScript 类型](https://github.com/sdotee/sdk.ts/blob/main/src/types.ts)
- `GET /api/v1/files?page=1` 可按页读取当前认证用户的上传历史，返回数据数组使用同一 `UploadFileRespData` 结构，因此包含图片 `url` 和删除 `hash`。API 没有提供按图片 URL 查找的过滤参数。[官方 API：Get File Upload History / val.GetFileHistoryRespV](https://raw.githubusercontent.com/sdotee/skills/refs/heads/main/.claude/skills/see/references/api.md)、[TypeScript history()](https://github.com/sdotee/sdk.ts/blob/main/src/resources/Files.ts)、[Python get_file_history()](https://github.com/sdotee/sdk.py/blob/main/src/see/api/file.py)
- 对旧文档里只保存直链的图片，可尝试通过**同一账号**的上传历史分页精确匹配 `url`，取得对应 `hash` 后删除。这是根据以上官方字段组合出的应用方案；没有官方承诺所有历史记录始终可回查，也没有按直链直接删除接口。查不到时应保留原图并报告无法取得删除凭据。
- 官方 TypeScript 与 Python SDK 均以 GET 调用 `/file/delete/{hash}`，不提交正文。TypeScript 方法注释虽称 “file ID or hash”，API 参考只保证 Delete Key，Python 参数也是 `hash_str`，实现应采用明确记录的 `hash`，不要假定 `file_id` 可替代。[TypeScript Files.delete()](https://github.com/sdotee/sdk.ts/blob/main/src/resources/Files.ts)、[Python delete_file()](https://github.com/sdotee/sdk.py/blob/main/src/see/api/file.py)
- 删除响应与上传响应不同：参考 `DeleteFileResp` 为可选的字符串 `code`、字符串 `message`、布尔 `success`。TypeScript 删除成功测试使用 `{ code: '200', success: true }`；Python 使用 `{ code: 'success', success: true }`。应检查 HTTP 成功且 `success === true`，不要套用上传的数字业务码校验。[官方 API：val.DeleteFileResp](https://raw.githubusercontent.com/sdotee/skills/refs/heads/main/.claude/skills/see/references/api.md)、[TypeScript 删除测试](https://github.com/sdotee/sdk.ts/blob/main/src/__tests__/file.test.ts)、[Python 删除测试](https://github.com/sdotee/sdk.py/blob/main/tests/test_file.py)

## 差异与未确认边界

- **认证格式有官方资料差异**：API 参考写 Bearer，两个 SDK 直接将配置的 Key 放入 Authorization。当前项目上传已采用 Bearer，删除可保持一致；本次没有通过真实账号验证两种格式的兼容范围。[TypeScript 认证设置](https://github.com/sdotee/sdk.ts/blob/main/src/sdk.ts)、[Python 认证设置](https://github.com/sdotee/sdk.py/blob/main/src/see/http_client.py)
- 官方文档与上述测试未说明重复删除、已删除文件、无效 hash 的具体业务码；也未承诺删除幂等。因此不能默认将任意 404、`success: false` 或未知业务码视为已成功删除。超时后可能存在远端已删除但客户端未收到确认的状态，应保留待处理记录并显示结果未知。
- 历史接口只公开页码参数与数据数组；未说明每页大小、最后一页标志、稳定排序和一致性。实现分页应有终止/重复页保护，并在无法完整查询时明确失败，不能据不完整结果推断图片不存在。
- 删除原图会影响所有引用该地址的文档，包括导出到应用外的 Markdown；当前应用无法证明外部引用数量。这是公开直链和独立图床存储带来的应用边界。

## 对当前项目的直接影响

当前 `src/core/see.ts` 仅返回上传的 `url`，没有保留 `hash`。新增删除能力需要保存上传结果中的删除凭据，或通过历史接口按直链补查旧记录；还需明确 Markdown 移除图片、笔记删除、共享引用、回收站恢复及失败重试的行为。接口支持本身不能决定这些应用规则。

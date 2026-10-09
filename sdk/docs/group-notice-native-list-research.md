# 原生群公告列表合同缺口

日期：2026-09-30。结论：目前不能准确实现原生 `getGroupNotices`，而且上游类型声明的参数数量与已检查的 QQ 7.0.2-53644 内核不一致。发布、图片上传及删除已有独立已知调用合同；本报告只覆盖列表/监听缺口。

研究只读取保存的主源文件、独立 bundle 的二进制字符串、现有静态 exports 清单以及在线代码搜索。没有启动 QQ/Node 原生 worker、初始化账号、获取票据或发送任何列表请求。

## 可复核证据

固定 NapCatQQ commit：`26d7533e0f5800fdff865ab2f2ad7692917e1076`。

- [GroupService 声明](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/services/NodeIKernelGroupService.ts)把 `getGroupBulletinList` 写为仅有 `groupCode` 的未知返回；`getGroupBulletin` 也是未知返回。
- [GroupListener 声明](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/listeners/NodeIKernelGroupListener.ts)的 `onGetGroupBulletinListResult`、`onGroupBulletinChange` 等仅为 `...unknown[]`，没有位置参数或字段类型。
- [现行 OneBot 公告读取动作](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-onebot/action/group/GetGroupNotice.ts)使用 WebApi；这不能证明原生 listener 合同，也没有用作替代实现。
- 本地之前保存的 `.local/native/profile-7.0.2.json` 和 `.local/research/linux-arm64-surface.json`均包含公告方法名，证实接口存在；这些清单未记录调用参数和回调形状，无法当成完整合同。

检查的原生文件：`.local/native/qq-7.0.2-53644-darwin-arm64/wrapper.node`，通用 Mach-O，包含 x86_64 / arm64 两个架构，SHA-256 为 `2e6f79b241c33e88f51cb947d9da6e10e31fc2038304eadf0f652a05642aab1a`。

二进制自身保留的绑定断言：

```text
getGroupBulletin needs 1 arguments
getGroupBulletinList needs 4 arguments
getGroupBulletinDetail needs 4 arguments
getGroupBulletinReadUsers needs 6 arguments
```

这些是对应 `NodeIKernelGroupService::METHOD` 的参数数量断言文本，不是根据方法名推断。直接按上游 TypeScript 的单参数调用列表，会不符合当前版本自身的绑定要求。

同一二进制 RTTI 中出现 `KernelGroupService::getGroupBulletinList`，类型编码对应 `uint64`、两个 `const string&`、`const GroupBulletinListReq&` 以及内部操作回调。RTTI 说明有请求结构和两项字符串参数，但不说明它们是票据、游标还是其他语义；不能擅自命名。JS 四参数与该编码相容，但未证明绑定转换的每个步骤。

`onGetGroupBulletinListResult` 附近可以观察到 `srvCode`、`readOnly`、`groupInfo`、`publisherInfos`、`server_time`、`nextIndex` 等字符串。这是静态字段候选，不能证明哪些属于顶层回调参数、哪些属于嵌套对象、哪些必需或可选。

脱敏机器报告保存在 `.local/research/group-notice-native-contract.json`，仅含版本、hash、绑定断言、RTTI 字符串和证据缺口，没有账号数据。

## 精确缺少的内容

1. 列表第二、第三字符串参数的语义及来源。
2. `GroupBulletinListReq` 的完整必需/可选字段、JS 字段名及类型。
3. `onGetGroupBulletinListResult` 的位置参数签名、原生错误和公告数据对应位置。
4. 响应关联群、分页请求与分页游标的语义，确保迟到/其他群的回调不能满足当前请求。
5. `onGroupBulletinChange` 的群/公告标识和通知增量语义，避免把全量历史当作新公告。

本次对完整方法名及结构名的公开搜索没有返回可验证的主源实现。该结果表示尚未找到合同，不能推导“接口不存在”或“绝对无法实现”。

下一步如果需要继续恢复合同，应读取同版本官方 JS 调用点或静态分析绑定转换与请求序列化代码。方法枚举、字段字符串或只把 unknown 包装进 Promise 都不足以宣称公告列表已实现。任何真实调用/票据请求应与本次离线研究分开验收。

## Explicit HTTP implementation (separate evidence)

`src/web-group-notices.ts` now implements the pinned HTTP contract with injectable fetch, not the unknown native bulletin-list binding. The worker passes its authenticated UIN and Session. Native `TicketService.forceFetchClientKey('')` obtains a key; the Node HTTPS login jump exchanges it for cookies and collects 301/302 cookies. `TipOffService.getPskey(['qun.qq.com'],true)` fills a missing `p_skey`. `bkn` hashes `skey`, not `p_skey`. Tickets, cookies and headers never form the returned DTO; transport errors are sanitized to avoid credential-bearing URLs.

Primary fixed source: [WebApi](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/webapi.ts#L211), [UserApi](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/apis/user.ts#L134), [cookie redirect helper](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-common/src/request.ts#L6), [response types](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/webapi.ts#L58).

Only `groupId` is supported. The exact upstream query includes `ft=23,ni=1,n=1,i=1,log_read=1,platform=1,s=-1`, then appends another `n=20`. Neither the code nor response types establishes a next-page cursor or exhaustive coverage. The result returns `notices` plus the server JSON `raw`; no full-pagination claim is justified. Notice picture widths/heights retain upstream string types. Three offline contract tests cover ticket arguments, redirect cookies, domain-key fallback, the duplicate query parameter and bkn, DTO conversion, validation and sanitized failures. No native ticket operation or QQ HTTP request was performed.

# QQ 原生内核、签名与掉线：社区证据核查

核查日期：2026-09-30。仅在线检索与静态源码比对；本次没有启动账号、发消息或改变内核行为。

当前结论：开源社区确实存在第三方工具警告和掉线报告，NapCat 的实际初始化也比本项目更复杂。但现有证据不能证明本项目使用了“假签名”，也不能证明存在一个已知的固定检测位、可查询的官方账号标记，或将某项初始化补齐就能消除掉线。

## 与本项目技术路径的关系

| 项目/模式 | 已查证技术路径 | 与本项目关系 | 证据边界 |
| --- | --- | --- | --- |
| 本项目 | 普通 Node 子进程加载 QQ 原生 wrapper，注册桥补充原生注册入口 | 当前实现 | 登录、部分业务调用成功不代表内核完整性或长时在线已验收 |
| NapCat Shell | 加载 QQ wrapper，并初始化自有原生扩展、网络包处理及引擎/登录/Session | 原生内核调用层相近；周边运行环境不同 | 固定源码证明差异，不能推导其组件保证不被检测 |
| NapCat Framework | QQ 主进程中的初始化/原生服务调用 | 使用相同内核族，但宿主环境不同 | 有用户报告只接收也出现第三方工具提示 |
| 当前 LuckyLilliaBot 直连模式 | 纯代码实现协议，包含签名代理原生模块 | 普通 Node 运行这一点相近；并非本项目直接加载 QQ wrapper 路线 | 不应把旧 LLOneBot 插件经验全部套用于当前直连版本 |
| LuckyLilliaBot PMHQ 模式 | 独立的真实 QQ 客户端和 PMHQ 连接 | 有 QQ 宿主，不符合本项目硬要求 | 项目文档说明该模式固定有头 |
| 当前 Lagrange.Core V2 | NTQQ 协议实现，提供 .NET 接口及跨语言 C ABI | 协议复刻，不是直接调用腾讯 wrapper | 当前 README 声明旧 V1 已结束；旧教程不能代表当前 V2 |

固定源码：

- NapCatQQ：`26d7533e0f5800fdff865ab2f2ad7692917e1076`。[Shell 初始化](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-shell/base.ts#L658-L724)先加载 wrapper 和自有原生组件，再初始化原生引擎和登录服务。[原生扩展接口声明](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/packet/handler/napi2nativeLoader.ts)表明它不仅提供 JS 服务封装。
- 同一 Shell 文件中的 [O3 初始化与上报调用](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-shell/base.ts#L739-L754)是可观测差异。这些调用的官方语义、返回信息与服务器判定关系没有公开契约，因此只记为差异，不给它们赋予“真实签名证明”“官方白名单”等解释。
- LuckyLilliaBot：`9f374f6442b6c38a95841fc1d472cf6d8ea6149e`。[Docker 架构文档](https://github.com/LLOneBot/LuckyLilliaBot/blob/9f374f6442b6c38a95841fc1d472cf6d8ea6149e/docs/docker.md#L75-L94)区分纯协议直连与真实 QQ 的 PMHQ 模式；[原生模块说明](https://github.com/LLOneBot/LuckyLilliaBot/blob/9f374f6442b6c38a95841fc1d472cf6d8ea6149e/docs/docker.md#L5-L16)确认签名代理存在。存在签名模块不等于公开了腾讯服务端检测机制。
- Lagrange.Core：`20c2ba079b5ee67156bd71419ed54ea61a24e91f`。[README](https://github.com/LagrangeDev/Lagrange.Core/blob/20c2ba079b5ee67156bd71419ed54ea61a24e91f/README.md)说明 V2/V1 状态、.NET 和 C ABI 入口。

## 掉线报告和维护者回应

- [NapCat #1057](https://github.com/NapNeko/NapCatQQ/issues/1057)：2025-06-02 的用户报告描述 Windows Framework 模式仅接收消息仍出现第三方工具警告。证明社区有人观察到这种提示；它没有给出被检测的字段或可复现的底层原因。
- [NapCat #2062](https://github.com/NapNeko/NapCatQQ/issues/2062)：2026-09-22 用户报告频繁掉线，正文声称相关选项已开启，但附带日志中的六项 bypass 配置均为 false、o3HookMode 为 1，文字与日志不一致。因此不能记为“保护开启仍掉线”，也不能据此证明某项处理有效或无效。API 读取评论时，建议更换版本的回复作者属于 `NONE`（普通参与者），不是已确认的维护者回应；不能拿此建议作为修复保证。
- [NapCat #659](https://github.com/NapNeko/NapCatQQ/issues/659)：原始问题是 2024-12-25 的扫码登录 ErrInfo 1。API 确认项目成员 MliKiowa 有回复，首先建议更新 QQ 版本。该回复只支持“版本可能影响登录”的判断，不能证明所有掉线均由签名导致。[成员回复固定链接](https://github.com/NapNeko/NapCatQQ/issues/659#issuecomment-2561841094)。
- [NapCat #2049](https://github.com/NapNeko/NapCatQQ/issues/2049)：请求提供掉线 hook，列举风控、状态失效及其他设备登录等可能情形。这是需求描述，不是分类原因的实验。
- [原生 KickedOffLineInfo 类型](https://github.com/NapNeko/NapCatQQ/blob/26d7533e0f5800fdff865ab2f2ad7692917e1076/packages/napcat-core/types/msg.ts)：存在 `tipsTitle`、`tipsDesc`、`kickedType`、`securityKickedType`、`sameDevice` 等字段。记录这些字段有助于区分现象，但本次没有找到官方完整枚举解释；不能把数字值自行命名为假签名标记。

## 没有被证实的说法

本次以 `qq_magic`、`QQNT fake sign`、`fake signature`、假签名、官方标记、检测、掉线等关键词搜索主源仓库、项目讨论和文档。未找到能够验证下列断言的官方说明或固定源码证据：

1. 普通 Node 调用 wrapper 一定生成假签名。
2. wrapper 暴露一个通用固定检测位，单个值决定账号被识别。
3. 当前账号已经被腾讯永久标记，可通过现有 SDK 查询或清除。
4. 使用某个社区项目、开启某个选项，保证长期在线或避免账号限制。

“未找到”仅表示这次证据不足，并不是反证。网上“签名”还可能指音乐卡片签名、消息文本中的 Bot 标记、系统代码签名或 HTTP 鉴权；这些与 QQ 登录/协议安全签名不能混为一谈。与 QQ 无关的腾讯产品用户协议也没有作为技术证据引用。

## 对本项目可以落实的结论

继续保留并准确报告原生登录错误、会话状态和原生踢线原因。相同内核版本下，可以静态核对完整依赖、初始化顺序、版本元数据和错误处理，不替换安全结果、不伪造通过状态。对于长时运行问题，先记录首次异常时的本地事件和原始原因字段，区分主动关闭、worker 崩溃、网络断开和原生踢线；短时登录与发送成功不能代替长时稳定性验收。

本报告没有实现或提供检测规避、伪造签名或移除安全上报的方法。

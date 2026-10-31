# 浏览器投放的平台边界

核对日期：2026-10-27。本文件描述第六步的设置校验和执行约束；平台官方说明与本机模拟测试不等于真实广告已经创建。真实结果必须由当前账户的浏览器观察回填。

## 初版范围

| 平台 | 支持准备的类型 | 层级与预算 | 素材与身份 |
| --- | --- | --- | --- |
| Google | 标准搜索广告 `search` | 新计划使用计划日预算；已有计划新增组只读取父计划预算 `inherit_campaign` | 一条响应式搜索广告，短语或完全匹配关键词；所选素材作为策略和 UTM 对应资源，图片／视频不自动上传到搜索广告 |
| Meta | 网站销售 `sales` | 计划或广告组预算；新增组可使用组预算或继承现有计划预算 | 每个平台一条广告；使用已上传并审核的图片／视频文件；必须明确 Facebook Page，选择 Instagram 版位时另需对应 Instagram 身份 |
| TikTok | 手动竞价网站转化 `website_conversions` | 广告组日预算；仅 Auction | 已上传并审核的视频文件；使用已关联且有权限的 TikTok 身份 |

每份方案初版只选择一份素材、每个平台创建一个广告组和一条广告。多条可替换文案是审核候选，执行时只使用任务锁定的一组，不能自动生成组合广告。达人授权代码可保留在素材库，授权投放留待后续接入；只有代码、没有上传文件的 Meta／TikTok 素材不能进入本版浏览器搭建。暂不覆盖 Google PMax／YouTube、目录与商店广告、Smart+ 自动组合或预约购买。

Google 官方区分搜索、视频等计划类型，搜索设置还涉及转化目标、语言、位置、网络和关键词；浏览器不得直接接受默认扩展网络。参见 [Google 计划创建](https://support.google.com/google-ads/answer/6324971?hl=en)、[搜索计划设置](https://support.google.com/google-ads/answer/9510373?hl=en)。

TikTok 的当前界面正将手动与 Smart+ 流程整合，并存在分批开放差异；执行需读取当前实际页面，不能依赖固定页面坐标或旧向导名称。参见 [升级后的创建流程](https://ads.tiktok.com/resources/help/article/how-to-create-a-campaign-in-the-upgraded-smart-experience)。

TikTok 正逐步取消 Custom Identity，新建广告需要核实关联身份；文件可下载或持有达人代码本身不证明有权投放。参见 [身份过渡说明](https://ads.tiktok.com/business/en/blog/custom-identity-transition)、[Identity 说明](https://ads.tiktok.com/resources/help/article/identity)。

TikTok Reach & Frequency 的计划不支持暂停，广告组和广告亦有约束，因此初版排除预约购买。参见 [预约广告管理限制](https://ads.tiktok.com/resources/help/article/reach-frequency-campaigns-manage?lang=en-GB)。

## 搭建前必须明确的设置

`server/execution-validation.mjs` 只接收 `{targets: [...]}`。保存草稿允许缺项；执行前调用 `validateExecutionConfiguration(input, brief, selectionSnapshot, content, {complete: true})` 完整校验。

| 字段 | 含义 |
| --- | --- |
| `platform` | 本次需求选中的 Google、Meta 或 TikTok；完整提交必须覆盖全部所选平台 |
| `accountId/accountName/accountUrl` | 广告子账户编号、名称、官方 HTTPS 后台入口；不能用管理账户代替投放子账户 |
| `accountCurrency/accountTimeZone` | 账户实际币种和时区，执行前从后台再次读取；不能默认预算为美元或任意转换币种 |
| `campaignName/groupName/campaignType` | 本次目标计划、广告组和支持的计划类型 |
| `budgetLevel/dailyBudget` | 预算层级与日预算；金额必须与审核需求一致；`inherit_campaign` 是核对父计划预算，不授权修改父计划 |
| `bidStrategy/bidValue` | Google：`manual_cpc/maximize_clicks/maximize_conversions`；其他：`lowest_cost/cost_cap`。手动 CPC 与成本上限必须有金额 |
| `conversionEventId/conversionEventName` | 精确的后台转化目标；Google 的目标也需明确，不能仅从“注册”文字推定已完成配置 |
| `pixelId/identityId/instagramAccountId` | Meta／TikTok 的数据源和广告身份；Instagram 身份只对所选 Instagram 版位必填 |
| `creativeMode` | Google 为 `text`；Meta／TikTok 本版执行仅支持 `file`。草稿中的 `creator_code` 不能进入执行，需后续接入独立授权校验；文件可下载亦不代表具备投放授权 |
| `locationIds/languageCodes` | 精确位置和语言的后台选择项名称或编号；这些是待匹配的用户意图，不是已核实的 API 地理编号 |
| `placements` | Google 为 `google_search`；Meta 为所选 `facebook_feed/instagram_feed`；TikTok 为 `tiktok`，不得默认增加其他版位 |
| `keywordMatchType` | Google `phrase/exact`，执行时不得擅自改为广泛匹配；其余平台留空 |
| `audienceBindings` | 每份已选人群的资源编号、版本、包含／排除用途与现有平台人群编号的对应关系；未选人群时为空数组 |

人群可选。选择人群时，必须逐一核对平台账户归属、状态、最低规模和适用性，不以本地邮箱数量推定平台已匹配或已达投放门槛。第六步不上传邮箱、不创建客户名单、不自动扩展人群。特殊广告类别、平台资格、预算最低值、事件数据和广告编辑权限，都需在当前后台检查；无法满足时回填卡点。

## “创建后暂停”的硬约束

官方说明证明平台存在暂停和草稿状态，**没有证明所有账户的每一种创建向导都允许在发布前设置暂停**。尤其 Google 标准搜索向导仅明确描述最终发布；特殊工具的“默认暂停发布”不能推广到普通搜索创建。

1. 执行前读取账户编号、币种、时区、编辑权限；新增组时额外核对父计划编号、类型、预算和当前状态。任务只允许创建指定的新对象，不能调整其他广告或父计划开关。
2. 核对审核快照、准确落地页和已生成 UTM、素材版本、转化事件、预算、出价、时间与位置语言。账户时区与需求时区不同时，必须明确解释并核对转换后的开始时间。
3. **最终提交前**，从当前页面确认新建对象会以暂停／关闭状态发布，保存该设置的观察证据。若向导没有可验证的关闭发布方式，停在草稿并回填“当前向导无法保证暂停创建”。不得先启用发布再立即暂停。
4. 新建广告组时，即使父计划已开启，也必须保证新组在提交时关闭；不能暂停已有父计划来代替关闭新组。新计划以新计划的关闭开关阻止投放。各级子对象开关均需如实记录，子对象显示启用时，只能说明它被本次暂停的计划或新组阻止投放，不能把子对象配置说成暂停。
5. 提交后重新打开计划、组、广告列表，记录真实编号及各层配置开关。只有核对完成才能回填“已创建，保持暂停”。草稿不能填成已发布对象；缺少真实编号或看不到配置状态时回填结果不确定。

“审核中”“未来开始”“未投放”“账户没余额”均不证明配置暂停。观察应分别记录配置开关、平台审核状态和实际投放状态。参见 [Google 计划状态](https://support.google.com/google-ads/answer/2549115?hl=en)、[TikTok 计划状态](https://ads.tiktok.com/resources/help/article/campaign-statuses-and-definitions)、[TikTok 广告状态](https://ads.tiktok.com/resources/help/article/ad-statuses-and-definitions-in-ads-manager)。

Meta 的编辑可保留在草稿，发布时必须只勾选本任务对应的变更，不能提交账户内其他人的未发布编辑。开关的草稿显示亦不能代替发布后读取。参见 [Meta 草稿与发布说明](https://www.facebook.com/business/help/2198347886909401)。

## 回填、恢复与人工启用

执行前后保存任务标记、当前账户、对象层级和观察时间。公开结果中不写 Cookie、登录令牌、真实用户邮箱或达人授权代码。浏览器观察可记录如下信息，服务端必须按任务范围逐项核对，不能接受客户端提交的 `verified: true` 或 `canPublishPaused: true` 作为证明：

桌面领取、截图上传、提交许可及回填的实际命令，以 [浏览器执行交接说明](BROWSER-EXECUTION.md) 和 `runner/browser-client.mjs` 为准。队列中出现任务只表示等待桌面 Codex 领取，不代表后台已有无人值守的浏览器适配器在运行。

```json
{
  "platform": "Meta",
  "accountId": "<observed-account-id>",
  "campaignId": "<observed-campaign-id>",
  "adGroupId": "<observed-ad-set-id>",
  "adId": "<observed-ad-id>",
  "statusObserved": "paused",
  "url": "<official-object-url>",
  "observedAt": "<ISO-8601>",
  "evidence": {"observation": "<visible per-level configured switches and review status>"}
}
```

这是执行者的浏览器观察记录，不表示另有广告 API 独立验证。发布点击之后发生超时、登录失效或连接中断时，结果视为不确定，先按编号和任务标记查找已有对象；未查清前不能自动再建一遍。

“人工确认启用”是独立操作，绑定该次审核版本、账户、真实计划／组／广告编号及预算币种。启用前重新读取对象与暂停状态，发现内容、预算或父级发生变化则回到审核。新增组只启用该组与本次广告，不授权启用原先关闭的父计划或其他对象。启用后再次读取开关；平台审核未通过或仍待审核时，不得称为已经开始投放。

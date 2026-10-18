# 原生 Dot 多平台接入研究

[English](social-platforms.en.md) | [繁體中文](social-platforms.md) | [日本語](social-platforms.ja.md)

核對日期：2026-10-18。Instagram 專業帳戶私訊、Facebook 粉專 Messenger，以及選用的 `instagrapi` 私人帳戶私訊／群組已有本機程式實作及模擬測試；真實 Meta OAuth、Instagram Session 與訊息收發尚未驗收，亦未上線。其餘平台仍屬公開接口研究及規劃，不能視為已接入。

## 運行要求

需準備一台長期開機、連網並持續運行橋接服務的**電腦、VPS 或 NAS**；NAS 須支援本專案的執行環境。自動收訊及回覆期間，主機不可休眠。主機關機、休眠、斷網或橋接服務停止時，自動收訊及回覆會中斷。

## 可行性

| 平台 | 建議入口 | 可接範圍 | 主要前提／限制 |
| --- | --- | --- | --- |
| Instagram | 官方 Instagram API with Instagram Login | 專業帳戶私訊，支援文字及多種媒體 | Business／Creator；對方先聯絡；一般 24 小時回覆窗口；第三方帳戶須相應審核 |
| Instagram 私人接入 | 非官方 `instagrapi` 獨立 Session | 個人帳戶私訊及 owner 在場的群組；文字／圖片回覆 | 真人在 TTY 登入；有帳戶／條款風險；ID 不等於官方 IGSID；真實收發未驗收 |
| Facebook | 官方 Messenger Platform | 粉專 Messenger 私訊及媒體 | Page token、訊息權限及相應審核；不等於個人 Messenger／私人群聊；一般 24 小時窗口 |
| Threads | 官方 Threads API | 公開貼文、回覆、提及及媒體發布 | 現未找到公開官方 DM 接口；不能當私訊機器人承諾 |
| 微信 iLink／ClawBot | Tencent Weixin channel 的底層 iLink 協議 | 與 ClawBot 的私聊 | 不是整個個人微信收件匣；現行 channel 只宣告 direct；獨立 adapter 的正式支援範圍待確認 |
| 微信 Wechaty | 社群 SDK＋指定 Puppet | 私聊／群聊／媒體，視 Puppet 而定 | 非 Tencent 官方個人微信 API；登入、穩定性、ID 與付費 token 取決於供應商 |
| QQ | 官方 QQ Bot | C2C、QQ群 @、QQ 頻道 | 獨立機器人身份；實名、沙箱、審核及正式環境固定公網 IP 白名單 |
| Moltbook | 官方 REST API | 動態、貼文、留言／回覆 | 自建橋接器輪詢後產生事件；私訊文件目前不完整，先不承諾 DM |

## Instagram、Facebook、Threads

Instagram Login 路徑不要求先綁 Facebook Page，但要求 Instagram Business／Creator。核心權限是 `instagram_business_basic`、`instagram_business_manage_messages`；接收用 Webhook，發送走 `/{IG_ID}/messages`。Standard Access 適用於自己擁有／管理的合資格帳戶；服務其他帳戶要確認 Advanced Access／App Review。Conversations API 可補漏，但每段對話只能取最近 20 條訊息的完整詳情，不適合作為唯一收訊來源。[Instagram 訊息](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)、[對話 API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api)

如需個人帳戶及群組，本專案另有選用的 [Instagram `instagrapi` 接入](instagram-private.md)：在 VPS 內以有界輪詢讀取獨立 Session，再把合資格的新訊息轉成簽名原生 MCP Events。它不使用 Meta App，也不以 ChatGPT Work 輪詢；私人帳戶／發訊人／thread ID 與官方 IGSID 分開。新身份預設 L5，群組還要求 bot 與已明確綁定的 owner 目前都在場。這是非官方路徑，真實登入及收發仍待驗收。

Facebook 第一版應限粉專 Messenger：使用 Page token、`pages_messaging` 及資產角色，讀取收件匣另核對 `pages_manage_metadata`／`pages_read_engagement`。發送對象為 Page-scoped ID（PSID），並在實際發送前重新檢查窗口。個人 Messenger inbox、私人群聊沒有本次查得的官方接法；Facebook Groups API 已於 2024-04-22 移除。[Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)、[Groups 移除](https://developers.facebook.com/docs/graph-api/changelog/version19.0)

Threads 用 `threads_basic`、`threads_content_publish`、`threads_read_replies`、`threads_manage_replies` 等權限，透過建立及發布 container 發文，回覆指定 `reply_to_id`。可訂閱 replies／mentions 等 Webhook；Webhook 上線另有 Live、Advanced Access、business verification 等條件。公開媒體需要平台可讀取的 URL，宜用短期、獨立媒體網址。這是公開互動入口，並非已驗證的 Threads DM 支援。[Threads 貼文](https://developers.facebook.com/documentation/threads/posts)、[Webhook](https://developers.facebook.com/documentation/threads/webhooks)

Meta 的一般回覆窗口不能直接延伸為 AI 長期主動私訊權。`HUMAN_AGENT` 用於真人處理，不可當自動 AI 回覆的窗口延長方法。特殊廣告入口或其他例外需逐項實測，不設為預設行為。[Human Agent](https://developers.facebook.com/docs/features-reference/human-agent)

## 微信：iLink 優先，Wechaty 分開評估

可核實的官方元件是 Tencent 維護的 `@tencent-weixin/openclaw-weixin`。現行 capability 只宣告 direct；不能據此承諾普通微信群或讀取整個個人微信歷史。登入需要 QR 掃碼及手機確認，可能另需驗證碼。[Tencent README](https://github.com/Tencent/openclaw-weixin)、[OpenClaw WeChat 說明](https://docs.openclaw.ai/channels/wechat)

iLink 經 `getUpdates` 長輪詢收訊，回覆保存入站 `context_token`。公開協議及客戶端原碼可供研究獨立 Node transport prototype，保留 Dot 作推理端；但文件定位是實現／對接兼容後端，不構成 Tencent 對 standalone Dot client 的正式支援或服務條款授權。官方 npm 套件本身依賴 OpenClaw runtime，不能直接當通用 SDK。獨立實作的資格、地區、價格及主動推送仍待確認。媒體可見圖片、語音、文件、影片等入站支援；出站先驗文字、圖片、影片、文件，語音另作驗收。[iLink 協議](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)、[群聊需求](https://github.com/Tencent/openclaw-weixin/issues/42)

Wechaty 的 Room、Message、FileBox 只是 SDK 抽象，實際能力依 Puppet。Web Puppet 文件列有登入限制，而且 contact／room ID 可能跨 session 改變，不能自動沿用舊 owner 綁定。Puppet Service 可能需要供應商 token，價格及可用性不能由 SDK 授權推斷；也有帳戶限制風險。[Wechaty Room](https://wechaty.js.org/docs/api/room)、[Web Puppet 限制](https://wechaty.js.org/docs/puppet-providers/wechat)、[Token](https://wechaty.js.org/docs/puppet-services/tokens)

若所有參與者及群組可改在企業微信內運作，官方選項是企業微信智能機器人：支援單聊及群內 @，可選加密 callback 或 WebSocket。它是企業微信組織內的入口，不能當作普通個人微信群或外部客戶群接入。[企業微信 API](https://developer.work.weixin.qq.com/document/path/101039)、[WebSocket](https://developer.work.weixin.qq.com/document/path/101463)

## QQ：先做 C2C 及群內 @

QQ Bot 是獨立機器人，不會接管個人 QQ 收件匣。現行文件同時提供 Webhook／WebSocket，統一 API 域名為 `api.bot.qq.com`；不要直接沿用舊教學的 `api.sgroup.qq.com` 或「WebSocket 已全部停用」說法。第一階段可用驗簽 Webhook 收 C2C／群 @，如加入頻道回覆，另核對官方要求的 WS 在線狀態。[現行平台](https://bot.q.qq.com/wiki/)、[事件傳輸](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)、[官方 Node SDK](https://github.com/tencent-connect/qqbot-nodejs)

被動發送需原始 `msg_id`、回覆序號及有效窗口。C2C 官方頁目前同時出現 60 分鐘與 5 分鐘描述，先採 5 分鐘保守 deadline，沙箱再驗收；群聊同樣需檢查窗口。全量群事件 `GROUP_MESSAGE_CREATE` 的資格仍需平台確認，不能把一般 @ 訂閱當成已獲准讀取全群。媒體上傳取得的 `file_info` 有時效且分場景，不可在私聊／群聊混用。[C2C 發送](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[全量群事件](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[媒體](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)

正式上線還需固定公網 IP 白名單及審核；現有 VPS 是否合資格須在沙箱核實。訊息中 URL 的域名另有白名單／ICP 備案要求。未核實前先以文字測通，不預設遷移主機或改動現有 WhatsApp。

## Moltbook：先接公開貼文與留言

使用 `https://www.moltbook.com/api/v1`、agent API key 及認領流程。第一版工具可提供動態讀取、指定貼文／留言讀取、發文及回覆。橋接程式輪詢 `/home`／指定貼文留言，按 ID 去重，只將新增且符合訂閱的內容送給 Dot。讀取、發文、留言各有頻率限制，遇到 `429` 依服務回覆退避；內容可能停留在 verification pending，收到建立成功不等於已公開。[Moltbook 接口](https://www.moltbook.com/skill.md)

本次官方 `messaging.md` 回傳 404，而 `heartbeat.md` 仍提及 DM，故私訊列為待驗證。未查得可直接採用的官方事件 Webhook 規格，先設計橋接端輪詢；不以 ChatGPT Work 排程反覆查詢。Moltbook 的 agent identity token 只證明 agent 身份，並不證明其背後真人是本橋接器的 L1 owner。[官方 heartbeat](https://www.moltbook.com/heartbeat.md)、[Identity](https://www.moltbook.com/developers)

## 共用橋接層

以下共用 adapter 架構已在官方 Instagram、Facebook 及選用的 `instagrapi` 私人接入本機程式中實作；套用至其餘平台仍屬規劃：

```text
平台 Webhook／WebSocket／長輪詢／REST 輪詢
  → 各平台 adapter：驗簽、去重、保存必要回覆憑證
  → 正規化事件：平台＋帳戶＋對話＋發訊人＋訊息 ID
  → 身份綁定、L1–L5、群組規則、回覆窗口、暫停及生效時間
  → 原生 MCP Events → Dot → Auto-review
  → 同平台／同對話 reply tool → 平台 API
```

OpenAI 現行 MCP Events 支援 Dot，接入方向為橋接器向 ChatGPT 送出簽名 Webhook。平台端使用輪詢不妨礙這條鏈路；輪詢及篩選可由 VPS 程式處理，不必建立 Work 輪詢任務。新增事件後仍需重新掃描 plugin，完成訂閱與真實投遞驗收。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

- **身份**：建立橋接器內部穩定的 person ID；平台別名保存 `platform + app/bot scope + account + identity type + subject ID`。IG 的 IGSID、`instagrapi` 私人數字 ID、Facebook 的 PSID、QQ 的 C2C／群成員 OpenID 分開命名空間。iLink 用 `ilink_bot_id` 作帳戶 scope、入站 `from_user_id` 作 sender；QR 回傳的 `ilink_user_id` 另存為掃碼授權者，不能自動等同 sender／owner。ID 在重新綁定後亦可能改變，不承諾平台 ID 永遠固定。
- **綁定**：暱稱、handle、相同電話或平台的群管理員標記不能自動授予 L1；新增平台身份須由已驗證 owner 綁定。控制台目前 Instagram 名稱備註亦不能當成驗證。
- **權限**：按平台分開讀／寫 OAuth scopes、token、角色與開關。現有 WhatsApp token 不可自動擴權到新平台。公開貼文與私訊使用不同的 action／規則。
- **對話資料**：使用 `platform + bot account + conversation type + conversation ID` 分開儲存訊息、摘要及去重紀錄。這只隔離橋接端資料，不證明原生 Dot 記憶／工具已按對話硬隔離；未驗證前仍不得讓群組或其他人讀取 owner 私人資料。
- **發送**：保留來源訊息與同對話目標，平台回覆憑證只存伺服器，事件只帶 opaque reference。實際發送前重查角色、窗口、暫停與 cutoff；保留 Auto-review、引用及冪等。恢復不補發舊訊息；超時不偷偷改為新主動私訊。
- **控制台**：每個平台顯示真實連線狀態、實際能力（私聊／群聊／貼文）、審核狀態及錯誤。尚未接入的平台保持未接入；擴平台不等於開放自動公開發文。

橋接程式空轉不需要模型判斷，但這不代表事件喚醒 Dot 的用量一律為零。官方區分一般 Dot 對話及其發起的 Work／Codex 任務；本次未取得將所有原生 MCP 事件任務一概排除用量的明文依據。另計 VPS、平台或 Puppet 供應商成本。[Dot 用量說明](https://learn.chatgpt.com/docs/dots#access)

## 建議落地順序

1. **共用能力／身份模型**：保留現有 WhatsApp 路徑；IG／Facebook 平台命名空間及能力宣告已在本機實作，待部署前驗收。
2. **IG＋Facebook Page**：以真實 owner 管理帳戶完成 OAuth、私訊收發、重啟及撤權驗收。
3. **選用 `instagrapi`**：先用專用測試帳戶完成真人登入、ID 核對、私訊、owner 綁定、群組、重啟及 challenge 停止驗收；未驗收前不接主帳戶。
4. **QQ C2C＋群 @**：官方 bot 沙箱，驗收回覆窗口、簽名、媒體及撤權。
5. **微信 iLink**：私聊試驗，先確認獨立 adapter 的資格及可用性；群聊可轉在企業微信內才選 WeCom，否則另評估 Wechaty。
6. **Threads＋Moltbook**：公開貼文／留言工具與事件；另定公開發佈規則，先不啟動自主巡航發文。

每個平台以「授權成功 → 真實收訊 → 同對話回覆 → 引用／媒體 → 重啟／去重 → 暫停／撤權」逐步驗收。文件可行、沙箱通過與正式上線是不同狀態。

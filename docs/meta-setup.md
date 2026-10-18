# Instagram／Facebook 接入

[English](meta-setup.en.md) | [繁體中文](meta-setup.md) | [日本語](meta-setup.ja.md)

IG 專業帳戶私訊與 Facebook 粉專 Messenger 共用 `/admin` 通訊控制台。現有程式包含授權、Webhook、文字及圖片回覆、權限與 MCP Events；目前通過本機模擬測試，仍需真實帳戶授權及收發驗收。

本頁只說明 Meta 官方接口。個人 Instagram 私訊及群組另有選用的非官方 [`instagrapi` 接入](instagram-private.md)，使用獨立 Session 及私人數字 ID，不需要 Meta App。兩條路徑可並存，但官方 IGSID 與私人接入 ID 不可互換。

## 準備

- 一台長期開機、連網、不休眠的電腦、VPS 或 NAS，持續運行橋接服務。
- 可公開存取的 HTTPS `PUBLIC_URL`，以及現有管理員登入。
- Instagram Business／Creator 專業帳戶，或由本人管理的 Facebook Page；不支援個人 Messenger 及 Facebook 群聊。
- 自己的 Meta Developer App。初期只使用具相應 App／帳戶角色的測試者；對外服務須另完成相應 App Review／Advanced Access。

## 連接帳戶

1. 在 Meta App 設定 Instagram API with Instagram Login 或 Messenger Platform。IG 使用 `instagram_business_basic`、`instagram_business_manage_messages`；Facebook 使用 `pages_show_list`、`pages_messaging`、`pages_manage_metadata`、`pages_read_engagement`。
2. 開啟 `/admin`，在對應平台按「設定應用程式」。輸入 App ID、App Secret 及自訂 Webhook 驗證權杖。密鑰只輸入受保護的控制台，不放入 Git、聊天或網址。
3. 把表單顯示的 OAuth 回調網址加入 Meta App 的有效 redirect URI；Webhook 網址及驗證權杖加入相應產品設定，訂閱 `messages`。以控制台顯示的完整網址為準。
4. 儲存後按「連接授權」，由帳戶持有人在 Meta 完成授權。Facebook 還須在控制台選擇實際連接的 Page。
5. 核對帳戶 ID。自動回覆預設關閉；準備好後才按「開放」。連接、重啟及恢復均只處理生效時間後的新訊息，不補發舊訊息。
6. 重新掃描／授權 ChatGPT plugin，明確授予需要的平台 read／send scopes，訂閱對應事件。既有 WhatsApp grant 不會自動取得 Meta 權限。

回調及 Webhook 路徑分別是 `/admin/meta/callback/{instagram|facebook}`、`/webhooks/meta/{instagram|facebook}`。App Secret、平台 token 與原始媒體 URL 不會出現在一般控制台 API 或事件內容。

## 工具與回覆

每個平台提供 `status`、`list_chats`、`get_messages`、`get_pending_replies`、`get_media`、`send_text`、`send_image` 七項工具，名稱加上 `instagram_` 或 `facebook_`。事件為 `instagram.message_received`、`facebook.message_received`。

發送必須提供同一對話中已收到的 `sourceMessageId` 及 `idempotencyKey`。橋接器在實際發送前重查帳戶、開關、生效時間及一般 24 小時窗口；不以 `HUMAN_AGENT` 延長 AI 自動回覆。圖片限 PNG／JPEG，最大 5 MiB。來源訊息綁定是安全檢查，不代表 Meta 介面會顯示引用氣泡。

Webhook 經 App Secret 驗簽及去重，橋接器再透過簽名 MCP Events 喚醒原生 Dot；無需建立 Work 輪詢排程。Auto-review 與實際任務的用量限制仍適用。

## 身份及維護

- 依 `平台＋已連接帳戶 ID＋發訊人 ID` 判定身份；暱稱及 handle 不授權。新用戶預設 L5。官方 Instagram 的 IGSID 不可當作 `instagrapi` 私人 ID。
- 用戶發送訊息後，才可在權限表編輯 L2–L5，或明確綁定現有已驗證 owner 為 L1。舊 Instagram 名稱備註不等於已驗證綁定。
- 平台、帳戶及對話分開保存；切換或中斷後不向目前 read scope 提供舊帳戶訊息。此項不證明原生 Dot 的私人記憶或工具已按對話硬隔離。
- 憑證到期／失效時回覆停止，控制台要求重新授權；不承諾永久有效。`meta-state.json` 含敏感憑證，須保留 0600 權限並排除公開備份。

驗收依序測試：授權 → 真實收訊 → 同對話文字／圖片 → 重啟與去重 → 暫停與撤權。模擬測試通過不代表 Meta 已批准帳戶或正式收發已通過。

[Instagram 官方文件](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api) · [Messenger 官方文件](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages) · [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

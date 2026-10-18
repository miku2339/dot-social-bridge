# Instagram／Facebook の接続

[English](meta-setup.en.md) | [繁體中文](meta-setup.md) | [日本語](meta-setup.ja.md)

Instagram プロアカウントの DM と Facebook ページの Messenger は、同じ `/admin` 通信コンソールで管理します。コードには OAuth、Webhook、テキスト／画像返信、権限、MCP Events が含まれます。ローカルのモックテストは通過していますが、実アカウントの認可と送受信の確認は別途必要です。

このページは Meta 公式インターフェースだけを説明します。Instagram 個人アカウントの DM／グループには、独立 Session と個人用の数値 ID を使う任意・非公式の [`instagrapi` 接続](instagram-private.ja.md)があります。Meta App は不要です。2 つの経路は併用できますが、公式 IGSID と個人接続 ID は相互利用できません。

## 必要なもの

- スリープせず、常時起動・接続するパソコン、VPS、または NAS。
- 公開 HTTPS の `PUBLIC_URL` と既存の管理者ログイン。
- Instagram Business／Creator、または自分が管理する Facebook ページ。個人 Messenger と Facebook グループチャットは対象外です。
- 自分の Meta Developer App。最初は必要な App／アカウントの役割を持つテスターで検証します。他のアカウントに提供する場合は、該当する App Review／Advanced Access が必要です。

## アカウントを接続する

1. Meta App に Instagram API with Instagram Login または Messenger Platform を設定します。Instagram は `instagram_business_basic`、`instagram_business_manage_messages`、Facebook は `pages_show_list`、`pages_messaging`、`pages_manage_metadata`、`pages_read_engagement` を要求します。
2. `/admin` で対象プラットフォームのアプリ設定を開き、App ID、App Secret、Webhook 検証トークンを入力します。秘密情報は保護されたコンソールにのみ入力し、Git、チャット、URL には記載しません。
3. 表示された OAuth コールバック URL を有効な redirect URI に登録します。Webhook URL と同じ検証トークンを Meta 製品に登録し、`messages` を購読します。コンソールに表示される正確な URL を使用してください。
4. 保存して認可を開始し、アカウント所有者が Meta の同意画面を操作します。Facebook は接続するページもコンソールで選択します。
5. アカウント ID を確認します。自動返信は初期状態では無効です。準備ができたら有効にします。接続、再起動、再開では新しい有効化時刻以降のメッセージだけを処理し、過去分は追送しません。
6. ChatGPT plugin を再スキャン・認可し、必要なプラットフォームの read／send scopes を明示的に許可してイベントを購読します。既存の WhatsApp grant に Meta 権限は自動追加されません。

パスは `/admin/meta/callback/{instagram|facebook}` と `/webhooks/meta/{instagram|facebook}` です。通常のコンソール応答やイベントに App Secret、プラットフォーム token、元のメディア URL は含まれません。

## ツールと返信

各プラットフォームに `status`、`list_chats`、`get_messages`、`get_pending_replies`、`get_media`、`send_text`、`send_image` の 7 ツールがあります。名前の接頭辞は `instagram_` または `facebook_`、イベント名は `instagram.message_received`、`facebook.message_received` です。

送信には同じチャットで受信した `sourceMessageId` と `idempotencyKey` が必要です。送信直前にアカウント、返信スイッチ、有効化時刻、通常 24 時間の返信期限を再確認します。AI 自動返信の延長に `HUMAN_AGENT` は使用しません。画像は PNG／JPEG、最大 5 MiB です。送信元への紐付けは認可検査であり、Meta 画面の引用表示を保証するものではありません。

Webhook は App Secret で署名検証・重複排除され、署名付き MCP Events からネイティブ Dot を起動します。Work の定期ポーリングは不要です。Auto-review と実際のタスクの利用上限は引き続き適用されます。

## 身元と運用

- 身元はプラットフォーム＋接続アカウント ID＋送信者 ID で判定します。表示名や handle から権限を付与せず、新規送信者は L5 です。公式 Instagram の IGSID は `instagrapi` の個人 ID ではありません。
- 受信後に権限表で L2–L5 を編集するか、確認済み owner に明示的に紐付けて L1 にします。以前の Instagram 名称メモは確認済みの紐付けではありません。
- プラットフォーム、アカウント、チャットは別々に保存します。切替・切断後、現在の read 権限で旧アカウントのメッセージは読めません。これだけでネイティブ Dot のメモリやツールの完全分離を確認したことにはなりません。
- 認証情報が期限切れ・無効になると返信を停止し、再認可が必要です。永久有効とは限りません。認証情報を含む `meta-state.json` は 0600 を維持し、公開バックアップに含めないでください。

検証順序：認可 → 実際の受信 → 同一チャットへのテキスト／画像返信 → 再起動・重複排除 → 一時停止・権限取消。モックテストは Meta の承認や実際の配信を証明しません。

[Instagram 公式ドキュメント](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api) · [Messenger 公式ドキュメント](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages) · [MCP Events](https://developers.openai.com/plugins/build/mcp-events)

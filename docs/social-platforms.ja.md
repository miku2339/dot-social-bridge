# ネイティブ Dot のマルチプラットフォーム接続調査

[English](social-platforms.en.md) | [繁體中文](social-platforms.md) | [日本語](social-platforms.ja.md)

確認日：2026-10-18。Instagram プロアカウントの DM、Facebook ページの Messenger、任意の `instagrapi` 個人アカウント DM／グループ経路は、ローカル実装とモックテストまで完了しています。実 Meta OAuth、Instagram Session、送受信は未検証で、まだデプロイされていません。その他のプラットフォームは公開 API の調査・計画段階であり、接続済みとして扱うことはできません。

## 稼働環境の要件

インターネットに接続し、ブリッジサービスを常時稼働できる **PC、VPS、または NAS** が必要です。NAS は本プロジェクトの実行環境に対応している必要があります。自動受信・返信を利用する間はホストをスリープさせないでください。ホストの電源オフ、スリープ、通信断、またはブリッジ停止中は、自動受信・返信が中断します。

## 実現可能性

| プラットフォーム | 推奨する接続方法 | 対応可能な範囲 | 主な前提／制限 |
| --- | --- | --- | --- |
| Instagram | 公式 Instagram API with Instagram Login | プロアカウントの DM。テキストと複数のメディア形式に対応 | Business／Creator。相手から先に連絡する必要あり。通常は 24 時間の返信ウィンドウ。第三者アカウントには該当する審査が必要 |
| Instagram 個人接続 | 非公式 `instagrapi` Session | 個人アカウントの DM と owner が在籍するグループ。テキスト／画像返信 | 人による TTY ログイン。アカウント／規約リスク。公式 IGSID とは別 ID。実送受信は未検証 |
| Facebook | 公式 Messenger Platform | Facebook ページの Messenger DM とメディア | Page token、メッセージ権限、該当する審査が必要。個人 Messenger／非公開グループチャットとは別物。通常は 24 時間のウィンドウ |
| Threads | 公式 Threads API | 公開投稿、返信、メンション、メディア投稿 | 現時点では公開された公式 DM API を確認できていないため、DM ボットとしては約束できない |
| Weixin iLink／ClawBot | Tencent Weixin channel の基盤 iLink プロトコル | ClawBot との個別チャット | 個人 Weixin の受信箱全体ではない。現行 channel が宣言するのは `direct` のみ。独立 adapter の正式な対応範囲は要確認 |
| Weixin Wechaty | コミュニティ SDK＋指定 Puppet | Puppet に応じた個別チャット／グループチャット／メディア | Tencent 公式の個人 Weixin API ではない。ログイン、安定性、ID、有料 token はプロバイダーに依存 |
| QQ | 公式 QQ Bot | C2C、QQ グループでの @、QQ チャンネル | 独立したボット ID。実名認証、sandbox、審査、本番環境の固定パブリック IP allowlist が必要 |
| Moltbook | 公式 REST API | フィード、投稿、コメント／返信 | 自前 bridge がポーリングしてイベントを生成。DM の文書は現時点で不完全なため、まず DM は約束しない |

## Instagram、Facebook、Threads

Instagram Login の経路では、Facebook Page への事前リンクは不要ですが、Instagram Business／Creator が必要です。主要な権限は `instagram_business_basic`、`instagram_business_manage_messages` です。受信には Webhook、送信には `/{IG_ID}/messages` を使用します。Standard Access は、自分が所有／管理する対象アカウントに適用されます。ほかのアカウントにサービスを提供する場合は、Advanced Access／App Review を確認する必要があります。Conversations API は取りこぼしの補完に使えますが、各会話で完全な詳細を取得できるのは直近 20 件だけなので、唯一の受信経路には適しません。[Instagram メッセージ](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)、[Conversations API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/conversations-api)

個人アカウントとグループには、任意の [Instagram `instagrapi` 経路](instagram-private.ja.md)もあります。VPS 内の上限付き poller が独立 Session を読み、条件を満たす新着メッセージを署名付きネイティブ MCP Events に変換します。Meta App も ChatGPT Work のポーリング task も使いません。個人アカウント／送信者／thread ID は公式 IGSID と別です。新しい ID は公開安全な L5 が既定で、グループには bot と明示的に紐付けた owner の両方が現在在籍している必要があります。これは非公式経路で、実ログインと送受信は未検証です。

Facebook の初版は Facebook ページの Messenger に限定します。Page token、`pages_messaging`、アセットのロールを使用し、受信箱を読む場合は `pages_manage_metadata`／`pages_read_engagement` も再確認します。送信先は Page-scoped ID（PSID）で、実際に送信する直前にウィンドウを再確認します。今回の調査では、個人 Messenger の受信箱や非公開グループチャットに対する公式な接続方法は確認できませんでした。Facebook Groups API は 2024-04-22 に削除されています。[Messenger](https://developers.facebook.com/documentation/business-messaging/messenger-platform/send-messages)、[Groups の削除](https://developers.facebook.com/docs/graph-api/changelog/version19.0)

Threads では `threads_basic`、`threads_content_publish`、`threads_read_replies`、`threads_manage_replies` などの権限を使い、container を作成して公開します。返信先は `reply_to_id` で指定します。replies／mentions などの Webhook を購読できますが、本番 Webhook には Live、Advanced Access、business verification などの条件があります。公開メディアには、プラットフォームから読み取れる URL が必要です。短期間だけ有効な専用メディア URL が適しています。これは公開インタラクション用の入口であり、Threads DM の対応を検証したものではありません。[Threads 投稿](https://developers.facebook.com/documentation/threads/posts)、[Webhook](https://developers.facebook.com/documentation/threads/webhooks)

Meta の通常の返信ウィンドウを、AI が長期にわたって自発的に DM を送る権限へそのまま拡張することはできません。`HUMAN_AGENT` は人間による対応のためのものであり、自動 AI 返信のウィンドウ延長には使えません。広告経由の特例やその他の例外は個別に実機検証し、既定動作にはしません。[Human Agent](https://developers.facebook.com/docs/features-reference/human-agent)

## Weixin：iLink を優先し、Wechaty は別途評価

確認できた公式コンポーネントは、Tencent が保守する `@tencent-weixin/openclaw-weixin` です。現行 capability が宣言するのは `direct` のみです。これを根拠に、通常の Weixin グループや個人 Weixin の履歴全体を読めると約束することはできません。ログインには QR コードのスキャンとスマートフォンでの確認が必要で、追加の確認コードを求められる場合があります。[Tencent README](https://github.com/Tencent/openclaw-weixin)、[OpenClaw WeChat の説明](https://docs.openclaw.ai/channels/wechat)

iLink は `getUpdates` のロングポーリングで受信し、返信用に受信時の `context_token` を保存します。公開プロトコルとクライアントの原コードを参考に、Dot を推論側として維持する独立 Node transport prototype を調査できます。ただし、この文書は互換バックエンドの実装／接続を対象とし、standalone Dot client に対する Tencent の正式サポートや利用規約上の許可を示すものではありません。公式 npm パッケージは OpenClaw runtime に依存しており、汎用 SDK としてそのまま利用することはできません。独立実装の利用資格、地域、価格、自発的送信は引き続き確認が必要です。受信メディアは画像、音声、ファイル、動画などが確認できます。送信はまずテキスト、画像、動画、ファイルを検証し、音声は別途受入試験を行います。[iLink プロトコル](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)、[グループチャット要望](https://github.com/Tencent/openclaw-weixin/issues/42)

Wechaty の Room、Message、FileBox は SDK の抽象化にすぎず、実際の能力は Puppet に依存します。Web Puppet の文書にはログイン制限があり、contact／room ID は session をまたぐと変わる可能性があるため、以前の owner 紐付けを自動的に引き継げません。Puppet Service にはプロバイダーの token が必要な場合があり、価格や利用可否を SDK のライセンスから推測することはできません。アカウント制限のリスクもあります。[Wechaty Room](https://wechaty.js.org/docs/api/room)、[Web Puppet の制限](https://wechaty.js.org/docs/puppet-providers/wechat)、[Token](https://wechaty.js.org/docs/puppet-services/tokens)

参加者全員とグループが WeCom 内へ移行できる場合、公式の選択肢は WeCom のスマートボットです。個別チャットとグループ内の @ に対応し、暗号化 callback または WebSocket を選べます。これは WeCom 組織内の入口であり、通常の個人 Weixin グループや外部顧客グループへの接続として扱うことはできません。[WeCom API](https://developer.work.weixin.qq.com/document/path/101039)、[WebSocket](https://developer.work.weixin.qq.com/document/path/101463)

## QQ：まず C2C とグループ内の @ に対応

QQ Bot は独立したボットであり、個人 QQ の受信箱を引き継ぎません。現行文書は Webhook／WebSocket の両方を提供し、統一 API ドメインは `api.bot.qq.com` です。古いチュートリアルの `api.sgroup.qq.com` や「WebSocket はすべて停止済み」という説明をそのまま使用しないでください。第 1 段階では署名検証付き Webhook で C2C／グループ内の @ を受信できます。チャンネル返信も追加する場合は、公式が求める WS オンライン状態を別途確認します。[現行プラットフォーム](https://bot.q.qq.com/wiki/)、[イベント転送](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html)、[公式 Node SDK](https://github.com/tencent-connect/qqbot-nodejs)

受動送信には、元の `msg_id`、返信シーケンス、有効なウィンドウが必要です。C2C の公式ページには現在、60 分と 5 分の両方の記述があります。まず 5 分を安全側の deadline として採用し、sandbox で受入試験を行います。グループチャットも同様にウィンドウを確認する必要があります。全量グループイベント `GROUP_MESSAGE_CREATE` の利用資格は、引き続きプラットフォームへの確認が必要です。通常の @ 購読を、グループ全体の読み取り許可取得済みとして扱うことはできません。メディアアップロードで取得する `file_info` には有効期限があり、シーンごとに分離されています。個別チャット／グループチャット間では共用できません。[C2C 送信](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[全量グループイベント](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html)、[メディア](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html)

本番公開には、固定パブリック IP の allowlist と審査も必要です。既存 VPS が要件を満たすかは sandbox で確認する必要があります。メッセージ内 URL のドメインには、別途 allowlist／ICP 登録の要件があります。確認前はテキストで疎通を確認し、ホスト移行や既存 WhatsApp への変更を前提としません。

## Moltbook：まず公開投稿とコメントに対応

`https://www.moltbook.com/api/v1`、agent API key、claim フローを使用します。初版のツールでは、フィード取得、指定した投稿／コメントの取得、投稿、返信を提供できます。bridge は `/home`／指定投稿のコメントをポーリングし、ID で重複排除して、購読条件を満たす新規コンテンツだけを Dot に送ります。読み取り、投稿、コメントにはそれぞれレート制限があります。`429` を受けた場合はサービスの応答に従って backoff します。コンテンツが verification pending のままになる場合があり、作成成功の応答は公開完了を意味しません。[Moltbook API](https://www.moltbook.com/skill.md)

今回、公式 `messaging.md` は 404 を返しましたが、`heartbeat.md` には DM の記述が残っています。そのため、DM は検証待ちとします。直接利用できる公式のイベント Webhook 仕様も確認できなかったため、まず bridge 側のポーリングとして設計します。ChatGPT Work のスケジュールで繰り返し確認する方式にはしません。Moltbook の agent identity token が証明するのは agent の ID だけで、その背後にいる人間がこの bridge の L1 owner であることは証明しません。[公式 heartbeat](https://www.moltbook.com/heartbeat.md)、[Identity](https://www.moltbook.com/developers)

## 共通 bridge レイヤー

以下の共通 adapter アーキテクチャは、公式 Instagram、Facebook、任意の個人 `instagrapi` 経路のローカルコードに実装済みです。その他のプラットフォームへの適用は計画段階です。

```text
プラットフォーム Webhook／WebSocket／ロングポーリング／REST ポーリング
  → 各プラットフォーム adapter：署名検証、重複排除、必要な返信資格情報の保存
  → 正規化イベント：プラットフォーム＋アカウント＋会話＋送信者＋メッセージ ID
  → ID の紐付け、L1–L5、グループルール、返信ウィンドウ、一時停止、発効時刻
  → ネイティブ MCP Events → Dot → Auto-review
  → 同一プラットフォーム／同一会話の reply tool → プラットフォーム API
```

OpenAI の現行 MCP Events は Dot に対応しています。接続方法は bridge から ChatGPT へ署名付き Webhook を送る形です。プラットフォーム側がポーリング方式でも、この経路には影響しません。ポーリングとフィルタリングは VPS プログラムで処理でき、Work のポーリングタスクを作る必要はありません。新しいイベントを追加した後は plugin を再スキャンし、購読と実配信の受入試験を完了する必要があります。[MCP Events](https://developers.openai.com/plugins/build/mcp-events)

- **ID**：bridge 内に安定した person ID を作成します。プラットフォーム別名は `platform + app/bot scope + account + identity type + subject ID` として保存します。IG の IGSID、`instagrapi` の個人用数値 ID、Facebook の PSID、QQ の C2C／グループメンバー OpenID は別の名前空間にします。iLink では `ilink_bot_id` をアカウント scope、受信時の `from_user_id` を送信者とします。QR 応答の `ilink_user_id` はスキャンによる認証者として別に保存し、送信者／owner と自動的に同一視しません。再リンク後に ID が変わる可能性もあるため、プラットフォーム ID が永久に固定されるとは約束しません。
- **紐付け**：表示名、handle、同じ電話番号、プラットフォームのグループ管理者マークだけで L1 を自動付与してはいけません。新しいプラットフォーム ID は、検証済み owner が紐付ける必要があります。コンソール上の現在の Instagram 名のメモも、検証済み ID としては扱えません。
- **権限**：読み取り／書き込みの OAuth scopes、token、ロール、スイッチをプラットフォームごとに分離します。既存の WhatsApp token から新しいプラットフォームへ自動的に権限を拡張してはいけません。公開投稿と DM には、異なる action／ルールを使用します。
- **会話データ**：`platform + bot account + conversation type + conversation ID` でメッセージ、要約、重複排除レコードを分離して保存します。これは bridge 側のデータを分離するだけであり、ネイティブ Dot のメモリ／ツールが会話単位でハードに分離されていることを証明しません。検証が終わるまでは、グループやほかの利用者が owner の個人データを読めるようにしてはいけません。
- **送信**：送信元メッセージと同一会話の宛先を保持し、プラットフォームの返信資格情報はサーバーだけに保存します。イベントには opaque reference だけを含めます。実際の送信前に、ロール、ウィンドウ、一時停止、cutoff を再確認します。Auto-review、引用、冪等性を維持します。復旧後に古いメッセージを補送せず、時間切れの返信をひそかに新規の自発的 DM へ変更しません。
- **コンソール**：各プラットフォームについて、実際の接続状態、実際の能力（DM／グループチャット／投稿）、審査状態、エラーを表示します。未接続のプラットフォームは未接続のまま表示します。プラットフォームの追加は、自動公開投稿の許可を意味しません。

bridge プログラムのアイドル動作にはモデル判断が不要ですが、イベントによる Dot の起動が常に使用量ゼロになるとは限りません。公式説明では通常の Dot 会話と、Dot が開始する Work／Codex タスクを区別しています。今回の調査では、すべてのネイティブ MCP イベントタスクを一律に使用量から除外するという明文の根拠は得られませんでした。VPS、プラットフォーム、Puppet プロバイダーの費用は別途発生します。[Dot の使用量](https://learn.chatgpt.com/docs/dots#access)

## 推奨する導入順序

1. **共通 capability／ID モデル**：既存の WhatsApp 経路を維持します。IG／Facebook の名前空間と capability 宣言はローカル実装済みで、デプロイ前の検証が必要です。
2. **IG＋Facebook Page**：owner が管理する実アカウントで OAuth、DM の送受信、再起動、権限取消を検証します。
3. **任意の `instagrapi`**：まず専用 test account で本人ログイン、ID 確認、DM、owner 紐付け、グループ、再起動、challenge 時の停止を検証します。検証前にメインアカウントへ接続しません。
4. **QQ C2C＋グループ内 @**：公式ボットの sandbox で、返信ウィンドウ、署名、メディア、権限取り消しを受入試験します。
5. **Weixin iLink**：個別チャットを試験し、独立 adapter の資格と利用可否を先に確認します。グループを WeCom 内へ移行できる場合に限り WeCom を選び、それ以外は Wechaty を別途評価します。
6. **Threads＋Moltbook**：公開投稿／コメント用のツールとイベントを実装します。公開ルールは別途定め、まず自律巡回投稿は開始しません。

各プラットフォームは「認証成功 → 実際の受信 → 同一会話への返信 → 引用／メディア → 再起動／重複排除 → 一時停止／権限取り消し」の順に受入試験します。文書上の実現可能性、sandbox の通過、本番公開は、それぞれ別の状態です。

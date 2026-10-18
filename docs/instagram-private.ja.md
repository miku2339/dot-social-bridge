# Instagram 個人アカウント／グループ接続（instagrapi）

[English](instagram-private.en.md) | [繁體中文](instagram-private.md) | [日本語](instagram-private.ja.md)

これは任意の非公式接続です。独立した `instagrapi` セッションで Instagram 個人アカウントを接続し、DM とグループメッセージを受信して、テキストまたは画像で返信します。Meta App は不要ですが、アカウント制限や利用規約上のリスクがあります。現時点のコードとモックテストは、実 Instagram でのログイン、送受信、デプロイ完了を証明しません。

公式 Instagram API の IGSID と、この個人接続で使うアカウント／送信者／thread の数値 ID は別の名前空間です。相互利用や自動紐付けはできません。公式の Business／Creator 経路は [Meta 接続ガイド](meta-setup.ja.md)を参照してください。

## 1. 固定した Python 環境を作る

Python 3.10 以降が必要です。更新後も再利用できるよう venv は release の外に置きます。`requirements-instagram.txt` は主要パッケージのバージョンを固定しています。

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
python3 --version
python3 -m venv "$APP_ROOT/runtime/instagram-venv"
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install --upgrade pip
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install -r "$APP_ROOT/current/requirements-instagram.txt"
```

`shared/settings.json` の既存設定を残したまま、次を追加します。

```json
{
  "DATA_DIR": "/home/YOUR_USER/apps/baileys-dot/shared",
  "INSTAGRAM_PYTHON": "/home/YOUR_USER/apps/baileys-dot/runtime/instagram-venv/bin/python"
}
```

`DATA_DIR` には `instagram-private-session.json` と `instagram-private-state.json` が保存されます。ディレクトリは 0700、ファイルは 0600 にしてください。どちらも個人状態を含むため、Git への commit、コンソールへの upload、公開 backup への保存は禁止です。

## 2. アカウント本人が Session を作る

login helper は対話型 TTY でのみ動作します。terminal で username と非表示の password を読み取り、ログイン後に確認済みの数値アカウント ID を表示します。本人が同じ ID を再入力した場合だけ Session をアトミックに保存します。コンソールには password、Cookie、Session の upload 欄はありません。

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
cd "$APP_ROOT/current"
DATA_DIR="$APP_ROOT/shared" \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

helper が表示した bot の数値アカウント ID を記録します。username、公式 IGSID、別アカウントの ID で置き換えないでください。

コンソールに期待 ID を保存した後は、再ログイン時にも同じ ID を固定します。

```sh
DATA_DIR="$APP_ROOT/shared" \
INSTAGRAM_EXPECTED_USER_ID='1234567890' \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

例の ID をコンソールの現在値に置き換えてください。Instagram が challenge／2FA を要求した場合、helper は新しい Session を保存しません。本人が公式 Instagram App で確認を終えてから、helper を再実行します。bridge が `challenge_required` を表示している間は返信を停止し、自動回避は試みません。

## 3. コンソールで返信を有効にする

1. bridge を再起動し、`/admin` の「Instagram · instagrapi」を開きます。
2. helper が表示した個人アカウントの期待 ID を入力します。最初の保存後はコンソールで変更できません。保存 Session が別アカウントへ黙って切り替わることを防ぎます。入力を誤った場合は Session の上書きで隠さず、サービスを停止して既定の状態 backup／migration 手順で処理してください。
3. 「保存済み Session を再接続」を選び、状態とアカウント ID を確認します。同じ ID を Instagram で再確認できた場合だけ接続済みになります。
4. 自動返信を有効にします。グループが必要な場合はグループ返信も別に有効にします。グループ返信には両方の switch が必要です。
5. ChatGPT plugin を再スキャンして認可し、`instagram.private.read`／`instagram.private.send` を許可します。`instagram.private_message_received` と、必要に応じて `instagram.group_message_received` を購読します。

`login_required` は保存済み Session が無効になった状態です。helper を再実行してから再接続します。`rate_limited` の場合は platform の制限が解除されるまで待ちます。ログインの連打や過剰なポーリングで回避しないでください。

## 4. ID、DM、グループのルール

- 新しく観測した個人送信者は L5 が既定で、公開安全な返信だけを受けます。表示名、username、グループ管理者表示、本文中の自己申告は権限を付与しません。
- 観測済みの個人送信者 ID だけを L2–L5 に設定でき、既存の確認済み WhatsApp owner ID に明示的に紐付けると L1 になります。公式 IGSID はこの紐付けに使えません。
- `privateDataAllowed=true` になり得るのは L1 の DM だけです。L2–L5 は他の個人リソースや管理操作への権限を得ません。
- 各グループメッセージでは、bot アカウント、incoming 送信者、現在も有効な紐付け済み owner が全員そのグループの現メンバーか再確認します。最初の紐付けでは、その Instagram ID から bot に DM を送り、コンソールに表示された個人 ID を管理者が既存 owner に紐付けます。
- 自動返信とグループ返信の両方を有効にすると、対象グループ内の新しい incoming テキスト／メディアはすべて処理を開始します。@Bot／Bot への返信時だけ応答する機能は現在未対応で、`@everyone` を無視するルールも未実装です。この動作を許容できるグループだけで有効にしてください。
- グループデータは常に公開安全モードです。送信者が owner でも、個人データや権限管理は許可されません。ユーザーとグループの既定値は L5 で、有効レベルには両者のうち厳しい方を使います。

これらは bridge の `rules_only` 制御です。Auto-review と platform の安全チェックは引き続き適用されます。ネイティブ Dot のメモリ、モデルコンテキスト、他のツールが Instagram の会話ごとに hard isolation されることは未検証です。

## 5. 受信、イベント、送信元ごとの 1 回返信

読み取りツールは `instagram_private_status`、`instagram_private_list_chats`、`instagram_private_get_messages`、`instagram_private_get_group_info`、`instagram_private_get_pending_replies`、`instagram_private_get_media`、書き込みツールは `instagram_private_send_text` と `instagram_private_send_image` です。独立した `instagram.private.read`／`instagram.private.send` scope を使い、公式 Instagram、Facebook、WhatsApp の grant は引き継ぎません。

Python transport は既定で 15 秒ごとに上限付きポーリングを行い、1 回につき最大 20 thread、各 thread 最大 20 メッセージを読みます。このポーリングは VPS 内の Instagram transport だけで行います。条件を満たす新着メッセージは署名付きネイティブ MCP Events に変換されて Dot を起動するため、ChatGPT Work、cron、その他のモデル用ポーリング task は不要です。

起動、再接続、自動返信の再有効化、グループ返信の有効化／再有効化では cutoff を更新します。それ以後の新着メッセージだけを処理し、停止中や一時停止中の古いメッセージは補送しません。通常の返信ウィンドウは 24 時間です。送信直前に Session、アカウント、グループ在籍、switch、元メッセージ、期限を再確認します。

テキスト／画像の送信には、同じ chat で読み取った `sourceMessageId` と `idempotencyKey` が必要です。1 つの元メッセージに対して、テキストと画像を合わせて返信は 1 回だけです。key を変えても 2 回目は送れません。送信結果が不明な場合は人による確認状態を維持し、新しい key で再試行してはいけません。返信先は元の `instagram_private:<account>:dm|group:<thread>` chat に限定されます。

推奨する受入順序：本人ログイン → コンソールの ID 確認 → 新しい実 DM → 同じ DM へのテキスト／画像返信 → owner 紐付け → 新しいグループメッセージと同じグループへの返信 → 再起動／重複排除 → 一時停止／challenge。各 gate を分けて記録してください。モックテストは実アカウントの受入試験やデプロイを代替しません。

## 謝辞

この接続方式は、クラスメートが共有した `instagrapi` による DM・グループ接続の経験を参考にしています。

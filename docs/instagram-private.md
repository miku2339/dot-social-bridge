# Instagram 私人帳戶及群組接入（instagrapi）

[English](instagram-private.en.md) | [繁體中文](instagram-private.md) | [日本語](instagram-private.ja.md)

這是選用的非官方接入：以獨立 `instagrapi` Session 連接 Instagram 私人帳戶，支援私訊及群組收訊，並以文字或圖片回覆。它不需要 Meta App，但可能有帳戶限制或服務條款風險。現有程式及模擬測試不能證明真實 Instagram 登入、收發或部署已完成。

官方 Instagram API 的 IGSID，與這條私人接入的帳戶、發訊人及 thread 數字 ID 屬不同命名空間，不能互換或自動綁定。需要官方 Business／Creator 路徑時，請使用 [Meta 接入指南](meta-setup.md)。

## 1. 建立固定 Python 環境

需要 Python 3.10 或以上。以下把 venv 放在 release 之外，更新程式時可繼續使用；`requirements-instagram.txt` 固定主要套件版本。

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
python3 --version
python3 -m venv "$APP_ROOT/runtime/instagram-venv"
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install --upgrade pip
"$APP_ROOT/runtime/instagram-venv/bin/python" -m pip install -r "$APP_ROOT/current/requirements-instagram.txt"
```

在 `shared/settings.json` 保留現有設定並加入：

```json
{
  "DATA_DIR": "/home/YOUR_USER/apps/baileys-dot/shared",
  "INSTAGRAM_PYTHON": "/home/YOUR_USER/apps/baileys-dot/runtime/instagram-venv/bin/python"
}
```

`DATA_DIR` 保存 `instagram-private-session.json` 與 `instagram-private-state.json`；目錄須為 0700，檔案須為 0600。兩者均包含私人狀態，不可提交 Git、上載控制台或放入公開備份。

## 2. 由帳戶本人建立 Session

登入 helper 只接受互動式 TTY。它在終端機讀取 username 及隱藏的 password，登入後顯示已核對的數字帳戶 ID，並要求本人重新輸入該 ID 才會原子寫入 Session。控制台沒有 password、Cookie 或 Session 上載欄位。

```sh
export APP_ROOT="$HOME/apps/baileys-dot"
cd "$APP_ROOT/current"
DATA_DIR="$APP_ROOT/shared" \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

記下 helper 顯示的 bot 數字帳戶 ID。不要使用 username、官方 IGSID 或其他帳戶的 ID 代替。

如果控制台已設定 ID，重新登入時應同時鎖定同一身份：

```sh
DATA_DIR="$APP_ROOT/shared" \
INSTAGRAM_EXPECTED_USER_ID='1234567890' \
  "$APP_ROOT/runtime/instagram-venv/bin/python" login-instagram.py
```

把示例 ID 換成控制台現有值。若 Instagram 要求 challenge／2FA，helper 不會保存新 Session；由本人在官方 Instagram App 完成驗證後再執行 helper。橋接器顯示 `challenge_required` 時會停止回覆，不會嘗試自動繞過驗證。

## 3. 在控制台開放回覆

1. 重新啟動 bridge，開啟 `/admin` 的「Instagram · instagrapi」。
2. 輸入 helper 顯示的「預期私人帳戶 ID」。首次保存後不可在控制台更改；這防止舊 Session 靜默切換到另一帳戶。填錯時不要覆蓋 Session 假裝修正，應停止服務並按既定備份／遷移程序處理狀態。
3. 按「重新連接已儲存 Session」，核對狀態及帳戶 ID。只有 bridge 重新向 Instagram 核對同一 ID 後才會顯示已連接。
4. 開放「自動回覆」。如需群組，再另外開放「群組回覆」。兩個開關都開放時群組才會回覆。
5. 重新掃描並授權 ChatGPT plugin，授予 `instagram.private.read`／`instagram.private.send`，訂閱 `instagram.private_message_received` 及需要時的 `instagram.group_message_received`。

`login_required` 表示已保存 Session 失效；重新執行 helper，再按重新連接。`rate_limited` 應等待平台限制解除。任何狀態都不要以重複登入或大量輪詢強行繞過。

## 4. 身份、私訊及群組規則

- 私人接入的新發訊人預設為 L5，只可得到公開安全回覆；顯示名稱、username、群管理員標記及正文自稱均不授權。
- 只有已觀察的私人發訊人 ID 才可設定 L2–L5，或明確綁定至現有、已驗證的 WhatsApp owner ID 成為 L1。官方 IGSID 不可用作這項綁定。
- L1 私訊才可標記 `privateDataAllowed=true`；L2–L5 不因級別而取得其他私人資源或管理權。
- 每則群組訊息都會重新核對 bot 帳戶、incoming 發訊人及目前仍有效的已綁定 owner 都是該群組成員。要建立首次綁定，該 Instagram 身份須先私訊 bot，讓控制台觀察其私人 ID，再由管理員綁定現有 owner。
- 總回覆及群組回覆開關同時開放後，合資格群組內所有新的 incoming 文字或媒體都會觸發；目前未支援只在 @Bot／引用 Bot 時回覆，亦未實作 `@everyone` 靜默規則。只應在接受這項行為的群組開放。
- 群組資料一律按公開安全模式處理；即使發訊人是 owner，群內也不開放私人資料或權限管理。群組及用戶預設 L5，有效級別取兩者較嚴格的一級。

這些是 bridge 的 `rules_only` 規則。Auto-review 及平台安全檢查仍然生效；目前沒有驗證原生 Dot 的記憶、模型上下文或其他工具已按 Instagram 對話硬隔離。

## 5. 收訊、事件及一次回覆

唯讀工具是 `instagram_private_status`、`instagram_private_list_chats`、`instagram_private_get_messages`、`instagram_private_get_group_info`、`instagram_private_get_pending_replies`、`instagram_private_get_media`；寫入工具是 `instagram_private_send_text`、`instagram_private_send_image`。所有工具使用 `instagram.private.read` 或 `instagram.private.send` 獨立 scope，不沿用官方 Instagram、Facebook 或 WhatsApp grant。

Python transport 預設每 15 秒作一次有界輪詢，每次最多讀 20 個 thread、每個最多 20 則訊息；這只是 VPS 內的 Instagram transport。符合規則的新訊息會轉成簽名的原生 MCP Events 喚醒 Dot，不需要 ChatGPT Work、cron 或其他模型輪詢任務。

啟動、重新連接、重新開放自動回覆或開放／重新開放群組回覆都會更新 cutoff，只處理其後的新訊息；不補發停機或暫停期間的舊訊息。一般回覆窗口為 24 小時，發送前會重新核對 Session、帳戶、群組成員、開關、來源訊息及窗口。

文字及圖片發送均須提供同一對話內已讀取的 `sourceMessageId` 及 `idempotencyKey`。每個來源訊息在文字／圖片之間合共只可有一次回覆；改 key 不能再發第二次。結果不明時保留人工覆核狀態，不可換 key 重試，以免重複發送。回覆只可發回來源的同一 `instagram_private:<account>:dm|group:<thread>`。

建議驗收次序：真人登入 → 控制台核對 ID → 真實新私訊 → 同私訊文字／圖片回覆 → owner 綁定 → 新群組訊息及同群回覆 → 重啟／去重 → 暫停／challenge。每一步分開記錄；模擬測試通過不能代替真實帳戶驗收或部署。

## 致謝

本接入方案參考同學分享的 `instagrapi` 私訊與群組連接經驗。

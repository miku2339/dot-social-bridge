function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function previewBanner(preview) {
  return preview ? '<p class="preview-banner" role="status">本機預覽・示範資料</p>' : ''
}

function metaChannelCard(platform, title, description, icon) {
  return `<article class="card channel-card meta-channel-card" data-meta-platform="${platform}" aria-labelledby="${platform}-title">
    <div class="card-heading">
      <div class="channel-name">
        <span class="channel-icon channel-icon-${platform}" aria-hidden="true">${icon}</span>
        <div><h3 id="${platform}-title">${title}</h3><p>${description}</p></div>
      </div>
      <span class="status-badge status-neutral" data-meta-status>讀取中</span>
    </div>
    <dl class="channel-facts">
      <div><dt>帳戶</dt><dd data-meta-account-name>—</dd></div>
      <div><dt>帳戶 ID</dt><dd class="mono" data-meta-account-id>—</dd></div>
      <div><dt>自動回覆</dt><dd data-meta-reply-state>—</dd></div>
    </dl>
    <p class="supporting-text meta-status-note" data-meta-status-note>正在讀取連線狀態。</p>
    <div class="channel-action-row meta-actions">
      <button class="button button-secondary button-small" data-meta-config-toggle type="button">設定應用程式</button>
      <button class="button button-primary button-small" data-meta-connect type="button" disabled>連接${title}授權</button>
      <button class="button button-secondary button-small" data-meta-replies type="button" hidden>開放</button>
      <button class="button button-danger button-small" data-meta-disconnect type="button" hidden>中斷連接</button>
    </div>
    <div class="inline-confirm" data-meta-disconnect-confirm hidden>
      <span>確定中斷此帳戶？</span>
      <button class="button button-danger button-small" data-meta-disconnect-yes type="button">確認中斷</button>
      <button class="button button-secondary button-small" data-meta-disconnect-no type="button">取消</button>
    </div>
    <form class="meta-config-form" data-meta-config-form hidden>
      <div class="form-grid form-grid-single">
        <label><span>App ID</span><input name="appId" inputmode="numeric" maxlength="200" autocomplete="off" spellcheck="false"></label>
        <label>
          <span>App Secret</span>
          <input name="appSecret" type="password" maxlength="4096" autocomplete="new-password" placeholder="留空保留現有密鑰">
          <small data-meta-secret-state>尚未設定</small>
        </label>
        <label>
          <span>驗證權杖</span>
          <input name="verifyToken" type="password" maxlength="4096" autocomplete="new-password" placeholder="留空保留現有權杖">
          <small data-meta-token-state>尚未設定</small>
        </label>
        <label>
          <span>OAuth 回調網址</span>
          <span class="copy-field"><input name="callbackUrl" readonly><button class="button button-secondary button-small" data-copy-field="callbackUrl" type="button">複製</button></span>
        </label>
        <label>
          <span>Webhook 網址</span>
          <span class="copy-field"><input name="webhookUrl" readonly><button class="button button-secondary button-small" data-copy-field="webhookUrl" type="button">複製</button></span>
        </label>
      </div>
      <div class="form-actions">
        <button class="button button-secondary" data-meta-config-cancel type="button">取消</button>
        <button class="button button-primary" type="submit">儲存設定</button>
      </div>
    </form>
    <form class="asset-form" data-meta-asset-form hidden>
      <label><span>選擇已授權的 Facebook 專頁</span><select name="accountId" required></select></label>
      <button class="button button-primary button-small" type="submit">連接專頁</button>
    </form>
  </article>`
}

const instagramIcon = '<svg viewBox="0 0 24 24" focusable="false"><rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.5"/><circle class="icon-fill" cx="17.2" cy="6.8" r="1"/></svg>'
const facebookIcon = '<svg viewBox="0 0 24 24" focusable="false"><path class="icon-fill" d="M13.8 21v-8h2.7l.4-3h-3.1V8.1c0-.9.3-1.5 1.6-1.5H17V3.9c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4V10H8.2v3h2.6v8h3Z"/></svg>'

function instagramPrivateCard() {
  return `<article class="card channel-card" data-instagram-private-card aria-labelledby="instagram-private-title">
    <div class="card-heading">
      <div class="channel-name">
        <span class="channel-icon channel-icon-instagram-private" aria-hidden="true">${instagramIcon}</span>
        <div><h3 id="instagram-private-title">Instagram · instagrapi</h3><p>非官方私人帳戶及群組連接</p></div>
      </div>
      <span class="status-badge status-neutral" data-instagram-private-status>讀取中</span>
    </div>
    <dl class="channel-facts">
      <div><dt>私人帳戶 ID</dt><dd class="mono" data-instagram-private-account>—</dd></div>
      <div><dt>自動回覆</dt><dd data-instagram-private-replies>—</dd></div>
      <div><dt>群組回覆</dt><dd data-instagram-private-groups>—</dd></div>
    </dl>
    <p class="supporting-text" data-instagram-private-note>正在讀取獨立 Session 狀態。</p>
    <div class="channel-action-row private-channel-actions">
      <button class="button button-secondary button-small" data-instagram-private-config-toggle type="button">設定帳戶 ID</button>
      <button class="button button-secondary button-small" data-instagram-private-reconnect type="button" disabled>重新連接已儲存 Session</button>
      <button class="button button-secondary button-small" data-instagram-private-replies-toggle type="button" disabled>開放自動回覆</button>
      <button class="button button-secondary button-small" data-instagram-private-groups-toggle type="button" aria-describedby="instagram-private-groups-help" disabled>開放群組</button>
    </div>
    <p class="supporting-text" id="instagram-private-groups-help">開啟後處理合資格群組的新訊息；目前未支援只在 @ 時回覆。</p>
    <form class="private-config-form" data-instagram-private-config-form hidden>
      <label>
        <span>預期私人帳戶 ID</span>
        <input name="expectedAccountId" inputmode="numeric" pattern="[0-9]+" maxlength="64" autocomplete="off" spellcheck="false" required>
        <small>在伺服器終端機執行登入 helper，由帳戶本人完成登入；helper 會提供此數字 ID。</small>
      </label>
      <div class="form-actions">
        <button class="button button-secondary" data-instagram-private-config-cancel type="button">取消</button>
        <button class="button button-primary" type="submit">儲存帳戶 ID</button>
      </div>
    </form>
  </article>`
}

function instagramPrivatePermissions() {
  return `<section class="card permissions-card" aria-labelledby="instagram-private-permissions-title" data-instagram-private-permissions>
    <div class="card-heading permissions-heading">
      <div><p class="eyebrow">Instagram · instagrapi</p><h2 id="instagram-private-permissions-title">私人連接權限</h2><p class="supporting-text">私人連接 ID 與官方 Instagram IGSID 分開管理。</p></div>
      <span class="status-badge status-neutral" data-instagram-private-permissions-status>讀取中</span>
    </div>
    <div class="table-scroll" tabindex="0" aria-label="Instagram 私人連接權限名單，可水平捲動">
      <table><thead><tr><th scope="col">用戶</th><th scope="col">私人用戶 ID</th><th scope="col">級別</th><th scope="col">綁定狀態</th><th scope="col" class="actions-column">編輯</th></tr></thead><tbody data-instagram-private-users></tbody></table>
    </div>
    <p class="empty-state" data-instagram-private-users-empty hidden>尚未觀察到可設定用戶。</p>

    <form class="inline-editor" data-instagram-private-user-form hidden>
      <div class="editor-heading"><div><p class="eyebrow">私人連接權限</p><h3>編輯用戶</h3></div><button class="icon-button" data-instagram-private-user-close type="button" aria-label="關閉表單">×</button></div>
      <div class="form-grid">
        <label><span>私人用戶 ID</span><input name="senderId" readonly></label>
        <label><span>顯示名稱</span><input name="displayName" required maxlength="100" autocomplete="off"></label>
        <label><span>權限級別</span><select name="level" required><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option><option value="L5">L5（預設）</option></select><small data-instagram-private-owner-note hidden>L1 綁定用戶的級別不可編輯。</small></label>
        <label data-instagram-private-owner-field hidden><span>綁定 WhatsApp 擁有人</span><select name="ownerId"></select><small>只可選擇現有已驗證 WhatsApp 擁有人。</small></label>
      </div>
      <div class="form-actions">
        <button class="button button-danger" data-instagram-private-user-delete type="button">刪除</button>
        <button class="button button-secondary" data-instagram-private-user-cancel type="button">取消</button>
        <button class="button button-secondary" data-instagram-private-owner-bind type="button" hidden>綁定為 L1</button>
        <button class="button button-danger" data-instagram-private-owner-unbind type="button" hidden>解除 L1 綁定</button>
        <button class="button button-primary" data-instagram-private-user-save type="submit">儲存用戶</button>
      </div>
    </form>

    <details class="private-groups-panel">
      <summary><span><strong>私人群組級別</strong><span class="summary-hint">只顯示此 Session 已觀察的群組</span></span></summary>
      <div class="groups-content"><div data-instagram-private-groups-list></div><p class="empty-state" data-instagram-private-groups-empty hidden>尚未觀察到可設定群組。</p></div>
    </details>
  </section>`
}

export function renderConsolePage({ csrf, preview = false } = {}) {
  const safeCsrf = escapeHtml(csrf)
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="admin-csrf" content="${safeCsrf}">
  <title>通訊控制台</title>
  <link rel="stylesheet" href="/admin/assets/console.css">
  <script defer src="/admin/assets/console.js"></script>
  <script defer src="/admin/assets/instagram-private.js"></script>
</head>
<body>
  <a class="skip-link" href="#main-content">跳到主要內容</a>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><div><p class="eyebrow">WhatsApp・Instagram・Facebook</p><h1>通訊控制台</h1><p>管理橋接帳戶與統一權限</p></div></div>
      <div class="topbar-actions">
        <button class="button button-secondary" id="refresh-button" type="button">重新整理</button>
        <button class="button button-primary" id="add-user-button" type="button">＋ 新增用戶</button>
      </div>
    </header>

    <main id="main-content">
      ${previewBanner(preview)}
      <div class="notice" id="console-notice" role="status" aria-live="polite" hidden></div>
      <section aria-label="通訊平台連線概況">
        <div class="channel-grid">
          <article class="card channel-card" aria-labelledby="whatsapp-title">
            <div class="card-heading">
              <div class="channel-name">
                <span class="channel-icon channel-icon-whatsapp" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7.4 19.1 4 20l.9-3.3A8 8 0 1 1 7.4 19.1Z"/><path d="M8.6 7.5c.3-.3.8-.2 1 .2l.7 1.6c.1.3.1.6-.2.8l-.7.6a8.1 8.1 0 0 0 3.9 3.9l.6-.7c.2-.3.6-.3.8-.2l1.6.7c.4.2.5.7.2 1-1 1.2-2.4 1.5-3.8 1A10.6 10.6 0 0 1 7.6 11c-.5-1.3-.2-2.6 1-3.5Z"/></svg></span>
                <div><h3 id="whatsapp-title">WhatsApp</h3><p>橋接回覆入口</p></div>
              </div>
              <span class="status-badge" id="whatsapp-status">讀取中</span>
            </div>
            <dl class="channel-facts">
              <div><dt>帳戶</dt><dd id="whatsapp-account-name">—</dd></div>
              <div><dt>帳戶 ID</dt><dd class="mono" id="whatsapp-account-id">—</dd></div>
              <div><dt>群組回覆</dt><dd id="whatsapp-group-status">—</dd></div>
            </dl>
            <div class="channel-action-row"><div><span class="field-label">橋接回覆入口</span><strong id="reply-entry-state">—</strong></div><button class="button button-secondary button-small" id="reply-toggle" type="button" disabled>設定</button></div>
            <p class="supporting-text">原生 Dot 任務請於 ChatGPT 管理。</p>
            <details id="qr-details" hidden><summary>顯示 WhatsApp 配對 QR Code</summary><div class="qr-wrap"><img id="qr-image" alt="WhatsApp 配對 QR Code"></div></details>
          </article>
          ${metaChannelCard('instagram', 'Instagram', '專業帳戶私訊', instagramIcon)}
          ${metaChannelCard('facebook', 'Facebook', '粉專私訊', facebookIcon)}
          ${instagramPrivateCard()}
        </div>
      </section>

      <section class="card permissions-card" aria-labelledby="permissions-title">
        <div class="card-heading permissions-heading">
          <div><p class="eyebrow">L1–L5</p><h2 id="permissions-title">統一權限名單</h2><p class="supporting-text" id="policy-summary">讀取中</p></div>
          <span class="status-badge" id="policy-status">讀取中</span>
        </div>
        <div class="table-scroll" tabindex="0" aria-label="權限名單，可水平捲動">
          <table><thead><tr><th scope="col">用戶</th><th scope="col">平台及帳戶 ID</th><th scope="col">級別</th><th scope="col">綁定狀態</th><th scope="col" class="actions-column">編輯</th></tr></thead><tbody id="users-body"></tbody></table>
        </div>
        <p class="empty-state" id="users-empty" hidden>目前未有非擁有人用戶。</p>

        <form class="inline-editor" id="user-form" hidden>
          <div class="editor-heading"><div><p class="eyebrow">權限資料</p><h3 id="user-form-title">新增用戶</h3></div><button class="icon-button" id="cancel-user-button" type="button" aria-label="關閉表單">×</button></div>
          <div class="form-grid">
            <label><span>顯示名稱</span><input name="displayName" required maxlength="100" autocomplete="off"></label>
            <label><span>WhatsApp 帳戶 ID</span><input name="whatsappId" required maxlength="180" autocomplete="off" spellcheck="false" aria-describedby="whatsapp-id-note"><small id="whatsapp-id-note">新增時可填數字電話或完整 WhatsApp ID；儲存後不可更改。</small></label>
            <label><span>Instagram 名稱（備註）</span><input name="instagramUsername" maxlength="100" autocomplete="off" spellcheck="false" aria-describedby="instagram-note"><small id="instagram-note">待接入；不驗證、不授予權限。</small></label>
            <label><span>權限級別</span><select name="level" required><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option><option value="L5" selected>L5（預設）</option></select></label>
          </div>
          <div class="form-actions"><button class="button button-secondary" id="cancel-user-secondary" type="button">取消</button><button class="button button-primary" type="submit">儲存用戶</button></div>
        </form>

        <form class="inline-editor" id="meta-user-form" hidden>
          <div class="editor-heading"><div><p class="eyebrow">Meta 權限</p><h3>編輯用戶</h3></div><button class="icon-button" id="cancel-meta-user-button" type="button" aria-label="關閉表單">×</button></div>
          <div class="form-grid">
            <label><span>平台</span><input name="platformLabel" readonly></label>
            <label><span>帳戶 ID</span><input name="accountId" readonly></label>
            <label><span>發送者 ID</span><input name="senderId" readonly></label>
            <label><span>顯示名稱</span><input name="displayName" required maxlength="100" autocomplete="off"></label>
            <label><span>權限級別</span><select name="level" required><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option><option value="L5">L5（預設）</option></select><small id="meta-owner-level-note" hidden>已綁定擁有人，級別固定為 L1。</small></label>
            <label id="meta-owner-field" hidden><span>綁定擁有人</span><select name="ownerId"></select><small>綁定後會成為 L1；必須明確選擇。</small></label>
          </div>
          <div class="form-actions" id="meta-user-actions">
            <button class="button button-danger" id="delete-meta-user-button" type="button">刪除</button>
            <button class="button button-secondary" id="cancel-meta-user-secondary" type="button">取消</button>
            <button class="button button-secondary" id="bind-meta-owner-button" type="button" hidden>綁定為 L1</button>
            <button class="button button-danger" id="unbind-meta-owner-button" type="button" hidden>解除 L1 綁定</button>
            <button class="button button-primary" type="submit">儲存用戶</button>
          </div>
        </form>
      </section>

      ${instagramPrivatePermissions()}

      <details class="card groups-card">
        <summary><span><span class="eyebrow">WhatsApp</span><strong>群組設定</strong></span><span class="summary-hint">檢視及調整群組級別</span></summary>
        <div class="groups-content"><p class="supporting-text">群組級別只適用於橋接規則；直接提及要求由目前設定決定。</p><div id="groups-list"></div><p class="empty-state" id="groups-empty" hidden>目前未有可設定群組。</p></div>
      </details>
    </main>
    <footer><form method="post" action="/admin/logout"><input id="logout-csrf" type="hidden" name="csrf" value="${safeCsrf}"><button class="button button-quiet" type="submit">登出管理介面</button></form></footer>
  </div>
</body>
</html>`
}

export function renderMetaCallbackPage({ platform } = {}) {
  const safePlatform = platform === 'facebook' ? 'facebook' : 'instagram'
  const platformName = safePlatform === 'facebook' ? 'Facebook' : 'Instagram'
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${platformName} 授權</title>
  <link rel="stylesheet" href="/admin/assets/console.css">
  <script defer src="/admin/assets/meta-callback.js"></script>
</head>
<body class="login-page">
  <main class="login-shell" data-meta-callback-platform="${safePlatform}">
    <section class="card login-card" aria-labelledby="callback-title">
      <span class="brand-mark brand-mark-large" aria-hidden="true">●</span>
      <p class="eyebrow">${platformName}</p>
      <h1 id="callback-title">正在完成授權</h1>
      <p id="callback-message" role="status" aria-live="polite">請稍候，正在確認帳戶。</p>
      <a class="button button-primary button-block callback-return" id="callback-return" href="/admin" hidden>返回通訊控制台</a>
    </section>
  </main>
</body>
</html>`
}

export function renderConsoleLogin({ csrf = '', preview = false } = {}) {
  const safeCsrf = escapeHtml(csrf)
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登入通訊控制台</title>
  <link rel="stylesheet" href="/admin/assets/console.css">
</head>
<body class="login-page">
  <main class="login-shell">
    ${previewBanner(preview)}
    <section class="card login-card" aria-labelledby="login-title">
      <span class="brand-mark brand-mark-large" aria-hidden="true">●</span>
      <p class="eyebrow">管理介面</p>
      <h1 id="login-title">通訊控制台</h1>
      <p>使用管理員密碼登入，管理橋接帳戶及權限。</p>
      <form method="post" action="/admin/login">
        <input type="hidden" name="csrf" value="${safeCsrf}">
        <label><span>管理員密碼</span><input name="admin_token" type="password" required autocomplete="current-password"></label>
        <button class="button button-primary button-block" type="submit">登入</button>
      </form>
    </section>
  </main>
</body>
</html>`
}

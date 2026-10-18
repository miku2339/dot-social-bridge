(() => {
  'use strict'

  const root = document.querySelector('[data-meta-callback-platform]')
  const title = document.querySelector('#callback-title')
  const message = document.querySelector('#callback-message')
  const returnLink = document.querySelector('#callback-return')
  const platform = root?.dataset.metaCallbackPlatform
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const oauthState = params.get('state')
  const providerError = params.get('error')
  window.history.replaceState({}, document.title, window.location.pathname)

  function finish(heading, text, success = false) {
    title.textContent = heading
    message.textContent = text
    returnLink.hidden = false
    returnLink.className = success
      ? 'button button-primary button-block callback-return'
      : 'button button-secondary button-block callback-return'
  }

  async function readJson(response) {
    try { return await response.json() } catch { return {} }
  }

  async function completeAuthorization() {
    if (!['instagram', 'facebook'].includes(platform)) {
      finish('授權頁面無效', '請返回控制台重新開始授權。')
      return
    }
    if (providerError || !code || code.length > 4096 || !oauthState || oauthState.length > 512) {
      finish('授權未完成', '授權已取消或未完成，請返回控制台重新嘗試。')
      return
    }

    let initialResponse
    try {
      initialResponse = await fetch('/admin/api/meta', { credentials: 'same-origin' })
    } catch {
      finish('暫時無法連接', '請返回控制台稍後再試。')
      return
    }
    const initial = await readJson(initialResponse)
    if (initialResponse.status === 401) {
      finish('需要重新登入', '管理員登入已過期。重新登入後，請再次開始授權。')
      return
    }
    if (!initialResponse.ok || typeof initial.csrf !== 'string' || !initial.csrf) {
      finish('無法確認授權', '請返回控制台重新開始授權。')
      return
    }

    let response
    try {
      response = await fetch('/admin/api/meta', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'complete-oauth', platform, code, state: oauthState, csrf: initial.csrf })
      })
    } catch {
      finish('暫時無法連接', '請返回控制台稍後再試。')
      return
    }
    await readJson(response)
    if (response.status === 401) {
      finish('需要重新登入', '管理員登入已過期。重新登入後，請再次開始授權。')
      return
    }
    if (!response.ok) {
      finish('授權未能完成', '授權資料可能已過期或已使用，請返回控制台重新開始。')
      return
    }
    finish(
      '授權完成',
      platform === 'facebook' ? '請返回控制台選擇要連接的 Facebook 專頁。' : 'Instagram 專業帳戶已連接。',
      true
    )
  }

  completeAuthorization()
})()

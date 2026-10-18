(() => {
  'use strict'

  const LEVELS = ['L2', 'L3', 'L4', 'L5']
  const META_PLATFORMS = ['instagram', 'facebook']
  const PLATFORM_LABELS = { whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook' }
  const elements = {
    addUser: document.querySelector('#add-user-button'),
    cancelUser: document.querySelector('#cancel-user-button'),
    cancelUserSecondary: document.querySelector('#cancel-user-secondary'),
    form: document.querySelector('#user-form'),
    formTitle: document.querySelector('#user-form-title'),
    groupsEmpty: document.querySelector('#groups-empty'),
    groupsList: document.querySelector('#groups-list'),
    logoutCsrf: document.querySelector('#logout-csrf'),
    metaForm: document.querySelector('#meta-user-form'),
    metaCancel: document.querySelector('#cancel-meta-user-button'),
    metaCancelSecondary: document.querySelector('#cancel-meta-user-secondary'),
    metaDelete: document.querySelector('#delete-meta-user-button'),
    metaBind: document.querySelector('#bind-meta-owner-button'),
    metaUnbind: document.querySelector('#unbind-meta-owner-button'),
    metaOwnerField: document.querySelector('#meta-owner-field'),
    metaOwnerNote: document.querySelector('#meta-owner-level-note'),
    notice: document.querySelector('#console-notice'),
    policyStatus: document.querySelector('#policy-status'),
    policySummary: document.querySelector('#policy-summary'),
    qrDetails: document.querySelector('#qr-details'),
    qrImage: document.querySelector('#qr-image'),
    refresh: document.querySelector('#refresh-button'),
    replyEntryState: document.querySelector('#reply-entry-state'),
    replyToggle: document.querySelector('#reply-toggle'),
    usersBody: document.querySelector('#users-body'),
    usersEmpty: document.querySelector('#users-empty'),
    whatsappAccountId: document.querySelector('#whatsapp-account-id'),
    whatsappAccountName: document.querySelector('#whatsapp-account-name'),
    whatsappGroupStatus: document.querySelector('#whatsapp-group-status'),
    whatsappStatus: document.querySelector('#whatsapp-status')
  }

  let state = null
  let metaState = emptyMetaState()
  let editingUserId = null
  let editingMetaUser = null
  let confirmingDeleteUserId = null
  let confirmingMetaDeleteKey = null
  let restoreDeleteFocusUserId = null
  let busy = false

  function emptyMetaState() {
    return { revision: 0, config: {}, users: [], conversations: [], ownerIds: [], channels: {} }
  }

  function setText(element, value, fallback = '—') {
    if (element) element.textContent = value === undefined || value === null || value === '' ? fallback : String(value)
  }

  function setBadge(element, text, tone = 'neutral') {
    if (!element) return
    element.textContent = text
    element.className = `status-badge status-${tone}`
  }

  function showNotice(message, tone = 'error', authRequired = false) {
    elements.notice.replaceChildren()
    elements.notice.className = `notice notice-${tone}`
    const text = document.createElement('span')
    text.textContent = message
    elements.notice.append(text)
    if (authRequired) {
      const link = document.createElement('a')
      link.href = '/admin'
      link.textContent = '重新登入'
      elements.notice.append(' ', link)
    }
    elements.notice.hidden = false
  }

  function clearNotice() {
    elements.notice.hidden = true
    elements.notice.replaceChildren()
  }

  function updateCsrf(csrf) {
    if (typeof csrf !== 'string' || !csrf) return
    const meta = document.querySelector('meta[name="admin-csrf"]')
    const changed = meta?.content !== csrf
    if (meta) meta.content = csrf
    if (elements.logoutCsrf) elements.logoutCsrf.value = csrf
    if (state) state.csrf = csrf
    if (changed) window.dispatchEvent(new CustomEvent('console:csrf', { detail: { csrf } }))
  }

  async function apiRequest(url, options = {}) {
    let response
    try {
      response = await fetch(url, {
        credentials: 'same-origin',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        ...options
      })
    } catch {
      throw new Error('無法連接管理 API，請稍後再試。')
    }
    let data = {}
    try { data = await response.json() } catch { data = {} }
    updateCsrf(data.csrf)
    if (!response.ok) {
      const error = new Error(data.message || data.error || '操作失敗，請重試。')
      error.status = response.status
      error.authRequired = response.status === 401
      throw error
    }
    return data
  }

  function normalizeMeta(source) {
    const nested = source?.meta && typeof source.meta === 'object' ? source.meta : null
    return {
      revision: Number.isSafeInteger(nested?.revision) ? nested.revision : (Number.isSafeInteger(source?.metaRevision) ? source.metaRevision : 0),
      config: nested?.config || source?.metaConfig || {},
      users: Array.isArray(nested?.users) ? nested.users : (Array.isArray(source?.metaUsers) ? source.metaUsers : []),
      conversations: Array.isArray(nested?.conversations) ? nested.conversations : (Array.isArray(source?.metaConversations) ? source.metaConversations : []),
      ownerIds: Array.isArray(nested?.ownerIds) ? nested.ownerIds : (Array.isArray(source?.ownerIds) ? source.ownerIds : []),
      channels: source?.channels || {}
    }
  }

  function applyMetaSnapshot(snapshot) {
    metaState = normalizeMeta(snapshot)
    if (state) {
      state.meta = {
        revision: metaState.revision,
        config: metaState.config,
        users: metaState.users,
        conversations: metaState.conversations,
        ownerIds: metaState.ownerIds
      }
      state.channels = { ...(state.channels || {}), ...metaState.channels }
      if (typeof snapshot.csrf === 'string') state.csrf = snapshot.csrf
    }
    updateCsrf(snapshot.csrf)
  }

  function setBusy(value) {
    busy = value
    elements.refresh.disabled = value
    elements.addUser.disabled = value
    document.querySelectorAll('button, select').forEach((element) => {
      if (!element.closest('form[action="/admin/logout"]')) element.disabled = value
    })
    if (!value) {
      if (elements.metaForm?.elements.level) elements.metaForm.elements.level.disabled = Boolean(editingMetaUser?.actorIsOwner)
      renderState()
    }
    window.dispatchEvent(new CustomEvent('console:busy', { detail: { busy: value } }))
  }

  function whatsappStatus(status, paired) {
    if (status === 'connected') return ['已連線', 'success']
    if (!paired || status === 'pairing_required') return ['等待配對', 'warning']
    if (status === 'connecting') return ['連線中', 'warning']
    if (status === 'disconnected') return ['已中斷', 'danger']
    return ['狀態未知', 'neutral']
  }

  function metaStatus(status) {
    const presentations = {
      not_configured: ['未設定', 'neutral', '請先設定應用程式資料。'],
      ready_to_authorize: ['待授權', 'warning', '應用程式已設定，可以開始授權。'],
      select_account: ['待選專頁', 'warning', '請選擇要連接的 Facebook 專頁。'],
      connected: ['已連接', 'success', '帳戶已連接。'],
      expired: ['授權已過期', 'danger', '請重新授權此帳戶。'],
      error: ['需要處理', 'danger', '連線發生錯誤，請檢查設定或重新授權。']
    }
    return presentations[status] || ['狀態未知', 'neutral', '暫時未能確認連線狀態。']
  }

  function expiryNote(channel) {
    if (channel?.tokenExpiresAt === undefined || channel.tokenExpiresAt === null) return ''
    const parsed = typeof channel.tokenExpiresAt === 'number' ? channel.tokenExpiresAt : Date.parse(channel.tokenExpiresAt)
    if (!Number.isFinite(parsed) || parsed <= 0) return ''
    const date = new Date(parsed)
    if (Number.isNaN(date.getTime())) return ''
    return `授權有效至 ${date.toLocaleString('zh-Hant-HK')}`
  }

  function identityLabel(identityState) {
    const labels = { owner_configured: '擁有人已設定', verified: '已驗證', configured: '已設定', pending: '待驗證', invalid: '無效', unverified: '未驗證' }
    return labels[identityState] || '未驗證'
  }

  function identityTone(identityState) {
    if (['owner_configured', 'verified', 'configured'].includes(identityState)) return 'success'
    if (identityState === 'invalid') return 'danger'
    return 'warning'
  }

  function makeCell(row, text, className) {
    const cell = document.createElement('td')
    if (className) cell.className = className
    if (text !== '') setText(cell, text)
    row.append(cell)
    return cell
  }

  function configured(config) {
    return Boolean(config?.appId && config?.hasAppSecret && config?.hasVerifyToken)
  }

  function renderMetaChannel(platform) {
    const card = document.querySelector(`[data-meta-platform="${platform}"]`)
    if (!card) return
    const channel = state?.channels?.[platform] || metaState.channels[platform] || {}
    const config = metaState.config[platform] || {}
    const status = channel.status || 'not_configured'
    const [statusText, statusTone, statusNote] = metaStatus(status)
    setBadge(card.querySelector('[data-meta-status]'), statusText, statusTone)
    setText(card.querySelector('[data-meta-account-name]'), channel.account?.name || channel.account?.username)
    setText(card.querySelector('[data-meta-account-id]'), channel.account?.id)
    setText(card.querySelector('[data-meta-reply-state]'), status === 'connected' ? (channel.autoReplyEnabled ? '開放' : '暫停') : '未連接')
    const expiry = expiryNote(channel)
    setText(card.querySelector('[data-meta-status-note]'), expiry ? `${statusNote} ${expiry}` : statusNote)

    const form = card.querySelector('[data-meta-config-form]')
    if (form.hidden) {
      form.elements.appId.value = config.appId || ''
      form.elements.appSecret.value = ''
      form.elements.verifyToken.value = ''
      form.elements.callbackUrl.value = config.callbackUrl || ''
      form.elements.webhookUrl.value = config.webhookUrl || ''
    }
    setText(form.querySelector('[data-meta-secret-state]'), config.hasAppSecret ? '已設定；留空會保留' : '尚未設定')
    setText(form.querySelector('[data-meta-token-state]'), config.hasVerifyToken ? '已設定；留空會保留' : '尚未設定')

    const connect = card.querySelector('[data-meta-connect]')
    connect.hidden = status === 'connected' || status === 'select_account'
    connect.disabled = busy || !configured(config)
    connect.textContent = `${status === 'expired' || status === 'error' ? '重新' : ''}連接${PLATFORM_LABELS[platform]}授權`
    const replies = card.querySelector('[data-meta-replies]')
    replies.hidden = status !== 'connected'
    replies.disabled = busy || status !== 'connected'
    replies.textContent = channel.autoReplyEnabled ? '暫停' : '開放'
    const disconnect = card.querySelector('[data-meta-disconnect]')
    disconnect.hidden = !['connected', 'expired', 'select_account'].includes(status)
    disconnect.disabled = busy

    const assetForm = card.querySelector('[data-meta-asset-form]')
    assetForm.hidden = platform !== 'facebook' || status !== 'select_account'
    const select = assetForm.elements.accountId
    const previous = select.value
    select.replaceChildren()
    for (const asset of Array.isArray(channel.assets) ? channel.assets : []) {
      const option = document.createElement('option')
      option.value = asset.id
      option.textContent = `${asset.name || '未命名專頁'}（${asset.id}）`
      select.append(option)
    }
    if ([...select.options].some((option) => option.value === previous)) select.value = previous
    assetForm.querySelector('button').disabled = busy || select.options.length === 0
  }

  function renderChannels() {
    const whatsapp = state?.channels?.whatsapp || {}
    const [statusText, statusTone] = whatsappStatus(whatsapp.status, whatsapp.paired)
    setBadge(elements.whatsappStatus, statusText, statusTone)
    setText(elements.whatsappAccountName, whatsapp.account?.name)
    setText(elements.whatsappAccountId, whatsapp.account?.id)
    setText(elements.whatsappGroupStatus, whatsapp.ownerGroupsAllowed ? '已開放擁有人群組' : '暫停群組回覆')
    setText(elements.replyEntryState, whatsapp.autoReplyEnabled ? '開放' : '暫停')
    elements.replyToggle.textContent = whatsapp.autoReplyEnabled ? '暫停' : '開放'
    elements.replyToggle.disabled = busy || !state
    const qr = state?.qrDataUrl || whatsapp.qrDataUrl
    const safeQr = typeof qr === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(qr)
    elements.qrDetails.hidden = !safeQr
    if (safeQr) elements.qrImage.src = qr
    else elements.qrImage.removeAttribute('src')
    META_PLATFORMS.forEach(renderMetaChannel)
  }

  function renderPolicy() {
    const permissions = state?.permissions || {}
    const valid = permissions.valid === true
    setBadge(elements.policyStatus, valid ? '規則有效' : '規則無效', valid ? 'success' : 'danger')
    const defaultLevel = permissions.defaultLevel || 'L5'
    const mode = permissions.mode === 'rules_only' ? '規則層控制' : String(permissions.mode || '未知模式')
    setText(elements.policySummary, `${mode}・預設 ${defaultLevel}・L1 僅限已驗證擁有人；此名單只控制橋接權限`)
  }

  function appendPlatformLabel(cell, platform) {
    const label = document.createElement('span')
    label.className = `platform-label platform-${platform}`
    label.textContent = PLATFORM_LABELS[platform] || platform
    cell.prepend(label)
  }

  function appendWhatsappUser(user) {
    const row = document.createElement('tr')
    const nameCell = makeCell(row, '')
    const name = document.createElement('span')
    name.className = 'user-name'
    setText(name, user.isOwner && user.displayName === user.id ? '擁有人' : user.displayName, user.isOwner ? '擁有人' : '未命名用戶')
    nameCell.append(name)
    appendPlatformLabel(nameCell, 'whatsapp')
    if (user.isOwner) {
      const ownerLabel = document.createElement('span')
      ownerLabel.className = 'sub-label'
      ownerLabel.textContent = '擁有人（L1）'
      nameCell.append(ownerLabel)
    } else if (user.instagramUsername) {
      const note = document.createElement('span')
      note.className = 'sub-label'
      note.textContent = `Instagram 備註：${user.instagramUsername}`
      nameCell.append(note)
    }
    makeCell(row, user.whatsappId || user.id, 'mono')
    const levelCell = makeCell(row, '')
    const level = document.createElement('span')
    level.className = 'level-badge'
    level.textContent = user.isOwner ? 'L1' : (LEVELS.includes(user.level) ? user.level : 'L5')
    levelCell.append(level)
    const identityCell = makeCell(row, '')
    const identity = document.createElement('span')
    setBadge(identity, identityLabel(user.identityState), identityTone(user.identityState))
    identityCell.append(identity)
    const actions = makeCell(row, '', 'actions-column')
    if (user.isOwner) {
      const locked = document.createElement('span')
      locked.className = 'sub-label'
      locked.textContent = '由可信身份管理'
      actions.append(locked)
    } else {
      const wrap = document.createElement('div')
      wrap.className = 'row-actions'
      if (confirmingDeleteUserId === user.id) {
        const confirm = actionButton('確認刪除', 'button button-danger button-small', () => deleteWhatsappUser(user))
        const cancel = actionButton('取消', 'button button-secondary button-small', () => cancelDeleteUser(user.id))
        wrap.append(confirm, cancel)
        requestAnimationFrame(() => confirm.focus())
      } else {
        const edit = actionButton('編輯', 'button button-secondary button-small', () => openUserForm(user))
        const remove = actionButton('刪除', 'button button-danger button-small', () => beginDeleteUser(user.id))
        wrap.append(edit, remove)
        if (restoreDeleteFocusUserId === user.id) {
          restoreDeleteFocusUserId = null
          requestAnimationFrame(() => remove.focus())
        }
      }
      actions.append(wrap)
    }
    elements.usersBody.append(row)
  }

  function metaUserKey(user) {
    return `${user.platform}:${user.accountId}:${user.senderId}`
  }

  function combinedMetaUsers() {
    const users = new Map()
    for (const user of metaState.users) users.set(metaUserKey(user), { ...user, observedOnly: false })
    for (const conversation of metaState.conversations) {
      const key = metaUserKey(conversation)
      if (!users.has(key) && META_PLATFORMS.includes(conversation.platform) && conversation.accountId && conversation.senderId) {
        users.set(key, {
          platform: conversation.platform,
          accountId: conversation.accountId,
          senderId: conversation.senderId,
          displayName: conversation.displayName || conversation.senderId,
          level: 'L5',
          ownerId: null,
          actorIsOwner: false,
          observedOnly: true
        })
      }
    }
    return [...users.values()]
  }

  function appendMetaUser(user) {
    const row = document.createElement('tr')
    const key = metaUserKey(user)
    const nameCell = makeCell(row, '')
    const name = document.createElement('span')
    name.className = 'user-name'
    setText(name, user.displayName, '未命名用戶')
    nameCell.append(name)
    appendPlatformLabel(nameCell, user.platform)
    if (user.observedOnly) {
      const note = document.createElement('span')
      note.className = 'sub-label'
      note.textContent = '已觀察，尚未儲存權限'
      nameCell.append(note)
    }
    const scope = makeCell(row, '', 'mono')
    const account = document.createElement('span')
    account.textContent = `帳戶 ${user.accountId}`
    const sender = document.createElement('span')
    sender.className = 'sub-label mono'
    sender.textContent = `發送者 ${user.senderId}`
    scope.append(account, sender)
    const levelCell = makeCell(row, '')
    const level = document.createElement('span')
    level.className = 'level-badge'
    level.textContent = user.actorIsOwner ? 'L1' : (LEVELS.includes(user.level) ? user.level : 'L5')
    levelCell.append(level)
    const bindingCell = makeCell(row, '')
    const binding = document.createElement('span')
    setBadge(binding, user.actorIsOwner ? '已綁定擁有人' : (user.observedOnly ? '待設定' : '已設定'), user.actorIsOwner ? 'success' : 'warning')
    bindingCell.append(binding)
    const actions = makeCell(row, '', 'actions-column')
    const wrap = document.createElement('div')
    wrap.className = 'row-actions'
    if (confirmingMetaDeleteKey === key) {
      const confirm = actionButton('確認刪除', 'button button-danger button-small', () => deleteMetaUser(user))
      const cancel = actionButton('取消', 'button button-secondary button-small', () => { confirmingMetaDeleteKey = null; renderUsers() })
      wrap.append(confirm, cancel)
    } else {
      wrap.append(actionButton('編輯', 'button button-secondary button-small', () => openMetaUserForm(user)))
      if (!user.actorIsOwner && !user.observedOnly) wrap.append(actionButton('刪除', 'button button-danger button-small', () => { confirmingMetaDeleteKey = key; renderUsers() }))
    }
    actions.append(wrap)
    elements.usersBody.append(row)
  }

  function actionButton(text, className, listener) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    button.disabled = busy
    button.addEventListener('click', listener)
    return button
  }

  function renderUsers() {
    const whatsappUsers = Array.isArray(state?.users) ? state.users : []
    const metaUsers = combinedMetaUsers()
    elements.usersBody.replaceChildren()
    for (const user of whatsappUsers) appendWhatsappUser(user)
    for (const user of metaUsers) appendMetaUser(user)
    elements.usersEmpty.hidden = whatsappUsers.length + metaUsers.length > 0
  }

  function renderGroups() {
    const groups = Array.isArray(state?.groups) ? state.groups : []
    elements.groupsList.replaceChildren()
    elements.groupsEmpty.hidden = groups.length > 0
    for (const group of groups) {
      const form = document.createElement('form')
      form.className = 'group-row'
      const identity = document.createElement('div')
      identity.className = 'group-identity'
      const name = document.createElement('strong')
      setText(name, group.name, '未命名群組')
      const id = document.createElement('span')
      id.className = 'mono'
      setText(id, group.id)
      identity.append(name, id)
      if (group.mentionOnly) {
        const mention = document.createElement('span')
        mention.className = 'mention-chip'
        mention.textContent = '只回覆直接提及'
        identity.append(mention)
      }
      const label = document.createElement('label')
      const labelText = document.createElement('span')
      labelText.textContent = '群組級別'
      const select = document.createElement('select')
      select.name = 'level'
      select.setAttribute('aria-label', `${group.name || '群組'}權限級別`)
      for (const item of LEVELS) {
        const option = document.createElement('option')
        option.value = item
        option.textContent = item
        option.selected = item === (LEVELS.includes(group.level) ? group.level : 'L5')
        select.append(option)
      }
      label.append(labelText, select)
      const save = actionButton('儲存', 'button button-secondary button-small', () => {})
      save.type = 'submit'
      form.append(identity, label, save)
      form.addEventListener('submit', (event) => saveGroup(event, group.id))
      elements.groupsList.append(form)
    }
  }

  function renderState() {
    if (!state) return
    renderChannels()
    renderPolicy()
    renderUsers()
    renderGroups()
  }

  function openUserForm(user = null) {
    closeMetaUserForm()
    editingUserId = user?.id || null
    elements.form.reset()
    elements.formTitle.textContent = user ? '編輯用戶' : '新增用戶'
    elements.form.elements.displayName.value = user?.displayName || ''
    elements.form.elements.whatsappId.value = user?.whatsappId || user?.id || ''
    elements.form.elements.whatsappId.readOnly = Boolean(user)
    elements.form.elements.instagramUsername.value = user?.instagramUsername || ''
    elements.form.elements.level.value = LEVELS.includes(user?.level) ? user.level : 'L5'
    elements.form.hidden = false
    elements.form.elements.displayName.focus()
    elements.form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function closeUserForm() {
    editingUserId = null
    elements.form.reset()
    elements.form.hidden = true
  }

  function openMetaUserForm(user) {
    closeUserForm()
    editingMetaUser = user
    const form = elements.metaForm
    form.reset()
    form.elements.platformLabel.value = PLATFORM_LABELS[user.platform] || user.platform
    form.elements.accountId.value = user.accountId
    form.elements.senderId.value = user.senderId
    form.elements.displayName.value = user.displayName || ''
    form.elements.level.value = LEVELS.includes(user.level) ? user.level : 'L5'
    form.elements.level.disabled = Boolean(user.actorIsOwner)
    elements.metaOwnerNote.hidden = !user.actorIsOwner
    const ownerSelect = form.elements.ownerId
    ownerSelect.replaceChildren()
    for (const ownerId of metaState.ownerIds) {
      const option = document.createElement('option')
      option.value = ownerId
      option.textContent = ownerId
      ownerSelect.append(option)
    }
    const canBind = !user.actorIsOwner && metaState.ownerIds.length > 0
    elements.metaOwnerField.hidden = !canBind
    elements.metaBind.hidden = !canBind
    elements.metaUnbind.hidden = !user.actorIsOwner
    elements.metaDelete.hidden = user.actorIsOwner || user.observedOnly
    form.hidden = false
    form.elements.displayName.focus()
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function closeMetaUserForm() {
    editingMetaUser = null
    elements.metaForm.reset()
    elements.metaForm.hidden = true
  }

  function whatsappMutationBody(action, payload = {}) {
    return JSON.stringify({ csrf: state.csrf, revision: state.revision, action, ...payload })
  }

  async function mutateWhatsapp(action, payload) {
    const nextState = await apiRequest('/admin/api/console', { method: 'POST', body: whatsappMutationBody(action, payload) })
    state = nextState
    applyMetaSnapshot(nextState)
    renderState()
    return nextState
  }

  async function refreshMeta() {
    const snapshot = await apiRequest('/admin/api/meta')
    applyMetaSnapshot(snapshot)
    renderState()
    return snapshot
  }

  async function mutateMeta(action, platform, payload = {}) {
    const body = { csrf: state.csrf, action, platform, ...payload }
    if (action !== 'begin-oauth' && action !== 'complete-oauth') body.revision = metaState.revision
    try {
      const snapshot = await apiRequest('/admin/api/meta', { method: 'POST', body: JSON.stringify(body) })
      if (action === 'begin-oauth') return snapshot
      applyMetaSnapshot(snapshot)
      renderState()
      return snapshot
    } catch (error) {
      if (error.status === 409) {
        try { await refreshMeta() } catch {}
        error.message = '設定已由另一個操作更新；已重新整理，請再試一次。'
      }
      throw error
    }
  }

  async function refreshState({ announce = false } = {}) {
    if (busy) return
    clearNotice()
    setBusy(true)
    try {
      state = await apiRequest('/admin/api/console')
      applyMetaSnapshot(state)
      renderState()
      if (announce) showNotice('資料已重新整理。', 'success')
    } catch (error) {
      showNotice(error.message, 'error', error.authRequired === true)
    } finally {
      setBusy(false)
    }
  }

  async function runMutation(operation, successMessage) {
    if (busy || !state) return
    clearNotice()
    setBusy(true)
    try {
      await operation()
      if (successMessage) showNotice(successMessage, 'success')
    } catch (error) {
      showNotice(error.message, 'error', error.authRequired === true)
    } finally {
      setBusy(false)
    }
  }

  async function submitWhatsappUser(event) {
    event.preventDefault()
    const data = new FormData(elements.form)
    const level = String(data.get('level') || 'L5')
    if (!LEVELS.includes(level)) return showNotice('非擁有人權限只可選擇 L2–L5。')
    const user = {
      displayName: String(data.get('displayName') || '').trim(),
      whatsappId: String(data.get('whatsappId') || '').trim(),
      instagramUsername: String(data.get('instagramUsername') || '').trim(),
      level
    }
    if (editingUserId) user.id = editingUserId
    await runMutation(async () => {
      await mutateWhatsapp('save-user', { user })
      closeUserForm()
    }, '用戶權限已儲存。')
  }

  async function deleteWhatsappUser(user) {
    if (user.isOwner) return
    await runMutation(async () => {
      await mutateWhatsapp('delete-user', { userId: user.id })
      confirmingDeleteUserId = null
      if (editingUserId === user.id) closeUserForm()
    }, '用戶權限已刪除。')
  }

  function beginDeleteUser(userId) {
    if (busy) return
    confirmingDeleteUserId = userId
    renderUsers()
  }

  function cancelDeleteUser(userId) {
    if (busy) return
    confirmingDeleteUserId = null
    restoreDeleteFocusUserId = userId
    renderUsers()
  }

  async function toggleWhatsappReplies() {
    const enabled = !Boolean(state?.channels?.whatsapp?.autoReplyEnabled)
    await runMutation(() => mutateWhatsapp('set-replies', { enabled }), `橋接回覆入口已${enabled ? '開放' : '暫停'}。`)
  }

  async function saveGroup(event, chatId) {
    event.preventDefault()
    const level = String(new FormData(event.currentTarget).get('level') || 'L5')
    if (!LEVELS.includes(level)) return showNotice('群組級別只可選擇 L2–L5。')
    await runMutation(() => mutateWhatsapp('save-group', { chatId, level }), '群組級別已儲存。')
  }

  async function saveMetaConfig(event, platform) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    await runMutation(async () => {
      await mutateMeta('save-config', platform, {
        appId: String(data.get('appId') || '').trim(),
        appSecret: String(data.get('appSecret') || ''),
        verifyToken: String(data.get('verifyToken') || '')
      })
      form.hidden = true
    }, '應用程式設定已儲存。')
  }

  function validAuthorizationUrl(value, platform) {
    let url
    try { url = new URL(value) } catch { return null }
    const allowed = platform === 'instagram'
      ? url.origin === 'https://www.instagram.com' && url.pathname === '/oauth/authorize'
      : url.origin === 'https://www.facebook.com' && url.pathname === '/v26.0/dialog/oauth'
    if (url.username || url.password || url.hash) return null
    return allowed ? url.toString() : null
  }

  async function beginOAuth(platform) {
    await runMutation(async () => {
      const result = await mutateMeta('begin-oauth', platform)
      const authorizationUrl = validAuthorizationUrl(result.authorizationUrl, platform)
      if (!authorizationUrl) throw new Error('授權網址無效，未有離開控制台。')
      window.location.assign(authorizationUrl)
    })
  }

  async function toggleMetaReplies(platform) {
    const channel = state?.channels?.[platform] || {}
    if (channel.status !== 'connected') return
    const enabled = !Boolean(channel.autoReplyEnabled)
    await runMutation(() => mutateMeta('set-replies', platform, { enabled }), `${PLATFORM_LABELS[platform]} 自動回覆已${enabled ? '開放' : '暫停'}。`)
  }

  async function disconnectMeta(platform) {
    await runMutation(async () => {
      await mutateMeta('disconnect', platform)
      const card = document.querySelector(`[data-meta-platform="${platform}"]`)
      card.querySelector('[data-meta-disconnect-confirm]').hidden = true
    }, `${PLATFORM_LABELS[platform]} 已中斷連接。`)
  }

  async function selectMetaAsset(event, platform) {
    event.preventDefault()
    const accountId = String(new FormData(event.currentTarget).get('accountId') || '')
    if (!accountId) return
    await runMutation(() => mutateMeta('select-account', platform, { accountId }), 'Facebook 專頁已連接。')
  }

  async function submitMetaUser(event) {
    event.preventDefault()
    if (!editingMetaUser) return
    const data = new FormData(elements.metaForm)
    const level = editingMetaUser.actorIsOwner ? (LEVELS.includes(editingMetaUser.level) ? editingMetaUser.level : 'L5') : String(data.get('level') || 'L5')
    if (!LEVELS.includes(level)) return showNotice('非擁有人權限只可選擇 L2–L5。')
    const payload = {
      accountId: editingMetaUser.accountId,
      senderId: editingMetaUser.senderId,
      displayName: String(data.get('displayName') || '').trim(),
      level
    }
    await runMutation(async () => {
      await mutateMeta('save-user', editingMetaUser.platform, payload)
      closeMetaUserForm()
    }, 'Meta 用戶權限已儲存。')
  }

  async function bindMetaOwner() {
    if (!editingMetaUser || editingMetaUser.actorIsOwner) return
    const ownerId = String(elements.metaForm.elements.ownerId.value || '')
    if (!ownerId) return showNotice('請先選擇擁有人。')
    await runMutation(async () => {
      await mutateMeta('bind-owner', editingMetaUser.platform, { accountId: editingMetaUser.accountId, senderId: editingMetaUser.senderId, ownerId })
      closeMetaUserForm()
    }, '已明確綁定為 L1 擁有人。')
  }

  async function unbindMetaOwner() {
    if (!editingMetaUser?.actorIsOwner) return
    await runMutation(async () => {
      await mutateMeta('unbind-owner', editingMetaUser.platform, { accountId: editingMetaUser.accountId, senderId: editingMetaUser.senderId })
      closeMetaUserForm()
    }, '已解除 L1 擁有人綁定。')
  }

  async function deleteMetaUser(user = editingMetaUser) {
    if (!user || user.actorIsOwner || user.observedOnly) return
    await runMutation(async () => {
      await mutateMeta('delete-user', user.platform, { accountId: user.accountId, senderId: user.senderId })
      confirmingMetaDeleteKey = null
      closeMetaUserForm()
    }, 'Meta 用戶權限已刪除。')
  }

  async function copyField(form, fieldName, button) {
    const value = String(form.elements[fieldName]?.value || '')
    if (!value) return showNotice('此網址尚未可用。')
    try {
      await navigator.clipboard.writeText(value)
      const previous = button.textContent
      button.textContent = '已複製'
      window.setTimeout(() => { button.textContent = previous }, 1500)
    } catch {
      showNotice('無法自動複製，請手動選取網址。')
      form.elements[fieldName].focus()
      form.elements[fieldName].select()
    }
  }

  function bindMetaCards() {
    for (const platform of META_PLATFORMS) {
      const card = document.querySelector(`[data-meta-platform="${platform}"]`)
      const form = card.querySelector('[data-meta-config-form]')
      card.querySelector('[data-meta-config-toggle]').addEventListener('click', () => {
        form.hidden = !form.hidden
        if (!form.hidden) form.elements.appId.focus()
      })
      card.querySelector('[data-meta-config-cancel]').addEventListener('click', () => { form.hidden = true; renderMetaChannel(platform) })
      form.addEventListener('submit', (event) => saveMetaConfig(event, platform))
      form.querySelectorAll('[data-copy-field]').forEach((button) => button.addEventListener('click', () => copyField(form, button.dataset.copyField, button)))
      card.querySelector('[data-meta-connect]').addEventListener('click', () => beginOAuth(platform))
      card.querySelector('[data-meta-replies]').addEventListener('click', () => toggleMetaReplies(platform))
      const confirm = card.querySelector('[data-meta-disconnect-confirm]')
      card.querySelector('[data-meta-disconnect]').addEventListener('click', () => { confirm.hidden = false; confirm.querySelector('[data-meta-disconnect-yes]').focus() })
      card.querySelector('[data-meta-disconnect-no]').addEventListener('click', () => { confirm.hidden = true; card.querySelector('[data-meta-disconnect]').focus() })
      card.querySelector('[data-meta-disconnect-yes]').addEventListener('click', () => disconnectMeta(platform))
      card.querySelector('[data-meta-asset-form]').addEventListener('submit', (event) => selectMetaAsset(event, platform))
    }
  }

  window.consoleAdmin = Object.freeze({ apiRequest, runMutation, showNotice })
  elements.refresh.addEventListener('click', () => refreshState({ announce: true }))
  elements.addUser.addEventListener('click', () => openUserForm())
  elements.cancelUser.addEventListener('click', closeUserForm)
  elements.cancelUserSecondary.addEventListener('click', closeUserForm)
  elements.form.addEventListener('submit', submitWhatsappUser)
  elements.replyToggle.addEventListener('click', toggleWhatsappReplies)
  elements.metaCancel.addEventListener('click', closeMetaUserForm)
  elements.metaCancelSecondary.addEventListener('click', closeMetaUserForm)
  elements.metaForm.addEventListener('submit', submitMetaUser)
  elements.metaBind.addEventListener('click', bindMetaOwner)
  elements.metaUnbind.addEventListener('click', unbindMetaOwner)
  elements.metaDelete.addEventListener('click', () => {
    if (!editingMetaUser) return
    confirmingMetaDeleteKey = metaUserKey(editingMetaUser)
    closeMetaUserForm()
    renderUsers()
  })
  bindMetaCards()
  window.addEventListener('console:csrf', (event) => updateCsrf(event.detail?.csrf))
  refreshState()
})()

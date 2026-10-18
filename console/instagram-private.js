(() => {
  'use strict'

  const LEVELS = ['L2', 'L3', 'L4', 'L5']
  const card = document.querySelector('[data-instagram-private-card]')
  const permissions = document.querySelector('[data-instagram-private-permissions]')
  const admin = window.consoleAdmin
  if (!card || !permissions || !admin) return

  const elements = {
    account: card.querySelector('[data-instagram-private-account]'),
    configCancel: card.querySelector('[data-instagram-private-config-cancel]'),
    configForm: card.querySelector('[data-instagram-private-config-form]'),
    configToggle: card.querySelector('[data-instagram-private-config-toggle]'),
    groups: card.querySelector('[data-instagram-private-groups]'),
    groupsEmpty: permissions.querySelector('[data-instagram-private-groups-empty]'),
    groupsList: permissions.querySelector('[data-instagram-private-groups-list]'),
    groupsToggle: card.querySelector('[data-instagram-private-groups-toggle]'),
    ownerBind: permissions.querySelector('[data-instagram-private-owner-bind]'),
    ownerField: permissions.querySelector('[data-instagram-private-owner-field]'),
    ownerNote: permissions.querySelector('[data-instagram-private-owner-note]'),
    ownerUnbind: permissions.querySelector('[data-instagram-private-owner-unbind]'),
    permissionsStatus: permissions.querySelector('[data-instagram-private-permissions-status]'),
    reconnect: card.querySelector('[data-instagram-private-reconnect]'),
    replies: card.querySelector('[data-instagram-private-replies]'),
    repliesToggle: card.querySelector('[data-instagram-private-replies-toggle]'),
    status: card.querySelector('[data-instagram-private-status]'),
    statusNote: card.querySelector('[data-instagram-private-note]'),
    userCancel: permissions.querySelector('[data-instagram-private-user-cancel]'),
    userClose: permissions.querySelector('[data-instagram-private-user-close]'),
    userDelete: permissions.querySelector('[data-instagram-private-user-delete]'),
    userForm: permissions.querySelector('[data-instagram-private-user-form]'),
    userSave: permissions.querySelector('[data-instagram-private-user-save]'),
    users: permissions.querySelector('[data-instagram-private-users]'),
    usersEmpty: permissions.querySelector('[data-instagram-private-users-empty]')
  }

  let snapshot = normalize({})
  let editingUser = null
  let confirmingDelete = null
  let hostBusy = document.querySelector('#refresh-button')?.disabled === true
  let refreshQueued = hostBusy

  function normalize(source) {
    const nested = source?.instagramPrivate && typeof source.instagramPrivate === 'object' ? source.instagramPrivate : source
    return {
      channel: source?.channel || source?.channels?.instagramPrivate || nested?.channel || {},
      revision: nested?.revision ?? 0,
      settings: nested?.settings || {},
      users: Array.isArray(nested?.users) ? nested.users : [],
      groups: Array.isArray(nested?.groups) ? nested.groups : [],
      ownerIds: Array.isArray(nested?.ownerIds) ? nested.ownerIds : [],
      csrf: typeof source?.csrf === 'string' ? source.csrf : document.querySelector('meta[name="admin-csrf"]')?.content || ''
    }
  }

  function isBusy() {
    return hostBusy
  }

  function setText(element, value, fallback = '—') {
    element.textContent = value === undefined || value === null || value === '' ? fallback : String(value)
  }

  function setBadge(element, text, tone = 'neutral') {
    element.textContent = text
    element.className = `status-badge status-${tone}`
  }

  function statusPresentation(status) {
    const presentations = {
      not_configured: ['未設定', 'neutral', '請先設定登入 helper 提供的私人帳戶 ID。'],
      connected: ['已連接', 'success', '已核對儲存的 Session 及私人帳戶身份。'],
      login_required: ['需要登入', 'warning', '請由帳戶本人在伺服器終端機完成登入。'],
      challenge_required: ['需要驗證', 'warning', '請由帳戶本人在 Instagram 完成安全驗證。'],
      rate_limited: ['暫時受限', 'danger', '請稍後再重新連接已儲存的 Session。'],
      error: ['需要處理', 'danger', '連接發生錯誤，請核對帳戶及 Session 狀態。'],
      paused: ['已暫停', 'warning', 'Session 已保留，自動回覆目前暫停。']
    }
    return presentations[status] || ['狀態未知', 'neutral', '暫時未能確認私人連接狀態。']
  }

  function actionButton(text, className, listener) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = className
    button.textContent = text
    button.disabled = isBusy()
    button.addEventListener('click', listener)
    return button
  }

  function renderChannel() {
    const channel = snapshot.channel || {}
    const status = channel.status || 'not_configured'
    const [label, tone, note] = statusPresentation(status)
    const accountId = channel.account?.id || channel.accountId || snapshot.settings.expectedAccountId
    const autoReplyEnabled = channel.autoReplyEnabled === true
    const groupRepliesEnabled = channel.groupRepliesEnabled === true
    const usable = ['connected', 'paused'].includes(status)
    setBadge(elements.status, label, tone)
    setText(elements.account, accountId)
    setText(elements.replies, usable ? (autoReplyEnabled ? '開放' : '暫停') : '未連接')
    setText(elements.groups, usable ? (groupRepliesEnabled ? (autoReplyEnabled ? '開放' : '待自動回覆開放') : '暫停') : '未連接')
    setText(elements.statusNote, note)

    const configuredAccountId = snapshot.settings.expectedAccountId || ''
    if (elements.configForm.hidden) elements.configForm.elements.expectedAccountId.value = configuredAccountId
    elements.configForm.elements.expectedAccountId.readOnly = Boolean(configuredAccountId)
    const configSubmit = elements.configForm.querySelector('button[type="submit"]')
    configSubmit.hidden = Boolean(configuredAccountId)
    configSubmit.disabled = isBusy()
    elements.configToggle.textContent = configuredAccountId ? '檢視帳戶 ID' : '設定帳戶 ID'
    elements.configToggle.disabled = isBusy()
    elements.reconnect.disabled = isBusy() || !snapshot.settings.expectedAccountId
    elements.repliesToggle.disabled = isBusy() || !usable
    elements.groupsToggle.disabled = isBusy() || !usable
    elements.repliesToggle.textContent = autoReplyEnabled ? '暫停自動回覆' : '開放自動回覆'
    elements.groupsToggle.textContent = groupRepliesEnabled ? '暫停群組回覆' : '開放群組回覆'
  }

  function openUserForm(user) {
    editingUser = user
    const form = elements.userForm
    form.reset()
    form.elements.senderId.value = user.senderId || ''
    form.elements.displayName.value = user.displayName || ''
    form.elements.displayName.readOnly = user.actorIsOwner === true
    form.elements.level.value = LEVELS.includes(user.level) ? user.level : 'L5'
    form.elements.level.disabled = user.actorIsOwner === true
    const ownerSelect = form.elements.ownerId
    ownerSelect.replaceChildren()
    for (const ownerId of snapshot.ownerIds) {
      const option = document.createElement('option')
      option.value = ownerId
      option.textContent = ownerId
      ownerSelect.append(option)
    }
    const canBind = !user.actorIsOwner && snapshot.ownerIds.length > 0
    elements.ownerField.hidden = !canBind
    elements.ownerBind.hidden = !canBind
    elements.ownerUnbind.hidden = !user.actorIsOwner
    elements.ownerNote.hidden = !user.actorIsOwner
    elements.userDelete.hidden = user.actorIsOwner || user.observedOnly
    elements.userSave.hidden = user.actorIsOwner
    form.hidden = false
    ;(user.actorIsOwner ? elements.ownerUnbind : form.elements.displayName).focus()
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  function closeUserForm() {
    editingUser = null
    elements.userForm.reset()
    elements.userForm.hidden = true
  }

  function renderUsers() {
    elements.users.replaceChildren()
    elements.usersEmpty.hidden = snapshot.users.length > 0
    for (const user of snapshot.users) {
      const row = document.createElement('tr')
      const nameCell = document.createElement('td')
      const name = document.createElement('span')
      name.className = 'user-name'
      setText(name, user.displayName, '未命名用戶')
      const platform = document.createElement('span')
      platform.className = 'platform-label platform-instagram-private'
      platform.textContent = 'Instagram 私人連接'
      nameCell.append(name, platform)
      if (user.observedOnly) {
        const observed = document.createElement('span')
        observed.className = 'sub-label'
        observed.textContent = '已觀察，尚未儲存權限'
        nameCell.append(observed)
      }
      const senderCell = document.createElement('td')
      senderCell.className = 'mono'
      setText(senderCell, user.senderId)
      const levelCell = document.createElement('td')
      const level = document.createElement('span')
      level.className = 'level-badge'
      level.textContent = user.actorIsOwner ? 'L1' : (LEVELS.includes(user.level) ? user.level : 'L5')
      levelCell.append(level)
      const bindingCell = document.createElement('td')
      const binding = document.createElement('span')
      setBadge(binding, user.actorIsOwner ? '已綁定擁有人' : (user.observedOnly ? '待設定' : '已設定'), user.actorIsOwner ? 'success' : 'warning')
      bindingCell.append(binding)
      const actions = document.createElement('td')
      actions.className = 'actions-column'
      const wrap = document.createElement('div')
      wrap.className = 'row-actions'
      if (confirmingDelete === user.senderId) {
        wrap.append(
          actionButton('確認刪除', 'button button-danger button-small', () => deleteUser(user)),
          actionButton('取消', 'button button-secondary button-small', () => { confirmingDelete = null; renderUsers() })
        )
      } else {
        wrap.append(actionButton(user.actorIsOwner ? '檢視' : '編輯', 'button button-secondary button-small', () => openUserForm(user)))
        if (!user.actorIsOwner && !user.observedOnly) wrap.append(actionButton('刪除', 'button button-danger button-small', () => { confirmingDelete = user.senderId; renderUsers() }))
      }
      actions.append(wrap)
      row.append(nameCell, senderCell, levelCell, bindingCell, actions)
      elements.users.append(row)
    }
  }

  function renderGroups() {
    elements.groupsList.replaceChildren()
    elements.groupsEmpty.hidden = snapshot.groups.length > 0
    for (const group of snapshot.groups) {
      const form = document.createElement('form')
      form.className = 'group-row'
      const identity = document.createElement('div')
      identity.className = 'group-identity'
      const name = document.createElement('strong')
      setText(name, group.name || group.displayName, '未命名群組')
      const id = document.createElement('span')
      id.className = 'mono'
      setText(id, group.chatId || group.id)
      identity.append(name, id)
      const label = document.createElement('label')
      const labelText = document.createElement('span')
      labelText.textContent = '群組級別'
      const select = document.createElement('select')
      select.name = 'level'
      select.setAttribute('aria-label', `${group.name || group.displayName || '群組'}權限級別`)
      for (const value of LEVELS) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = value
        option.selected = value === (LEVELS.includes(group.level) ? group.level : 'L5')
        select.append(option)
      }
      label.append(labelText, select)
      const save = actionButton('儲存', 'button button-secondary button-small', () => {})
      save.type = 'submit'
      form.append(identity, label, save)
      form.addEventListener('submit', (event) => saveGroup(event, group.chatId || group.id))
      elements.groupsList.append(form)
    }
  }

  function render() {
    renderChannel()
    renderUsers()
    renderGroups()
    elements.configForm.querySelectorAll('button').forEach((control) => { control.disabled = isBusy() })
    elements.userForm.querySelectorAll('button, select').forEach((control) => { control.disabled = isBusy() })
    if (!isBusy() && editingUser?.actorIsOwner) elements.userForm.elements.level.disabled = true
    setBadge(elements.permissionsStatus, `${snapshot.users.length} 位用戶・${snapshot.groups.length} 個群組`, 'neutral')
  }

  async function refresh({ announce = false } = {}) {
    if (isBusy()) { refreshQueued = true; return }
    await admin.runMutation(async () => {
      snapshot = normalize(await admin.apiRequest('/admin/api/instagram-private'))
      render()
    }, announce ? 'Instagram 私人連接資料已重新整理。' : '')
  }

  async function mutate(action, payload = {}, successMessage) {
    let saved = false
    await admin.runMutation(async () => {
      try {
        const body = { csrf: snapshot.csrf, revision: snapshot.revision, action, ...payload }
        snapshot = normalize(await admin.apiRequest('/admin/api/instagram-private', { method: 'POST', body: JSON.stringify(body) }))
        saved = true
        render()
      } catch (error) {
        if (error.status === 409) {
          try { snapshot = normalize(await admin.apiRequest('/admin/api/instagram-private')) } catch {}
          render()
          error.message = '設定已由另一個操作更新；已重新整理，請再試一次。'
        }
        throw error
      }
    }, successMessage)
    return saved
  }

  function submitConfig(event) {
    event.preventDefault()
    const expectedAccountId = String(new FormData(event.currentTarget).get('expectedAccountId') || '').trim()
    if (!/^\d{1,64}$/.test(expectedAccountId)) return admin.showNotice('請輸入登入 helper 提供的數字帳戶 ID。')
    void mutate('configure', { expectedAccountId }, '私人帳戶 ID 已儲存。').then((saved) => { if (saved) elements.configForm.hidden = true })
  }

  function submitUser(event) {
    event.preventDefault()
    if (!editingUser || editingUser.actorIsOwner) return
    const data = new FormData(event.currentTarget)
    const level = String(data.get('level') || 'L5')
    if (!LEVELS.includes(level)) return admin.showNotice('非擁有人權限只可選擇 L2–L5。')
    void mutate('save-user', {
      senderId: editingUser.senderId,
      displayName: String(data.get('displayName') || '').trim(),
      level
    }, '私人連接用戶權限已儲存。').then((saved) => { if (saved) closeUserForm() })
  }

  function bindOwner() {
    if (!editingUser || editingUser.actorIsOwner) return
    const ownerId = String(elements.userForm.elements.ownerId.value || '')
    if (!ownerId) return admin.showNotice('請先選擇 WhatsApp 擁有人。')
    void mutate('bind-owner', { senderId: editingUser.senderId, ownerId }, '已綁定為 L1 擁有人。').then((saved) => { if (saved) closeUserForm() })
  }

  function unbindOwner() {
    if (!editingUser?.actorIsOwner) return
    void mutate('unbind-owner', { senderId: editingUser.senderId }, '已解除 L1 擁有人綁定。').then((saved) => { if (saved) closeUserForm() })
  }

  function deleteUser(user = editingUser) {
    if (!user || user.actorIsOwner || user.observedOnly) return
    void mutate('delete-user', { senderId: user.senderId }, '私人連接用戶權限已刪除。').then((saved) => {
      if (!saved) return
      confirmingDelete = null
      closeUserForm()
    })
  }

  function saveGroup(event, chatId) {
    event.preventDefault()
    const level = String(new FormData(event.currentTarget).get('level') || 'L5')
    if (!chatId || !LEVELS.includes(level)) return admin.showNotice('群組級別只可選擇 L2–L5。')
    void mutate('save-group', { chatId, level }, '私人群組級別已儲存。')
  }

  elements.configToggle.addEventListener('click', () => {
    elements.configForm.hidden = !elements.configForm.hidden
    if (!elements.configForm.hidden) elements.configForm.elements.expectedAccountId.focus()
  })
  elements.configCancel.addEventListener('click', () => { elements.configForm.hidden = true; renderChannel() })
  elements.configForm.addEventListener('submit', submitConfig)
  elements.reconnect.addEventListener('click', () => mutate('reconnect', {}, '已要求重新連接儲存的 Session。'))
  elements.repliesToggle.addEventListener('click', () => mutate('set-replies', { enabled: snapshot.channel.autoReplyEnabled !== true }, '自動回覆設定已更新。'))
  elements.groupsToggle.addEventListener('click', () => mutate('set-groups', { enabled: snapshot.channel.groupRepliesEnabled !== true }, '群組回覆設定已更新。'))
  elements.userClose.addEventListener('click', closeUserForm)
  elements.userCancel.addEventListener('click', closeUserForm)
  elements.userForm.addEventListener('submit', submitUser)
  elements.userDelete.addEventListener('click', () => deleteUser())
  elements.ownerBind.addEventListener('click', bindOwner)
  elements.ownerUnbind.addEventListener('click', unbindOwner)
  document.querySelector('#refresh-button')?.addEventListener('click', () => {
    if (isBusy()) refreshQueued = true
    else void refresh({ announce: true })
  })
  window.addEventListener('console:csrf', (event) => {
    if (typeof event.detail?.csrf === 'string' && event.detail.csrf) snapshot.csrf = event.detail.csrf
  })
  window.addEventListener('console:busy', (event) => {
    hostBusy = event.detail?.busy === true
    render()
    if (!isBusy() && refreshQueued) {
      refreshQueued = false
      void refresh()
    }
  })

  render()
  if (!hostBusy) void refresh()
})()

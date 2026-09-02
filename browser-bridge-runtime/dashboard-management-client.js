(() => {
  'use strict'

  const API = location.pathname.replace(/\/ui$/, '')
  const qs = new URLSearchParams(location.search)
  const WORKSPACE = qs.get('workspace') || ''
  const root = document.getElementById('root')
  if (!root || !WORKSPACE) return

  let cardsById = new Map()
  let patchQueued = false

  const fmt = value => {
    if (!value) return '—'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
  }

  async function request(path, options = {}) {
    const response = await fetch(API + path, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...options,
    })
    const payload = await response.json()
    if (!response.ok || payload.ok !== true) throw new Error(payload.error || '请求失败')
    return payload
  }

  async function loadCatalog() {
    const payload = await request(`/catalog?workspace=${encodeURIComponent(WORKSPACE)}`)
    cardsById = new Map((payload.inspections || []).map(item => [item.definition.id, item]))
    schedulePatch()
  }

  function schedulePatch() {
    if (patchQueued) return
    patchQueued = true
    queueMicrotask(() => {
      patchQueued = false
      patchCards()
      patchDetail()
    })
  }

  function patchCards() {
    for (const card of root.querySelectorAll('[data-flow-id]')) {
      if (!(card instanceof HTMLElement)) continue
      const id = card.getAttribute('data-flow-id') || ''
      const item = cardsById.get(id)
      if (!item) continue

      const meta = card.querySelector('.flow-meta')
      const time = meta?.querySelector('span:last-child')
      if (time) {
        time.textContent = `更新 ${fmt(item.definition?.metadata?.updatedAt)}`
        time.setAttribute('title', '流程定义最近更新时间')
      }

      if (!card.querySelector('[data-flow-tools]')) {
        const tools = document.createElement('div')
        tools.setAttribute('data-flow-tools', '')
        tools.className = 'flow-manage-actions'
        tools.innerHTML = [
          `<button class="mini-btn" data-manage-action="rename" data-manage-id="${escapeAttr(id)}">改名</button>`,
          `<button class="mini-btn" data-manage-action="optimize" data-manage-id="${escapeAttr(id)}">优化</button>`,
          `<button class="mini-btn danger" data-manage-action="delete" data-manage-id="${escapeAttr(id)}">删除</button>`,
        ].join('')
        meta?.before(tools)
      }
    }
  }

  function patchDetail() {
    const hero = root.querySelector('.hero')
    const actions = root.querySelector('.top .actions')
    if (!hero || !actions || actions.querySelector('[data-detail-flow-tools]')) return
    const id = hero.querySelector('.tiny.muted')?.textContent?.trim() || ''
    if (!id || !cardsById.has(id)) return

    const wrap = document.createElement('span')
    wrap.setAttribute('data-detail-flow-tools', '')
    wrap.className = 'detail-flow-actions'
    wrap.innerHTML = [
      `<button class="btn" data-manage-action="rename" data-manage-id="${escapeAttr(id)}">编辑名称</button>`,
      `<button class="btn" data-manage-action="optimize" data-manage-id="${escapeAttr(id)}">精简流程</button>`,
      `<button class="btn danger-btn" data-manage-action="delete" data-manage-id="${escapeAttr(id)}">删除流程</button>`,
    ].join('')
    actions.prepend(wrap)
  }

  async function renameFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const current = item.definition?.name || id
    const value = window.prompt('编辑流程名称（流程 ID 保持不变，以保证历史巡检仍能关联）', current)
    if (value === null) return
    const name = value.trim()
    if (!name || name === current) return
    await postAction('/flow/rename', { inspectionId: id, name })
    location.reload()
  }

  async function optimizeFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const count = Array.isArray(item.definition?.steps) ? item.definition.steps.length : 0
    if (!window.confirm(`将自动移除教学阶段的 snapshot/count/多余页面读取等试探步骤，并保留真实操作、条件依赖和必要产物。\n\n当前 ${count} 个步骤，是否继续？`)) return
    const result = await postAction('/flow/optimize', { inspectionId: id })
    window.alert(`流程优化完成：${result.originalSteps} → ${result.finalSteps} 个步骤，移除 ${result.removedSteps} 个教学试探步骤。`)
    location.reload()
  }

  async function deleteFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const name = item.definition?.name || id
    if (!window.confirm(`确定删除流程“${name}”吗？\n\n会删除当前流程定义、工作区 Runbook 和教学临时文件；历史巡检报告保留在磁盘，不会被物理删除。`)) return
    await postAction('/flow/delete', { inspectionId: id, confirmed: true })
    location.reload()
  }

  async function postAction(path, payload) {
    try {
      return await request(path, {
        method: 'POST',
        body: JSON.stringify({ workspace: WORKSPACE, ...payload }),
      })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  function escapeAttr(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char])
  }

  function installStyle() {
    if (document.getElementById('patrol-flow-management-style')) return
    const style = document.createElement('style')
    style.id = 'patrol-flow-management-style'
    style.textContent = `
      .flow-manage-actions{display:flex;gap:6px;margin:2px 0 10px;position:relative;z-index:2}
      .mini-btn{border:1px solid #e5e9f0;background:#fff;border-radius:8px;padding:5px 9px;font-size:11px;color:#475467;cursor:pointer}
      .mini-btn:hover{border-color:#b9c6da;background:#f8fafc}
      .mini-btn.danger,.danger-btn{color:#c43225!important;border-color:#f0c7c3!important}
      .mini-btn.danger:hover,.danger-btn:hover{background:#fef3f2!important}
      .detail-flow-actions{display:inline-flex;gap:8px}
    `
    document.head.appendChild(style)
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('[data-manage-action]') : null
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
    const action = target.getAttribute('data-manage-action') || ''
    const id = target.getAttribute('data-manage-id') || ''
    if (!id) return
    if (action === 'rename') void renameFlow(id)
    else if (action === 'optimize') void optimizeFlow(id)
    else if (action === 'delete') void deleteFlow(id)
  }, true)

  const observer = new MutationObserver(schedulePatch)
  observer.observe(root, { childList: true, subtree: true })
  installStyle()
  void loadCatalog()
})()

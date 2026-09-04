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
    setTimeout(() => {
      patchQueued = false
      patchCards()
      patchDetail()
    }, 0)
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
        const nextText = `更新 ${fmt(item.definition?.metadata?.updatedAt)}`
        if (time.textContent !== nextText) time.textContent = nextText
        if (time.getAttribute('title') !== '流程定义最近更新时间') time.setAttribute('title', '流程定义最近更新时间')
      }

      if (!card.querySelector('[data-flow-tools]')) {
        const tools = document.createElement('div')
        tools.setAttribute('data-flow-tools', '')
        tools.className = 'flow-manage-actions'
        tools.innerHTML = [
          `<button class="mini-btn" data-manage-action="rename" data-manage-id="${escapeAttr(id)}">改名</button>`,
          `<button class="mini-btn" title="清理探针、被后续重置废弃的轮次和重复输入修正" data-manage-action="optimize" data-manage-id="${escapeAttr(id)}">清理试错</button>`,
          `<button class="mini-btn danger" data-manage-action="delete" data-manage-id="${escapeAttr(id)}">删除</button>`,
          `<button class="mini-btn run" data-manage-action="run" data-manage-id="${escapeAttr(id)}">▶ 运行</button>`,
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
      `<button class="btn run-btn" data-manage-action="run" data-manage-id="${escapeAttr(id)}">▶ 运行流程</button>`,
      `<button class="btn" data-manage-action="rename" data-manage-id="${escapeAttr(id)}">编辑名称</button>`,
      `<button class="btn" title="清理探针、重置前的废弃轮次和被后续输入覆盖的修正步骤" data-manage-action="optimize" data-manage-id="${escapeAttr(id)}">清理试错步骤</button>`,
      `<button class="btn danger-btn" data-manage-action="delete" data-manage-id="${escapeAttr(id)}">删除流程</button>`,
    ].join('')
    actions.prepend(wrap)
  }

  function runFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const flowName = String(item.definition?.name || id).trim() || id
    window.parent.postMessage({
      type: 'dsh-patrol:run-flow',
      inspectionId: id,
      flowName,
    }, location.origin)
  }

  async function renameFlow(id) {

    const item = cardsById.get(id)
    if (!item) return
    const current = item.definition?.name || id
    const value = window.prompt('编辑流程名称（稳定流程 ID 保持不变，以保证引用关系不损坏；工作区会同步生成以新名称命名的 .flow.md 文件）', current)
    if (value === null) return
    const name = value.trim()
    if (!name || name === current) return
    const result = await postAction('/flow/rename', { inspectionId: id, name })
    if (result.workspaceFlowFile) window.alert(`流程已改名并写入真实 Runbook。\n工作区流程文件：${result.workspaceFlowFile}`)
    location.reload()
  }

  async function optimizeFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const count = Array.isArray(item.definition?.steps) ? item.definition.steps.length : 0
    const message = [
      '这是“清理教学试错步骤”，不是删除流程。',
      '',
      '会自动清理：snapshot/count 探针、无依赖的重复页面读取、重新导航到目标页之前已废弃的试错轮次、同一输入框被后续值覆盖的重复输入。',
      '会保留：最终有效导航/点击、人工检查点、条件依赖、断言，以及最终截图/页面产物。',
      '',
      '新教学流程在对话结束时还会由 patrol_finalize_flow 根据“真正成功路径”做语义精简；这里主要用于清理已有旧流程。',
      '确认后会直接更新真实 Runbook 和工作区流程文件。',
      `当前流程共 ${count} 个步骤。是否继续清理？`,
    ].join('\n')
    if (!window.confirm(message)) return
    const result = await postAction('/flow/optimize', { inspectionId: id })
    window.alert(`清理完成：${result.originalSteps} → ${result.finalSteps} 个步骤，移除 ${result.removedSteps} 个教学试错/探针步骤。`)
    location.reload()
  }

  async function deleteFlow(id) {
    const item = cardsById.get(id)
    if (!item) return
    const name = item.definition?.name || id
    const message = [
      `确定彻底删除流程“${name}”吗？`,
      '',
      '这是物理删除，不是从界面隐藏：',
      '• 删除内部流程定义和 pending 状态',
      '• 删除该流程全部内部巡检历史',
      '• 删除工作区 patrol-results/<flow-id>/ 整个目录（Runbook、教学产物、历史报告和截图）',
      '',
      '删除后无法从“流程管理”或“巡检记录”恢复。',
    ].join('\n')
    if (!window.confirm(message)) return
    await postAction('/flow/delete', { inspectionId: id, confirmed: true, deleteHistory: true })
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
      .mini-btn.run{margin-left:auto}.mini-btn.run,.run-btn{color:#1d4ed8!important;border-color:#bfd0f6!important;background:#f7faff!important}
      .mini-btn.run:hover,.run-btn:hover{background:#eff6ff!important;border-color:#93b4ef!important}
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
    if (action === 'run') runFlow(id)
    else if (action === 'rename') void renameFlow(id)
    else if (action === 'optimize') void optimizeFlow(id)
    else if (action === 'delete') void deleteFlow(id)
  }, true)

  const observer = new MutationObserver(schedulePatch)
  observer.observe(root, { childList: true, subtree: true })
  installStyle()
  void loadCatalog()
})()

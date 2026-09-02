(() => {
  'use strict'

  const API = location.pathname.replace(/\/ui$/, '')
  const qs = new URLSearchParams(location.search)
  const MODE = qs.get('mode') === 'records' ? 'records' : 'flows'
  const WORKSPACE = qs.get('workspace') || ''
  const CURRENT = qs.get('current') || ''
  const root = document.getElementById('root')

  let catalog = null
  let selectedFlow = CURRENT
  let selectedRun = null
  let runDetail = null
  let detailTab = 'overview'

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])

  const fmt = value => {
    if (!value) return '—'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleString('zh-CN', { hour12: false })
  }

  const dur = (startedAt, finishedAt) => {
    const start = new Date(startedAt).getTime()
    const finish = new Date(finishedAt).getTime()
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) return '—'
    const seconds = (finish - start) / 1000
    return seconds < 60
      ? `${seconds.toFixed(1)} 秒`
      : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  }

  const pill = status => `<span class="pill ${esc(status)}">${({
    passed: '通过', failed: '失败', waiting: '等待中', ready: '已就绪', draft: '草稿',
  })[status] || esc(status || '未知')}</span>`

  const host = value => {
    try { return new URL(value).host } catch { return value || '—' }
  }

  function empty(title, subtitle) {
    return `<div class="card empty"><div class="empty-title">${esc(title)}</div><div class="muted empty-sub">${esc(subtitle || '')}</div></div>`
  }

  function header(title, subtitle, actions = '') {
    return `<div class="top"><div><div class="eyebrow">DSH PATROL</div><h1 class="title">${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div><div class="actions">${actions}</div></div>`
  }

  async function get(path, timeout = 12000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(API + path, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      const payload = await response.json()
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || '请求失败')
      return payload
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('读取巡检数据超时。请确认 Patrol Host 已更新并重新启动。')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  function notice() {
    return catalog?.truncated
      ? '<div class="notice">当前工作区历史记录很多，为保证页面快速打开，每个流程最多加载最近 2000 条记录；流程总运行次数仍显示真实数量。</div>'
      : ''
  }

  async function boot() {
    if (!root) return
    if (!WORKSPACE) {
      root.innerHTML = header(MODE === 'flows' ? '流程管理' : '巡检记录', '当前会话没有可识别的工作区路径。') + empty('暂无工作区', '请从已打开工作区的巡检会话进入。')
      return
    }
    try {
      catalog = await get(`/catalog?workspace=${encodeURIComponent(WORKSPACE)}`)
      render()
    } catch (error) {
      root.innerHTML = header('巡检数据读取失败', 'Dashboard Host 没有在限定时间内返回数据。') + empty('无法读取巡检数据', error instanceof Error ? error.message : String(error))
    }
  }

  function render() {
    if (!catalog) return
    if (MODE === 'flows') renderFlows()
    else renderRecords()
  }

  function renderFlows() {
    const cards = catalog.inspections || []
    const current = cards.find(item => item.definition.id === selectedFlow)
    if (current) {
      renderFlowDetail(current)
      return
    }
    const runs = catalog.runs || []
    const passed = runs.filter(item => item.status === 'passed').length
    root.innerHTML = header(
      '流程管理',
      '集中管理当前工作区的巡检流程，点击卡片查看流程图和历史运行。',
      '<button class="btn" data-action="refresh">↻ 刷新</button>',
    ) + notice() + `<div class="stats">
      <div class="stat"><span>流程总数</span><b>${cards.length}</b></div>
      <div class="stat"><span>已就绪</span><b>${cards.filter(item => item.definition.status === 'ready').length}</b></div>
      <div class="stat"><span>已加载巡检</span><b>${runs.length}</b></div>
      <div class="stat"><span>通过记录</span><b>${passed}</b></div>
    </div>` + (cards.length ? `<div class="flow-grid">${cards.map(flowCard).join('')}</div>` : empty('还没有流程', '保存第一个巡检流程后，这里会自动出现。'))
  }

  function flowCard(item) {
    const definition = item.definition
    const latest = item.latestRun
    return `<article class="card flow-card" data-flow-id="${esc(definition.id)}">
      <div class="flow-icon">${esc(String((definition.name || definition.id).trim().charAt(0) || '流').toUpperCase())}</div>
      <div class="flow-head"><div class="flow-name">${esc(definition.name || definition.id)}</div>${pill(definition.status)}</div>
      <div class="flow-desc">${esc(definition.description || '暂无流程说明')}</div>
      <div class="tiny muted truncate">${esc(host(definition.target?.url || ''))}</div>
      <div class="flow-meta"><span>${(definition.steps || []).length} 个步骤 · ${item.runCount} 次运行</span><span>${latest ? fmt(latest.startedAt) : '尚未运行'}</span></div>
    </article>`
  }

  function renderFlowDetail(item) {
    const definition = item.definition
    const latest = item.latestRun
    root.innerHTML = header(
      '流程详情',
      '默认展示当前会话使用的流程，可返回查看当前工作区全部流程。',
      '<button class="btn" data-action="close-flow">← 返回全部流程</button><button class="btn" data-action="refresh">↻ 刷新</button>',
    ) + notice() + `<section class="card hero">
      <div>${pill(definition.status)} <span class="tiny muted">${esc(definition.id)}</span></div>
      <h2>${esc(definition.name || definition.id)}</h2>
      <p>${esc(definition.description || '暂无流程说明')}</p>
      <div class="meta-grid">
        ${meta('目标地址', definition.target?.url || '—')}
        ${meta('预期结果', definition.expectedResult || '—')}
        ${meta('最近更新', fmt(definition.metadata?.updatedAt))}
        ${meta('步骤数量', `${(definition.steps || []).length} 个`)}
        ${meta('认证方式', definition.auth?.mode || 'none')}
        ${meta('最近运行', latest ? fmt(latest.startedAt) : '尚未运行')}
      </div>
    </section>
    <div class="detail-grid">
      <section class="card panel"><h3 class="section-title">流程图</h3><div class="steps">${diagram(definition.steps || [])}</div></section>
      <section class="card panel"><h3 class="section-title">流程信息</h3>
        ${info('产物类型', (definition.artifacts || []).join('、') || '未指定')}
        ${info('计划任务', definition.schedule?.enabled ? (definition.schedule.cron || '已启用') : '未启用')}
        ${info('工作区', definition.metadata?.workspaceRoot || '—')}
        ${info('最近验证', fmt(definition.metadata?.validatedAt))}
      </section>
    </div>${recentRuns(item)}`
  }

  function meta(label, value) {
    return `<div class="meta"><label>${esc(label)}</label><div>${esc(value)}</div></div>`
  }

  function info(label, value) {
    return `<div class="info-row"><div class="tiny muted">${esc(label)}</div><div class="info-value">${esc(value)}</div></div>`
  }

  function diagram(steps) {
    if (!steps.length) return empty('暂无步骤', '该流程还没有可复用步骤。')
    return steps.map((step, index) => `<div class="step">
      <div class="num">${index + 1}</div>
      <details class="node">
        <summary><div class="node-head"><div><div class="node-name">${esc(step.name || step.id)}</div><div class="tiny muted node-tool">${esc(step.kind === 'checkpoint' ? '人工确认' : step.tool || '自动步骤')}</div></div><span class="chip">${step.kind === 'checkpoint' ? '检查点' : '自动执行'}</span></div></summary>
        ${step.notes ? `<div class="muted node-note">${esc(step.notes)}</div>` : ''}
        ${step.expectation ? `<span class="chip">校验 ${esc(step.expectation.mode)}</span>` : ''}
        ${step.when ? '<span class="chip">条件分支</span>' : ''}
        ${step.artifact ? `<span class="chip">产物 ${esc(step.artifact)}</span>` : ''}
      </details>
    </div>`).join('')
  }

  function recentRuns(item) {
    const rows = (catalog.runs || []).filter(run => run.inspectionId === item.definition.id).slice(0, 5)
    return `<section class="card panel recent"><div class="section-head"><h3 class="section-title">最近巡检</h3><span class="tiny muted">共 ${item.runCount} 次</span></div>${rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>状态</th><th>概述</th><th>步骤</th><th>耗时</th></tr></thead><tbody>${rows.map(run => `<tr data-run-inspection="${esc(run.inspectionId)}" data-run-id="${esc(run.runId)}"><td>${fmt(run.startedAt)}</td><td>${pill(run.status)}</td><td class="summary">${esc(run.summary || '—')}</td><td>${run.passedSteps}/${run.stepCount}</td><td>${dur(run.startedAt, run.finishedAt)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="muted empty-inline">还没有历史运行。</div>'}</section>`
  }

  function renderRecords() {
    if (selectedRun && runDetail) {
      renderRunDetail()
      return
    }
    const runs = catalog.runs || []
    root.innerHTML = header(
      '巡检记录',
      '一条记录代表一次完整巡检。支持搜索、筛选、排序，点击查看概述、步骤、产物和日志。',
      '<button class="btn" data-action="refresh">↻ 刷新</button>',
    ) + notice() + `<div class="stats">
      <div class="stat"><span>已加载记录</span><b>${runs.length}</b></div>
      <div class="stat"><span>通过</span><b>${runs.filter(item => item.status === 'passed').length}</b></div>
      <div class="stat"><span>失败</span><b>${runs.filter(item => item.status === 'failed').length}</b></div>
      <div class="stat"><span>等待处理</span><b>${runs.filter(item => item.status === 'waiting').length}</b></div>
    </div>
    <div class="toolbar">
      <input id="search" class="control" placeholder="搜索流程、概述、目标地址…">
      <select id="status" class="control"><option value="all">全部状态</option><option value="passed">通过</option><option value="failed">失败</option><option value="waiting">等待中</option></select>
      <select id="sort" class="control"><option value="new">时间：最新优先</option><option value="old">时间：最早优先</option><option value="name">流程名称</option></select>
      <div class="muted count"><span id="count">${runs.length}</span> 条</div>
    </div>
    <section class="card table-wrap"><table class="table"><thead><tr><th>巡检时间</th><th>流程</th><th>状态</th><th>概述</th><th>目标</th><th>步骤</th><th>产物</th><th>耗时</th></tr></thead><tbody id="records-body"></tbody></table><div id="records-empty"></div></section>`
    document.getElementById('search')?.addEventListener('input', filterRecords)
    document.getElementById('status')?.addEventListener('change', filterRecords)
    document.getElementById('sort')?.addEventListener('change', filterRecords)
    filterRecords()
  }

  function filterRecords() {
    const search = (document.getElementById('search')?.value || '').trim().toLowerCase()
    const status = document.getElementById('status')?.value || 'all'
    const sort = document.getElementById('sort')?.value || 'new'
    let rows = (catalog.runs || []).filter(run => (status === 'all' || run.status === status) && (!search || [run.inspectionName, run.summary, run.targetUrl, run.inspectionId].join(' ').toLowerCase().includes(search)))
    rows = rows.slice().sort((left, right) => sort === 'old'
      ? String(left.startedAt).localeCompare(String(right.startedAt))
      : sort === 'name'
        ? String(left.inspectionName).localeCompare(String(right.inspectionName), 'zh-CN')
        : String(right.startedAt).localeCompare(String(left.startedAt)))
    const body = document.getElementById('records-body')
    if (!body) return
    body.innerHTML = rows.map(recordRow).join('')
    const count = document.getElementById('count')
    if (count) count.textContent = String(rows.length)
    const noRows = document.getElementById('records-empty')
    if (noRows) noRows.innerHTML = rows.length ? '' : empty('没有匹配的巡检记录', '调整关键词或状态后再试。')
  }

  function recordRow(run) {
    return `<tr data-run-inspection="${esc(run.inspectionId)}" data-run-id="${esc(run.runId)}">
      <td class="nowrap">${fmt(run.startedAt)}</td>
      <td><b>${esc(run.inspectionName)}</b><div class="tiny muted">${esc(run.inspectionId)}</div></td>
      <td>${pill(run.status)}</td>
      <td class="summary" title="${esc(run.summary || '')}">${esc(run.summary || '—')}${run.partial ? ' <span class="tiny muted">(轻量索引)</span>' : ''}</td>
      <td>${esc(host(run.targetUrl))}</td>
      <td>${run.passedSteps}/${run.stepCount}</td>
      <td>${run.artifactCount}</td>
      <td class="nowrap">${dur(run.startedAt, run.finishedAt)}</td>
    </tr>`
  }

  async function openRun(inspectionId, runId) {
    selectedRun = { inspectionId, runId }
    root.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在读取巡检详情…</div></div>'
    try {
      runDetail = await get(`/run?workspace=${encodeURIComponent(WORKSPACE)}&inspectionId=${encodeURIComponent(inspectionId)}&runId=${encodeURIComponent(runId)}`, 20000)
      detailTab = 'overview'
      renderRunDetail()
    } catch (error) {
      selectedRun = null
      runDetail = null
      root.innerHTML = header('巡检详情读取失败', '完整历史报告可能很大。') + empty('无法读取巡检详情', error instanceof Error ? error.message : String(error))
    }
  }

  function renderRunDetail() {
    const report = runDetail.report
    const definition = runDetail.definition
    const artifacts = runDetail.artifacts || []
    root.innerHTML = header('巡检详情', report.inspectionName || definition.name || report.inspectionId, '<button class="btn" data-action="close-run">← 返回</button>') + `<section class="card hero">
      <div>${pill(report.status)}</div><h2>${esc(report.inspectionName || definition.name)}</h2><p>${esc(report.summary || '本次巡检已完成，详细信息见下方。')}</p>
      <div class="tiny muted hero-time">${fmt(report.startedAt)} · ${dur(report.startedAt, report.finishedAt)}</div>
    </section>
    <div class="tabs">${[['overview', '概述'], ['steps', '步骤'], ['artifacts', '产物'], ['logs', '日志']].map(([id, label]) => `<button class="tab ${detailTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>
    ${detailContent(report, definition, artifacts)}`
  }

  function detailContent(report, definition, artifacts) {
    if (detailTab === 'steps') return stepsView(report)
    if (detailTab === 'artifacts') return artifactsView(artifacts)
    if (detailTab === 'logs') return logsView(report, definition)
    const rows = report.results || []
    const passed = rows.filter(item => item.status === 'passed').length
    return `<div class="detail-grid"><section class="card panel"><h3 class="section-title">本次巡检概述</h3><div class="overview-text">${esc(report.summary || '没有额外摘要。')}</div><div class="muted overview-progress">步骤完成 ${passed}/${rows.length}</div></section><section class="card panel"><h3 class="section-title">关键信息</h3>${info('目标地址', definition.target?.url || '—')}${info('预期结果', report.expectedResult || definition.expectedResult || '—')}${info('开始时间', fmt(report.startedAt))}${info('结束时间', fmt(report.finishedAt))}${info('产物数量', String(artifacts.length))}</section></div>`
  }

  function stepsView(report) {
    const rows = report.results || []
    if (!rows.length) return empty('暂无步骤结果', '本次巡检没有可展示的步骤记录。')
    return `<section class="card panel"><div class="timeline">${rows.map(item => `<div class="row ${esc(item.status)}"><div class="dot"></div><div class="runbox"><div class="run-head"><div><b>${esc(item.name || item.stepId)}</b><div class="tiny muted">${esc(item.tool || item.kind || '步骤')}</div></div>${pill(item.status)}</div><div class="tiny muted run-time">${fmt(item.startedAt)} · ${dur(item.startedAt, item.finishedAt)}</div>${item.error ? `<div class="output error">${esc(item.error)}</div>` : item.output ? `<div class="output">${esc(item.output)}</div>` : ''}</div></div>`).join('')}</div></section>`
  }

  function artifactsView(artifacts) {
    if (!artifacts.length) return empty('暂无产物', '本次巡检没有保存可预览产物。')
    return `<div class="artifact-grid">${artifacts.map(artifact => `<article class="card artifact"><div class="preview">${artifact.preview === 'image' ? `<img loading="lazy" src="${esc(artifact.url)}" alt="${esc(artifact.name)}">` : '<div class="file-icon">▤</div>'}</div><div class="artifact-info"><b>${esc(artifact.name)}</b><div class="tiny muted artifact-meta">${esc(artifact.kind)} · ${bytes(artifact.size)}</div><button class="btn artifact-open" data-artifact-token="${esc(artifact.token)}">${artifact.preview === 'download' ? '打开' : '预览'}</button></div></article>`).join('')}</div>`
  }

  function logsView(report, definition) {
    const byId = new Map((definition.steps || []).map(step => [step.id, step]))
    return (report.results || []).map(item => {
      const step = byId.get(item.stepId) || {}
      return `<details class="log"><summary><span>${esc(item.name || item.stepId)}</span>${pill(item.status)}</summary><pre class="code">工具: ${esc(item.tool || step.tool || item.kind || '')}\n\n参数:\n${esc(JSON.stringify(step.arguments || {}, null, 2))}\n\n输出:\n${esc(item.output || '')}${item.error ? `\n\n错误:\n${esc(item.error)}` : ''}</pre></details>`
    }).join('') || empty('暂无日志', '本次巡检没有步骤日志。')
  }

  function bytes(value) {
    if (!Number.isFinite(value)) return '—'
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }

  async function previewArtifact(token) {
    const artifact = (runDetail?.artifacts || []).find(item => item.token === token)
    if (!artifact) return
    if (artifact.preview === 'download') {
      window.open(artifact.url, '_blank', 'noopener')
      return
    }
    const modal = document.createElement('div')
    modal.id = 'artifact-modal'
    modal.className = 'modal-bg'
    modal.innerHTML = `<div class="modal"><div class="modal-head"><b>${esc(artifact.name)}</b><button class="btn" data-action="close-modal">关闭</button></div><div id="modal-body" class="modal-body"><div class="loading modal-loading">正在加载…</div></div></div>`
    document.body.appendChild(modal)
    const body = document.getElementById('modal-body')
    if (!body) return
    if (artifact.preview === 'image') {
      body.innerHTML = `<img src="${esc(artifact.url)}" alt="${esc(artifact.name)}">`
      return
    }
    try {
      const response = await fetch(artifact.url, { cache: 'no-store', credentials: 'same-origin' })
      let text = await response.text()
      if (artifact.mime?.startsWith('application/json')) {
        try { text = JSON.stringify(JSON.parse(text), null, 2) } catch {}
      }
      body.innerHTML = `<pre class="code modal-code">${esc(text)}</pre>`
    } catch (error) {
      body.innerHTML = empty('预览失败', error instanceof Error ? error.message : String(error))
    }
  }

  async function refresh() {
    selectedRun = null
    runDetail = null
    root.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在刷新…</div></div>'
    try {
      catalog = await get(`/catalog?workspace=${encodeURIComponent(WORKSPACE)}`)
      render()
    } catch (error) {
      root.innerHTML = header('刷新失败', 'Dashboard Host 没有及时返回数据。') + empty('无法刷新', error instanceof Error ? error.message : String(error))
    }
  }

  root?.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const action = target.closest('[data-action]')?.getAttribute('data-action')
    if (action === 'refresh') { void refresh(); return }
    if (action === 'close-flow') { selectedFlow = ''; renderFlows(); window.scrollTo(0, 0); return }
    if (action === 'close-run') { selectedRun = null; runDetail = null; detailTab = 'overview'; render(); window.scrollTo(0, 0); return }
    if (action === 'close-modal') { document.getElementById('artifact-modal')?.remove(); return }

    const flow = target.closest('[data-flow-id]')
    if (flow) {
      selectedFlow = flow.getAttribute('data-flow-id') || ''
      renderFlows()
      window.scrollTo(0, 0)
      return
    }

    const run = target.closest('[data-run-id][data-run-inspection]')
    if (run) {
      void openRun(run.getAttribute('data-run-inspection') || '', run.getAttribute('data-run-id') || '')
      return
    }

    const tab = target.closest('[data-tab]')
    if (tab && runDetail) {
      detailTab = tab.getAttribute('data-tab') || 'overview'
      renderRunDetail()
      return
    }

    const artifact = target.closest('[data-artifact-token]')
    if (artifact) {
      void previewArtifact(artifact.getAttribute('data-artifact-token') || '')
    }
  })

  document.addEventListener('click', event => {
    const modal = document.getElementById('artifact-modal')
    if (modal && event.target === modal) modal.remove()
  })

  void boot()
})()

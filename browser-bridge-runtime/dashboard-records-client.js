(() => {
  'use strict'

  const API = location.pathname.replace(/\/ui$/, '')
  const qs = new URLSearchParams(location.search)
  const WORKSPACE = qs.get('workspace') || ''
  const root = document.getElementById('root')

  let catalog = null
  let batchCatalog = { batches: [], truncated: false }
  let selectedRun = null
  let runDetail = null
  let selectedBatch = null
  let batchDetail = null
  let detailTab = 'overview'

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
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
    return seconds < 60 ? `${seconds.toFixed(1)} 秒` : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  }

  const pill = status => `<span class="pill ${esc(status)}">${({ passed: '通过', failed: '失败', waiting: '等待中' })[status] || esc(status || '未知')}</span>`
  const host = value => { try { return new URL(value).host } catch { return value || '—' } }

  function empty(title, subtitle) {
    return `<div class="card empty"><div class="empty-title">${esc(title)}</div><div class="muted empty-sub">${esc(subtitle || '')}</div></div>`
  }

  function header(title, subtitle, actions = '') {
    return `<div class="top"><div><div class="eyebrow">DSH PATROL</div><h1 class="title">${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div><div class="actions">${actions}</div></div>`
  }

  function info(label, value) {
    return `<div class="info-row"><div class="tiny muted">${esc(label)}</div><div class="info-value">${esc(value)}</div></div>`
  }

  async function get(path, timeout = 12000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(API + path, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      const payload = await response.json()
      if (!response.ok || payload.ok !== true) throw new Error(payload.error || '请求失败')
      return payload
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('读取巡检数据超时。请确认 Patrol Host 已更新并重新启动。')
      throw error
    } finally { clearTimeout(timer) }
  }

  async function loadBatchCatalog() {
    try {
      return await get(`/batches?workspace=${encodeURIComponent(WORKSPACE)}`)
    } catch (error) {
      console.warn('[dsh-patrol] batch record catalog unavailable:', error)
      return { batches: [], truncated: false }
    }
  }

  function notice() {
    const notes = []
    if (catalog?.truncated) notes.push('单流程历史记录很多，每个流程最多加载最近 2000 条记录。')
    if (batchCatalog?.truncated) notes.push('批量巡检历史记录很多，最多加载最近 2000 个批次。')
    return notes.length ? `<div class="notice">${esc(notes.join(' '))}</div>` : ''
  }

  function topLevelRecords() {
    const batches = Array.isArray(batchCatalog?.batches) ? batchCatalog.batches : []
    const childKeys = new Set()
    for (const batch of batches) {
      for (const child of Array.isArray(batch.children) ? batch.children : []) {
        if (child?.flowId && child?.runId) childKeys.add(`${child.flowId}\u0000${child.runId}`)
      }
    }
    const singles = (catalog?.runs || [])
      .filter(run => !childKeys.has(`${run.inspectionId}\u0000${run.runId}`))
      .map(run => ({ ...run, recordType: 'single', recordId: `run:${run.inspectionId}:${run.runId}` }))
    return [...batches, ...singles].sort((a, b) => String(b.startedAt || b.recordId || '').localeCompare(String(a.startedAt || a.recordId || '')))
  }

  async function boot() {
    if (!root) return
    if (!WORKSPACE) {
      root.innerHTML = header('巡检记录', '当前会话没有可识别的工作区路径。') + empty('暂无工作区', '请从已打开工作区的巡检会话进入。')
      return
    }
    try {
      const [nextCatalog, nextBatches] = await Promise.all([
        get(`/catalog?workspace=${encodeURIComponent(WORKSPACE)}`),
        loadBatchCatalog(),
      ])
      catalog = nextCatalog
      batchCatalog = nextBatches
      renderRecords()
    } catch (error) {
      root.innerHTML = header('巡检数据读取失败', 'Dashboard Host 没有在限定时间内返回数据。') + empty('无法读取巡检数据', error instanceof Error ? error.message : String(error))
    }
  }

  function renderRecords() {
    if (selectedBatch && batchDetail) { renderBatchDetail(); return }
    if (selectedRun && runDetail) { renderRunDetail(); return }
    const records = topLevelRecords()
    root.innerHTML = header(
      '巡检记录',
      '一次“开始巡检”对应一条顶级记录；批量巡检会把多个设备/流程的子巡检收纳在同一条记录中。',
      '<button class="btn" data-action="refresh">↻ 刷新</button>',
    ) + notice() + `<div class="stats">
      <div class="stat"><span>巡检任务</span><b>${records.length}</b></div>
      <div class="stat"><span>通过</span><b>${records.filter(item => item.status === 'passed').length}</b></div>
      <div class="stat"><span>失败</span><b>${records.filter(item => item.status === 'failed').length}</b></div>
      <div class="stat"><span>批量巡检</span><b>${records.filter(item => item.recordType === 'batch').length}</b></div>
    </div>
    <div class="toolbar" style="grid-template-columns:minmax(220px,1fr) 150px 150px 180px auto">
      <input id="search" class="control" placeholder="搜索流程、设备、批次、概述、目标地址…">
      <select id="kind" class="control"><option value="all">全部类型</option><option value="single">单次巡检</option><option value="batch">批量巡检</option></select>
      <select id="status" class="control"><option value="all">全部状态</option><option value="passed">通过</option><option value="failed">失败</option><option value="waiting">等待中</option></select>
      <select id="sort" class="control"><option value="new">时间：最新优先</option><option value="old">时间：最早优先</option><option value="name">名称</option></select>
      <div class="muted count"><span id="count">${records.length}</span> 条</div>
    </div>
    <section class="card table-wrap"><table class="table"><thead><tr><th>巡检时间</th><th>类型 / 流程</th><th>状态</th><th>概述</th><th>目标</th><th>完成情况</th><th>产物</th><th>耗时</th></tr></thead><tbody id="records-body"></tbody></table><div id="records-empty"></div></section>`
    document.getElementById('search')?.addEventListener('input', filterRecords)
    document.getElementById('kind')?.addEventListener('change', filterRecords)
    document.getElementById('status')?.addEventListener('change', filterRecords)
    document.getElementById('sort')?.addEventListener('change', filterRecords)
    filterRecords()
  }

  function recordSearchText(record) {
    if (record.recordType === 'batch') {
      return [record.batchRunId, record.summary, ...(record.flowNames || [])].join(' ').toLowerCase()
    }
    return [record.inspectionName, record.summary, record.targetUrl, record.inspectionId].join(' ').toLowerCase()
  }

  function recordName(record) {
    return record.recordType === 'batch' ? `批量巡检 ${record.totalFlows || 0} 个流程` : String(record.inspectionName || record.inspectionId || '')
  }

  function filterRecords() {
    const search = (document.getElementById('search')?.value || '').trim().toLowerCase()
    const kind = document.getElementById('kind')?.value || 'all'
    const status = document.getElementById('status')?.value || 'all'
    const sort = document.getElementById('sort')?.value || 'new'
    let rows = topLevelRecords().filter(record =>
      (kind === 'all' || record.recordType === kind)
      && (status === 'all' || record.status === status)
      && (!search || recordSearchText(record).includes(search)))
    rows = rows.slice().sort((left, right) => sort === 'old'
      ? String(left.startedAt).localeCompare(String(right.startedAt))
      : sort === 'name'
        ? recordName(left).localeCompare(recordName(right), 'zh-CN')
        : String(right.startedAt).localeCompare(String(left.startedAt)))
    const body = document.getElementById('records-body')
    if (!body) return
    body.innerHTML = rows.map(recordRow).join('')
    const count = document.getElementById('count')
    if (count) count.textContent = String(rows.length)
    const noRows = document.getElementById('records-empty')
    if (noRows) noRows.innerHTML = rows.length ? '' : empty('没有匹配的巡检记录', '调整关键词、类型或状态后再试。')
  }

  function recordRow(record) {
    if (record.recordType === 'batch') {
      const names = (record.flowNames || []).slice(0, 3).join('、')
      const more = (record.flowNames || []).length > 3 ? ` 等 ${record.flowNames.length} 个` : ''
      return `<tr data-batch-id="${esc(record.batchRunId)}">
        <td class="nowrap">${fmt(record.startedAt)}</td>
        <td><b>批量巡检</b> <span class="chip">${record.totalFlows || 0} 个流程</span><div class="tiny muted">${esc(record.batchRunId)}</div></td>
        <td>${pill(record.status)}</td>
        <td class="summary" title="${esc((record.flowNames || []).join('、'))}">${esc(names || record.summary || '批量巡检')}${esc(more)}</td>
        <td>${record.totalFlows || 0} 个目标</td>
        <td>${record.passedFlows || 0}/${record.totalFlows || 0} 通过</td>
        <td>汇总 + 子巡检</td>
        <td class="nowrap">${dur(record.startedAt, record.finishedAt)}</td>
      </tr>`
    }
    return `<tr data-run-inspection="${esc(record.inspectionId)}" data-run-id="${esc(record.runId)}">
      <td class="nowrap">${fmt(record.startedAt)}</td>
      <td><b>${esc(record.inspectionName)}</b><div class="tiny muted">单次巡检 · ${esc(record.inspectionId)}</div></td>
      <td>${pill(record.status)}</td>
      <td class="summary" title="${esc(record.summary || '')}">${esc(record.summary || '—')}${record.partial ? ' <span class="tiny muted">(轻量索引)</span>' : ''}</td>
      <td>${esc(host(record.targetUrl))}</td>
      <td>${record.passedSteps}/${record.stepCount}</td>
      <td>${record.artifactCount}</td>
      <td class="nowrap">${dur(record.startedAt, record.finishedAt)}</td>
    </tr>`
  }

  async function openBatch(batchRunId) {
    selectedBatch = batchRunId
    selectedRun = null
    runDetail = null
    batchDetail = null
    root.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在读取批量巡检详情…</div></div>'
    try {
      const payload = await get(`/batch?workspace=${encodeURIComponent(WORKSPACE)}&batchRunId=${encodeURIComponent(batchRunId)}`, 20000)
      batchDetail = payload.batch
      detailTab = 'overview'
      renderBatchDetail()
    } catch (error) {
      selectedBatch = null
      root.innerHTML = header('批量巡检详情读取失败', '无法读取这个批次的汇总信息。') + empty('无法读取批量巡检详情', error instanceof Error ? error.message : String(error))
    }
  }

  function batchTabs(batch) {
    const children = Array.isArray(batch.children) ? batch.children : []
    const overviewActive = !selectedRun
    return `<div class="tabs" style="overflow:auto">
      <button class="tab ${overviewActive ? 'active' : ''}" data-action="batch-overview">总览</button>
      ${children.map(child => child.runId
        ? `<button class="tab ${selectedRun?.inspectionId === child.flowId && selectedRun?.runId === child.runId ? 'active' : ''}" data-batch-child-inspection="${esc(child.flowId)}" data-batch-child-run="${esc(child.runId)}">${child.order}. ${esc(child.flowName)}</button>`
        : `<span class="tab" style="cursor:default;opacity:.65">${child.order}. ${esc(child.flowName)}</span>`).join('')}
    </div>`
  }

  function renderBatchDetail() {
    const batch = batchDetail
    if (!batch) return
    const children = Array.isArray(batch.children) ? batch.children : []
    root.innerHTML = header(
      '批量巡检详情',
      `${batch.totalFlows || children.length} 个流程 · 串行执行（concurrency=1）`,
      '<button class="btn" data-action="close-batch">← 返回巡检记录</button>',
    ) + `<section class="card hero">
      <div>${pill(batch.status)} <span class="chip">批量巡检</span></div>
      <h2>${esc(batch.batchRunId)}</h2>
      <p>${esc(batch.summary || '本次批量巡检已记录全部子巡检结果。')}</p>
      <div class="tiny muted hero-time">${fmt(batch.startedAt)} · ${dur(batch.startedAt, batch.finishedAt)}</div>
      <div class="meta-grid">
        <div class="meta"><label>流程总数</label><div>${batch.totalFlows || children.length}</div></div>
        <div class="meta"><label>成功</label><div>${batch.passedFlows || 0}</div></div>
        <div class="meta"><label>失败</label><div>${batch.failedFlows || 0}</div></div>
        <div class="meta"><label>等待处理</label><div>${batch.waitingFlows || 0}</div></div>
        <div class="meta"><label>执行模式</label><div>串行</div></div>
        <div class="meta"><label>并发数</label><div>1</div></div>
      </div>
    </section>${batchTabs(batch)}${selectedRun && runDetail ? renderBatchChildDetail() : renderBatchOverview(batch)}`
  }

  function renderBatchOverview(batch) {
    const children = Array.isArray(batch.children) ? batch.children : []
    if (!children.length) return empty('没有子巡检记录', '这个批次还没有产生子巡检结果。')
    return `<section class="card table-wrap"><table class="table"><thead><tr><th>顺序</th><th>流程 / 设备</th><th>状态</th><th>目标</th><th>预期结果</th><th>步骤</th><th>运行记录</th></tr></thead><tbody>${children.map(child => `<tr ${child.runId ? `data-batch-child-inspection="${esc(child.flowId)}" data-batch-child-run="${esc(child.runId)}"` : ''}>
      <td>${child.order}</td>
      <td><b>${esc(child.flowName)}</b><div class="tiny muted">${esc(child.flowId)}</div></td>
      <td>${pill(child.status)}</td>
      <td>${esc(host(child.targetUrl))}</td>
      <td class="summary">${esc(child.expectedResult || '—')}</td>
      <td>${child.stepCount || 0}</td>
      <td>${child.runId ? `<span class="tiny">${esc(child.runId)}</span>` : `<span class="tiny ${child.error ? '' : 'muted'}">${esc(child.error || '尚未运行')}</span>`}</td>
    </tr>`).join('')}</tbody></table></section>`
  }

  function renderBatchChildDetail() {
    const report = runDetail.report
    const definition = runDetail.definition
    const artifacts = runDetail.artifacts || []
    return `<section class="card hero" style="margin-top:14px">
      <div>${pill(report.status)} <span class="tiny muted">子巡检</span></div>
      <h2>${esc(report.inspectionName || definition.name)}</h2>
      <p>${esc(report.summary || '本次子巡检已完成，详细信息见下方。')}</p>
      <div class="tiny muted hero-time">${fmt(report.startedAt)} · ${dur(report.startedAt, report.finishedAt)}</div>
    </section>
    <div class="tabs">${[['overview', '概述'], ['steps', '步骤'], ['artifacts', '产物'], ['logs', '日志'], ['checklist', '任务清单']].map(([id, label]) => `<button class="tab ${detailTab === id ? 'active' : ''}" data-detail-tab="${id}">${label}</button>`).join('')}</div>
    ${detailContent(report, definition, artifacts)}`
  }

  async function openRun(inspectionId, runId, insideBatch = false) {
    selectedRun = { inspectionId, runId }
    root.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在读取巡检详情…</div></div>'
    try {
      runDetail = await get(`/run?workspace=${encodeURIComponent(WORKSPACE)}&inspectionId=${encodeURIComponent(inspectionId)}&runId=${encodeURIComponent(runId)}`, 20000)
      detailTab = 'overview'
      if (insideBatch && selectedBatch && batchDetail) renderBatchDetail()
      else renderRunDetail()
    } catch (error) {
      selectedRun = null
      runDetail = null
      if (insideBatch && selectedBatch && batchDetail) {
        renderBatchDetail()
        return
      }
      root.innerHTML = header('巡检详情读取失败', '完整历史报告可能很大。') + empty('无法读取巡检详情', error instanceof Error ? error.message : String(error))
    }
  }

  function renderRunDetail() {
    const report = runDetail.report
    const definition = runDetail.definition
    const artifacts = runDetail.artifacts || []
    root.innerHTML = header('巡检详情', report.inspectionName || definition.name || report.inspectionId, '<button class="btn" data-action="close-run">← 返回</button>') + `<section class="card hero">
      <div>${pill(report.status)} <span class="chip">单次巡检</span></div><h2>${esc(report.inspectionName || definition.name)}</h2><p>${esc(report.summary || '本次巡检已完成，详细信息见下方。')}</p>
      <div class="tiny muted hero-time">${fmt(report.startedAt)} · ${dur(report.startedAt, report.finishedAt)}</div>
    </section>
    <div class="tabs">${[['overview', '概述'], ['steps', '步骤'], ['artifacts', '产物'], ['logs', '日志'], ['checklist', '任务清单']].map(([id, label]) => `<button class="tab ${detailTab === id ? 'active' : ''}" data-detail-tab="${id}">${label}</button>`).join('')}</div>
    ${detailContent(report, definition, artifacts)}`
  }

  function detailContent(report, definition, artifacts) {
    if (detailTab === 'steps') return stepsView(report)
    if (detailTab === 'artifacts') return artifactsView(artifacts)
    if (detailTab === 'logs') return logsView(report, definition)
    if (detailTab === 'checklist') return checklistView(report, definition)
    const rows = report.results || []
    const passed = rows.filter(item => item.status === 'passed').length
    return `<div class="detail-grid"><section class="card panel"><h3 class="section-title">本次巡检概述</h3><div class="overview-text">${esc(report.summary || '没有额外摘要。')}</div><div class="muted overview-progress">步骤完成 ${passed}/${rows.length}</div></section><section class="card panel"><h3 class="section-title">关键信息</h3>${info(targetLabelName(definition), targetLabel(definition))}${info('预期结果', report.expectedResult || definition.expectedResult || '—')}${info('开始时间', fmt(report.startedAt))}${info('结束时间', fmt(report.finishedAt))}${info('产物数量', String(artifacts.length))}</section></div>`
  }

  function checklistView(report, definition) {
    const items = Array.isArray(report?.taskChecklist) && report.taskChecklist.length
      ? report.taskChecklist
      : Array.isArray(definition?.metadata?.taskChecklist) ? definition.metadata.taskChecklist : []
    if (!items.length) return empty('暂无任务清单', '这个流程没有保存可核对的任务清单。')
    return `<section class="card panel"><h3 class="section-title">任务清单</h3><div class="muted" style="margin-bottom:12px">用于核对本次巡检应完成的业务动作；历史记录优先使用巡检开始时保存的清单快照。</div><ol style="margin:0;padding-left:24px;display:grid;gap:10px">${items.map(item => `<li>${esc(item)}</li>`).join('')}</ol></section>`
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
    if (artifact.preview === 'download') { window.open(artifact.url, '_blank', 'noopener'); return }
    const modal = document.createElement('div')
    modal.id = 'artifact-modal'
    modal.className = 'modal-bg'
    modal.innerHTML = `<div class="modal"><div class="modal-head"><b>${esc(artifact.name)}</b><button class="btn" data-action="close-modal">关闭</button></div><div id="modal-body" class="modal-body"><div class="loading modal-loading">正在加载…</div></div></div>`
    document.body.appendChild(modal)
    const body = document.getElementById('modal-body')
    if (!body) return
    if (artifact.preview === 'image') { body.innerHTML = `<img src="${esc(artifact.url)}" alt="${esc(artifact.name)}">`; return }
    try {
      const response = await fetch(artifact.url, { cache: 'no-store', credentials: 'same-origin' })
      let text = await response.text()
      if (artifact.mime?.startsWith('application/json')) { try { text = JSON.stringify(JSON.parse(text), null, 2) } catch {} }
      body.innerHTML = `<pre class="code modal-code">${esc(text)}</pre>`
    } catch (error) { body.innerHTML = empty('预览失败', error instanceof Error ? error.message : String(error)) }
  }

  async function refresh() {
    selectedRun = null
    runDetail = null
    selectedBatch = null
    batchDetail = null
    root.innerHTML = '<div class="loading"><div><div class="spinner"></div>正在刷新…</div></div>'
    try {
      const [nextCatalog, nextBatches] = await Promise.all([
        get(`/catalog?workspace=${encodeURIComponent(WORKSPACE)}`),
        loadBatchCatalog(),
      ])
      catalog = nextCatalog
      batchCatalog = nextBatches
      renderRecords()
    } catch (error) {
      root.innerHTML = header('刷新失败', 'Dashboard Host 没有及时返回数据。') + empty('无法刷新', error instanceof Error ? error.message : String(error))
    }
  }

  root?.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const action = target.closest('[data-action]')?.getAttribute('data-action')
    if (action === 'refresh') { void refresh(); return }
    if (action === 'close-run') { selectedRun = null; runDetail = null; detailTab = 'overview'; renderRecords(); window.scrollTo(0, 0); return }
    if (action === 'close-batch') { selectedBatch = null; batchDetail = null; selectedRun = null; runDetail = null; detailTab = 'overview'; renderRecords(); window.scrollTo(0, 0); return }
    if (action === 'batch-overview') { selectedRun = null; runDetail = null; detailTab = 'overview'; renderBatchDetail(); return }
    if (action === 'close-modal') { document.getElementById('artifact-modal')?.remove(); return }

    const child = target.closest('[data-batch-child-run][data-batch-child-inspection]')
    if (child) {
      void openRun(child.getAttribute('data-batch-child-inspection') || '', child.getAttribute('data-batch-child-run') || '', true)
      return
    }
    const batch = target.closest('[data-batch-id]')
    if (batch) { void openBatch(batch.getAttribute('data-batch-id') || ''); return }
    const run = target.closest('[data-run-id][data-run-inspection]')
    if (run) { void openRun(run.getAttribute('data-run-inspection') || '', run.getAttribute('data-run-id') || '', false); return }
    const tab = target.closest('[data-detail-tab]')
    if (tab && runDetail) {
      detailTab = tab.getAttribute('data-detail-tab') || 'overview'
      if (selectedBatch && batchDetail) renderBatchDetail(); else renderRunDetail()
      return
    }
    const artifact = target.closest('[data-artifact-token]')
    if (artifact) void previewArtifact(artifact.getAttribute('data-artifact-token') || '')
  })

  document.addEventListener('click', event => {
    const modal = document.getElementById('artifact-modal')
    if (!modal) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('[data-action="close-modal"]')) { modal.remove(); return }
    if (event.target === modal) modal.remove()
  })

  void boot()
})()

import { readFile } from 'node:fs/promises'
import { registerPatrolDashboardRoutes as registerBoundedDashboardRoutes } from './dashboard-fast.js'
import { registerPatrolDashboardManagementRoutes } from './dashboard-management.js'

const CLIENT_URL = new URL('./dashboard-client.js', import.meta.url)
const MANAGEMENT_CLIENT_URL = new URL('./dashboard-management-client.js', import.meta.url)

export { buildPatrolDashboardCatalog, parseLegacyMarkdownSummary } from './dashboard-fast.js'

export function registerPatrolDashboardRoutes(ctx, basePath, config = {}) {
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/dashboard`
  const uiPath = `${prefix}/ui`
  const proxyCtx = {
    webServer: {
      register(route) {
        if (route.path !== uiPath) return ctx.webServer.register(route)
        return ctx.webServer.register({
          kind: 'exact',
          path: uiPath,
          handler: async (req, res) => {
            if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
            const url = new URL(req.url || '/', 'http://127.0.0.1')
            if (url.searchParams.get('asset') === 'client') {
              const source = await readFile(CLIENT_URL, 'utf8')
              res.writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              })
              res.end(source)
              return
            }
            if (url.searchParams.get('asset') === 'management') {
              const source = await readFile(MANAGEMENT_CLIENT_URL, 'utf8')
              res.writeHead(200, {
                'content-type': 'text/javascript; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
              })
              res.end(source)
              return
            }

            const html = dashboardShell(prefix)
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
            })
            res.end(html)
          },
        })
      },
    },
  }

  const disposeDashboard = registerBoundedDashboardRoutes(proxyCtx, basePath, config)
  const disposeManagement = registerPatrolDashboardManagementRoutes(ctx, basePath, config)
  return () => {
    try { disposeManagement() } catch {}
    try { disposeDashboard() } catch {}
  }
}

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
}

function dashboardShell(prefix) {
  const clientSrc = `${prefix}/ui?asset=client`
  const managementSrc = `${prefix}/ui?asset=management`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Patrol</title>
<style>
:root{color-scheme:light;--bg:#f6f8fb;--surface:#fff;--text:#172033;--muted:#667085;--line:#e5e9f0;--primary:#2563eb;--pale:#eff6ff;--success:#087a55;--successbg:#ecfdf3;--danger:#c43225;--dangerbg:#fef3f2;--warn:#a15c09;--warnbg:#fffaeb;--shadow:0 8px 30px rgba(15,23,42,.055)}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg)}button,input,select{font:inherit}.app{padding:22px 26px 38px}.page{max-width:1380px;margin:auto}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.08em;color:var(--primary);margin-bottom:6px}.title{font-size:23px;margin:0}.sub{color:var(--muted);font-size:13px;line-height:1.6;margin-top:6px}.actions{display:flex;gap:8px;flex-wrap:wrap}.btn{height:36px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--text);padding:0 13px;font-size:13px;font-weight:650;cursor:pointer}.btn:hover{border-color:#c8d2e1}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}.panel{padding:18px}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:11px;margin:12px 0 20px}.stat{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat span,.muted{color:var(--muted)}.stat span{font-size:12px}.stat b{display:block;font-size:20px;margin-top:5px}.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:12px;font-weight:700}.pill:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.pill.passed,.pill.ready{background:var(--successbg);color:var(--success)}.pill.failed{background:var(--dangerbg);color:var(--danger)}.pill.waiting,.pill.draft{background:var(--warnbg);color:var(--warn)}.flow-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(285px,1fr));gap:14px}.flow-card{padding:18px;cursor:pointer;min-height:190px;display:flex;flex-direction:column;transition:.16s ease}.flow-card:hover{transform:translateY(-2px);border-color:#c9d6eb;box-shadow:0 14px 34px rgba(37,99,235,.08)}.flow-icon{width:42px;height:42px;border-radius:12px;background:var(--pale);color:var(--primary);display:grid;place-items:center;font-weight:800;margin-bottom:13px}.flow-head,.section-head,.node-head,.run-head{display:flex;justify-content:space-between;gap:10px}.flow-name{font-size:16px;font-weight:750}.flow-desc{font-size:13px;line-height:1.55;color:var(--muted);margin:7px 0 11px;min-height:40px}.flow-meta{border-top:1px solid var(--line);padding-top:12px;margin-top:auto;display:flex;justify-content:space-between;gap:8px;color:var(--muted);font-size:12px}.hero{padding:22px;margin-bottom:14px;background:linear-gradient(135deg,#fff,#f7faff)}.hero h2{font-size:22px;margin:8px 0}.hero p{color:var(--muted);line-height:1.7;margin:0}.hero-time{margin-top:10px}.meta-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:17px}.meta{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:rgba(255,255,255,.85)}.meta label{display:block;color:var(--muted);font-size:11px;margin-bottom:5px}.meta div{font-size:13px;font-weight:620;word-break:break-word}.detail-grid{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr);gap:14px}.section-title{font-size:15px;font-weight:750;margin:0 0 13px}.section-head .section-title{margin-bottom:0}.recent{margin-top:14px}.steps{position:relative}.step{display:grid;grid-template-columns:34px 1fr;gap:12px;padding-bottom:13px;position:relative}.step:not(:last-child):before{content:"";position:absolute;left:16px;top:32px;bottom:-2px;width:2px;background:#e4e9f2}.num{width:34px;height:34px;border-radius:50%;border:2px solid #a7c5f7;color:var(--primary);background:#f7faff;display:grid;place-items:center;font-size:12px;font-weight:750;z-index:1}.node{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff}.node summary{cursor:pointer;list-style:none}.node-name{font-size:13px;font-weight:720}.node-tool{margin-top:4px}.node-note{font-size:12px;line-height:1.55;margin-top:8px}.chip{display:inline-flex;background:#f2f4f7;color:#475467;font-size:11px;padding:3px 7px;border-radius:7px;margin:7px 5px 0 0}.toolbar{display:grid;grid-template-columns:minmax(220px,1fr) 160px 180px auto;gap:10px;margin-bottom:12px}.control{height:38px;border:1px solid var(--line);border-radius:10px;background:#fff;padding:0 11px;outline:none}.count{font-size:12px;align-self:center;text-align:right}.table-wrap{overflow:auto}.table{width:100%;border-collapse:collapse;font-size:13px}.table th{background:#f8fafc;color:#667085;font-size:11px;text-align:left;padding:11px 13px;white-space:nowrap;border-bottom:1px solid var(--line)}.table td{padding:12px 13px;border-bottom:1px solid #edf0f4;vertical-align:middle}.table tbody tr{cursor:pointer}.table tbody tr:hover{background:#fafcff}.summary{max-width:390px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#475467}.tiny{font-size:11px}.truncate{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nowrap{white-space:nowrap}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:14px}.tab{border:0;background:transparent;padding:10px 13px;color:var(--muted);font-size:13px;font-weight:680;border-bottom:2px solid transparent;cursor:pointer}.tab.active{color:var(--primary);border-bottom-color:var(--primary)}.timeline .row{display:grid;grid-template-columns:18px 1fr;gap:12px;position:relative;padding-bottom:14px}.timeline .row:not(:last-child):before{content:"";position:absolute;left:8px;top:18px;bottom:-2px;width:1px;background:var(--line)}.dot{width:17px;height:17px;border-radius:50%;border:4px solid #d0d5dd;background:#fff;z-index:1}.row.passed .dot{border-color:#6ce0b0}.row.failed .dot{border-color:#fda29b}.runbox{border:1px solid var(--line);border-radius:11px;padding:12px 14px;background:#fff}.run-time{margin-top:7px}.output{white-space:pre-wrap;max-height:110px;overflow:hidden;color:#475467;font-size:12px;line-height:1.6;margin-top:8px}.output.error{color:var(--danger)}.artifact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(225px,1fr));gap:12px}.artifact{overflow:hidden}.preview{height:130px;background:#f2f4f7;display:grid;place-items:center;border-bottom:1px solid var(--line)}.preview img{width:100%;height:100%;object-fit:cover}.file-icon{font-size:28px}.artifact-info{padding:12px}.artifact-meta{margin-top:4px}.artifact-open{margin-top:10px}.log{border:1px solid var(--line);border-radius:11px;background:#fff;margin-bottom:9px;overflow:hidden}.log summary{padding:12px 14px;cursor:pointer;font-weight:680;display:flex;justify-content:space-between}.code{margin:0;border-top:1px solid var(--line);background:#0f172a;color:#dbeafe;padding:14px;white-space:pre-wrap;word-break:break-word;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;max-height:360px;overflow:auto}.loading{height:55vh;display:grid;place-items:center;color:var(--muted)}.spinner{width:24px;height:24px;border:3px solid #dbe4f2;border-top-color:var(--primary);border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px}@keyframes spin{to{transform:rotate(360deg)}}.empty{text-align:center;padding:54px 20px}.empty-title{font-weight:720}.empty-sub{font-size:12px;margin-top:7px}.empty-inline{font-size:12px;padding:8px 0}.notice{padding:10px 13px;border:1px solid #f2d49b;background:#fffbeb;color:#8a4b08;border-radius:10px;font-size:12px;margin-bottom:12px}.info-row{padding:10px 0;border-bottom:1px solid var(--line)}.info-value{font-size:13px;font-weight:620;margin-top:4px;word-break:break-word}.overview-text{line-height:1.75;font-size:13px}.overview-progress{font-size:12px;margin-top:12px}.modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.5);display:grid;place-items:center;padding:28px;z-index:20}.modal{width:min(1000px,96vw);max-height:90vh;overflow:auto;background:#fff;border-radius:16px}.modal-head{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:13px 16px;display:flex;justify-content:space-between;align-items:center}.modal-body{padding:16px}.modal-body img{max-width:100%;display:block;margin:auto;border-radius:10px}.modal-loading{height:180px}.modal-code{border-radius:10px;max-height:70vh}
@media(max-width:900px){.app{padding:17px}.stats{grid-template-columns:repeat(2,1fr)}.meta-grid,.detail-grid{grid-template-columns:1fr}.toolbar{grid-template-columns:1fr 1fr}.toolbar input{grid-column:1/-1}.top{flex-direction:column}}
</style>
</head>
<body><main class="app"><div id="root" class="page"><div class="loading"><div><div class="spinner"></div>正在初始化巡检面板…</div></div></div></main><noscript>巡检面板需要启用 JavaScript。</noscript><script src="${clientSrc}" defer></script><script src="${managementSrc}" defer></script></body>
</html>`
}

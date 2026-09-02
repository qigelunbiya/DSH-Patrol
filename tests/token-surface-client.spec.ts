import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const clientSource = readFileSync(join(process.cwd(), 'client-host-runtime', 'client.js'), 'utf8')

describe('Patrol token client surface', () => {
  it('opens directly from the sidebar entry instead of depending only on a footer-slot event listener', () => {
    expect(clientSource).toContain('function mountTokenSidebarEntry(openTokenSurface)')
    expect(clientSource).toContain("if (typeof openTokenSurface === 'function' && openTokenSurface()) return;")
    expect(clientSource).toContain('const entryDispose = mountTokenSidebarEntry(openTokenTab);')
  })

  it('uses a content open so Better Sidebar expands a collapsed panel', () => {
    expect(clientSource).toContain("betterSidebar.openTab({ type: TOTP_TAB_ID, title: '令牌', path: 'dsh-patrol://totp' });")
  })

  it('keeps the existing dialog event as a fallback when Better Sidebar is unavailable', () => {
    expect(clientSource).toContain('window.dispatchEvent(new Event(TOTP_OPEN_EVENT));')
    expect(clientSource).toContain('TokenDialogBridge')
  })

  it('imports QR images through the local Patrol decoder without requiring BarcodeDetector', () => {
    expect(clientSource).toContain('function readFileDataUrl(file)')
    expect(clientSource).toContain("totpPost('import-image', csrf")
    expect(clientSource).toContain('Authing 导出二维码')
    expect(clientSource).toContain('Google Authenticator 迁移二维码')
    expect(clientSource).not.toContain('window.BarcodeDetector')
  })
})
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('atomic semantic click extension layer', () => {
  it('advertises the semanticClick protocol capability', () => {
    const source = readFileSync(join(root, 'browser-extension', 'background.js'), 'utf8')
    const advertised = /EXTENSION_CAPABILITIES[\s\S]*['\"]semanticClick['\"]/.test(source)
    expect(advertised).toBe(true)
  })

  it('is loaded immediately after the core bridge and parses as JavaScript', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(entry).toContain("importScripts('semantic-click.js')")
    expect(entry.indexOf("importScripts('semantic-click.js')")).toBeGreaterThan(entry.indexOf("importScripts('background.js')"))
    expect(entry.indexOf("importScripts('semantic-click.js')")).toBeLessThan(entry.indexOf("importScripts('frame-registration.js')"))
    expect(() => new Function(source)).not.toThrow()
  })

  it('keeps semantic resolution and click inside one command without content-script messaging', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain("cmd === 'semanticClick'")
    expect(source).toContain("world: 'MAIN'")
    expect(source).toContain("'probe'")
    expect(source).toContain("'click'")
    expect(source).toContain("'measure'")
    expect(source).toContain('expectedFingerprint')
    expect(source).toContain('semanticTrustedMouseClick')
    expect(source).toContain("'Input.dispatchMouseEvent'")
    expect(source).toContain("'atomic-semantic+trusted-native-mouse'")
    expect(source).not.toContain('chrome.tabs.sendMessage')
    expect(source).toContain('semanticClickTabBaseline')
    expect(source).toContain('semanticClickAdoptSingleOpenedTab')
    expect(source).toContain('openedTabId')
    expect(source).toContain("chrome.tabs.update(opened.id, { active: true })")
  })

  it('contains row-context scoring for host identity plus RDP-style actions', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain('ipTokens')
    expect(source).toContain('actionTokens')
    expect(source).toMatch(/closest\?\.\('tr,li,form,nav/)
    expect(source).toContain('context.includes(token)')
  })

  it('can resolve title-backed custom tree nodes such as Ant Design tree labels', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain("'[role=\"treeitem\"]'")
    expect(source).toContain("'.ant-tree-node-content-wrapper'")
    expect(source).toContain("'[title]'")
    expect(source).toContain("'aria-label', 'title'")
    expect(source).toContain('titleText === wantedText')
    expect(source).toContain("const globalExactTitleCandidates = wantedText")
    expect(source).toContain("deepQueryAll('[title]')")
    expect(source).toContain('const uniqueExactTitleTarget = globalExactTitleCandidates.length === 1')
    expect(source).toContain('const exactTitleCandidates = wantedText')
    expect(source).toContain('const candidatePool = uniqueExactTitleTarget !== null')
    expect(source).toContain("[uniqueExactTitleTarget]")
    expect(source).toContain("'unique-exact-title->ant-tree-wrapper'")
    expect(source).toContain('const scored = candidatePool.map(element =>')
    expect(source).toContain('const physicalClickTarget = element =>')
    expect(source).toContain("element.closest?.('.ant-tree-node-content-wrapper,[role=\"treeitem\"]')")
    expect(source).toContain('const clickTarget = physicalClickTarget(element)')
    expect(source).toContain('const stateSignature = element =>')
    expect(source).toContain('statefulClasses')
    expect(source).toContain('targetStateChanged')
    expect(source).toContain("element.getAttribute?.('placeholder')")
    expect(source).toContain("'[contenteditable=\"true\"]'")
  })

  it('matches the observed enterprise Ant-tree shape: one titled leaf drives its click-listener wrapper', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')
    // Observed DOM:
    // span.name[title="未分组"] -> ... -> span.ant-tree-node-content-wrapper
    // with the click listener on the wrapper.
    expect(source).toContain("normalize(element.getAttribute?.('title') || '') !== wantedText")
    expect(source).toContain("element.closest?.('.ant-tree-node-content-wrapper,[role=\"treeitem\"]')")
    expect(source).toContain('const clickTarget = physicalClickTarget(element)')
    expect(source).toContain("typeof clickTarget.click === 'function'")
  })

  it('replays a persisted titled Ant-tree leaf through its clickable wrapper without broad ancestor promotion', () => {
    const source = readFileSync(join(root, 'browser-extension', 'content.js'), 'utf8')
    expect(source).toContain('function effectiveClickTarget(element)')
    expect(source).toContain("element.closest?.('.ant-tree-node-content-wrapper,[role=\"treeitem\"]')")
    expect(source).toContain('if (!title) return element')
    expect(source).toContain('element = effectiveClickTarget(element)')
  })

  it('promotes a titled card heading to its real interactive ancestor', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain('interactiveAncestorSelector')
    expect(source).toContain("'a[href]'")
    expect(source).toContain('const interactive = element.closest?.(interactiveAncestorSelector)')
    expect(source).toContain('const persistedClickTarget = (element, clickTarget) =>')
    expect(source).toContain('return treeWrapper === clickTarget ? element : clickTarget')
    expect(source).toContain('selector: stableSelector(persistedTarget)')
    expect(source).toContain('role: roleOf(clickTarget) || chosen.role')
    expect(source).toContain('tag: clickTarget.tagName.toLowerCase()')
  })

  it('can discover a plain image or SVG logo even when it has no link/button wrapper', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain("'img', 'svg'")
    expect(source).toContain("'[id*=\"logo\" i]'")
    expect(source).toContain("'[class*=\"logo\" i]'")
    expect(source).toContain("element instanceof HTMLImageElement")
    expect(source).toContain("deepQueryAll('img,svg', element)")
  })

  it('falls back to CDP-pierced closed Shadow DOM editors when MAIN-world semantic search cannot see them', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')
    expect(source).toContain("typeof interactionResolvePiercedEditablePoint === 'function'")
    expect(source).toContain('await interactionResolvePiercedEditablePoint')
    expect(source).toContain("'cdp-pierced::textbox'")
    expect(source).toContain("'atomic-semantic+cdp-pierced-shadow+trusted-native-mouse'")
    expect(source).toContain('replaySelectorSafe: false')
  })

  it('searches open shadow DOM and prioritizes real comment editors', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')
    expect(source).toContain('const deepQueryAll = (selector, startRoot = document) =>')
    expect(source).toContain('element?.shadowRoot')
    expect(source).toContain("'[role=\"textbox\"]'")
    expect(source).toContain("'bili-comment-editor'")
    expect(source).toContain('const wantsCommentEditor =')
    expect(source).toContain('editableCandidate(element)')
    expect(source).toContain('const shadowHostContext = element =>')
    expect(source).toContain('parts.push(element.innerText, element.textContent, shadowHostContext(element))')
    expect(source).not.toContain("/(?:editor|input|textarea)/i.test(String(element?.tagName || ''))")
    expect(source).toContain('replaySelectorSafe: !(persistedTarget.getRootNode?.() instanceof ShadowRoot)')
  })


  it('uses bounded card context so visible Bilibili titles can identify the correct card without broad page text', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')
    expect(source).toContain('const localizedCardText = element =>')
    expect(source).toContain('interactiveCount <= 4')
    expect(source).toContain('localCardNorm')
    expect(source).toContain('localCardNorm.includes(wantedText)')
    expect(source).toContain("'h1', 'h2', 'h3', 'h4', '[class*=\"title\" i]'")
  })

  it('prefers a localized comment editor/activator and can follow it to the mounted textbox', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')
    expect(source).toContain("if (wantsCommentEditor && tag === 'bili-comments') return null")
    expect(source).toContain('localizedCommentEditorActivator(element)')
    expect(source).toContain("pierced.kind === 'activator'")
    expect(source).toContain("mounted?.kind === 'editable'")
    expect(source).toContain("'cdp-pierced::editor-activator'")
  })

})

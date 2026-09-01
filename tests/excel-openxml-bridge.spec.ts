import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const bridge = resolve('excel-runtime/openxml_bridge.py')

const CREATE_FIXTURE = String.raw`
import sys, zipfile
path = sys.argv[1]
parts = {
'[Content_Types].xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>''',
'_rels/.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>''',
'xl/workbook.xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>''',
'xl/_rels/workbook.xml.rels': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>''',
'xl/styles.xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf>
</cellXfs>
</styleSheet>''',
'xl/worksheets/sheet1.xml': '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:J18"/>
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>项目名称</t></is></c><c r="B1" t="inlineStr"><is><t>类型</t></is></c><c r="C1" t="inlineStr"><is><t>负责人</t></is></c><c r="D1" t="inlineStr"><is><t>本周工作进度</t></is></c><c r="E1" t="inlineStr"><is><t>下周工作计划</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>测试项目</t></is></c><c r="B2" t="inlineStr"><is><t>需求分析</t></is></c><c r="C2" t="inlineStr"><is><t>方泽铭</t></is></c><c r="D2" s="1"/><c r="E2" s="1"/></row>
<row r="3"><c r="B3" t="inlineStr"><is><t>代码开发</t></is></c><c r="C3" t="inlineStr"><is><t>方泽铭</t></is></c><c r="D3" s="1"/><c r="E3" s="1"/></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>测试部署</t></is></c><c r="C4" t="inlineStr"><is><t>方泽铭</t></is></c><c r="D4" s="1"/><c r="E4" s="1"/></row>
<row r="18"><c r="J18" t="inlineStr"><is><t>d</t></is></c></row>
</sheetData>
<mergeCells count="1"><mergeCell ref="A2:A4"/></mergeCells>
</worksheet>'''
}
with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
    for name, data in parts.items(): z.writestr(name, data.encode('utf-8'))
`

async function runBridge(payloadPath: string) {
  const { stdout, stderr } = await execFileAsync('python', [bridge, payloadPath], { encoding: 'utf8' })
  if (stderr.trim()) throw new Error(stderr)
  return JSON.parse(stdout.trim())
}

async function runBridgeFailure(payloadPath: string) {
  try {
    await execFileAsync('python', [bridge, payloadPath], { encoding: 'utf8' })
    throw new Error('expected bridge failure')
  } catch (error: any) {
    return `${error?.stderr ?? ''}${error?.message ?? ''}`
  }
}

describe('OpenXML Excel bridge', () => {
  it('inspects and writes blank styled cells without changing template labels or merges', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-openxml-test-'))
    try {
      const workbook = join(temp, 'weekly_report.xlsx')
      await execFileAsync('python', ['-c', CREATE_FIXTURE, workbook], { encoding: 'utf8' })

      const inspectPayload = join(temp, 'inspect.json')
      await writeFile(inspectPayload, JSON.stringify({ operation: 'inspect', filePath: workbook, maxRows: 40, maxColumns: 20 }), 'utf8')
      const first = await runBridge(inspectPayload)
      expect(first.sheetNames).toEqual(['Sheet1'])
      expect(first.sheets[0].merges).toContain('A2:A4')
      expect(first.sheets[0].cells.find((cell: any) => cell.address === 'D2')).toMatchObject({ text: '', wrapText: true })
      expect(first.sheets[0].cells.find((cell: any) => cell.address === 'J18')?.text).toBe('d')

      const writePayload = join(temp, 'write.json')
      await writeFile(writePayload, JSON.stringify({
        operation: 'write',
        filePath: workbook,
        sheetName: 'Sheet1',
        updates: [
          { cell: 'D3', value: '完成自动巡检修复', valueType: 'text' },
          { cell: 'E3', value: '继续联调', valueType: 'text', copyFormatFrom: 'D3' },
        ],
      }), 'utf8')
      const written = await runBridge(writePayload)
      expect(written.written.map((item: any) => item.cell)).toEqual(['D3', 'E3'])

      const second = await runBridge(inspectPayload)
      expect(second.sheets[0].merges).toContain('A2:A4')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'D3')).toMatchObject({ text: '完成自动巡检修复', wrapText: true })
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'E3')).toMatchObject({ text: '继续联调', wrapText: true })
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'A1')?.text).toBe('项目名称')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'B1')?.text).toBe('类型')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'C1')?.text).toBe('负责人')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'D1')?.text).toBe('本周工作进度')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'E1')?.text).toBe('下周工作计划')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'J18')?.text).toBe('d')

      const bytes = await readFile(workbook)
      expect(bytes.subarray(0, 2).toString()).toBe('PK')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('refuses accidental header overwrite and merged-interior writes', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-openxml-guard-'))
    try {
      const workbook = join(temp, 'weekly_report.xlsx')
      await execFileAsync('python', ['-c', CREATE_FIXTURE, workbook], { encoding: 'utf8' })

      const overwritePayload = join(temp, 'overwrite.json')
      await writeFile(overwritePayload, JSON.stringify({
        operation: 'write', filePath: workbook, sheetName: 'Sheet1',
        updates: [{ cell: 'B1', value: '任务总数', valueType: 'text' }],
      }), 'utf8')
      expect(await runBridgeFailure(overwritePayload)).toMatch(/refusing to overwrite non-empty template cell B1/i)

      const mergePayload = join(temp, 'merge.json')
      await writeFile(mergePayload, JSON.stringify({
        operation: 'write', filePath: workbook, sheetName: 'Sheet1',
        updates: [{ cell: 'A3', value: '不应写入', valueType: 'text' }],
      }), 'utf8')
      expect(await runBridgeFailure(mergePayload)).toMatch(/inside merged range A2:A4.*top-left cell A2/i)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('allows only a guarded non-empty overwrite with the exact inspected value', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-openxml-overwrite-'))
    try {
      const workbook = join(temp, 'weekly_report.xlsx')
      await execFileAsync('python', ['-c', CREATE_FIXTURE, workbook], { encoding: 'utf8' })

      const wrongPayload = join(temp, 'wrong.json')
      await writeFile(wrongPayload, JSON.stringify({
        operation: 'write', filePath: workbook, sheetName: 'Sheet1',
        updates: [{ cell: 'B2', value: '开发', valueType: 'text', allowOverwriteExisting: true, expectedCurrentText: '错误旧值' }],
      }), 'utf8')
      expect(await runBridgeFailure(wrongPayload)).toMatch(/expectedCurrentText=.*actual=.*需求分析/i)

      const correctPayload = join(temp, 'correct.json')
      await writeFile(correctPayload, JSON.stringify({
        operation: 'write', filePath: workbook, sheetName: 'Sheet1',
        updates: [{ cell: 'B2', value: '开发', valueType: 'text', allowOverwriteExisting: true, expectedCurrentText: '需求分析' }],
      }), 'utf8')
      const written = await runBridge(correctPayload)
      expect(written.written[0]).toMatchObject({ cell: 'B2', text: '开发', previousText: '需求分析' })
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})

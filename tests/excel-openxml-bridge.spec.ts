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
<row r="1"><c r="A1" t="inlineStr"><is><t>项目名称</t></is></c><c r="D1" t="inlineStr"><is><t>本周工作进度</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>测试项目</t></is></c><c r="D2" s="1"/></row>
<row r="3"><c r="D3" s="1"/></row>
<row r="4"><c r="D4" s="1"/></row>
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

describe('OpenXML Excel bridge', () => {
  it('inspects and writes a styled merged weekly-report-like xlsx without Excel COM', async () => {
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
          { cell: 'D2', value: '完成自动巡检修复', valueType: 'text' },
          { cell: 'E2', value: '继续联调', valueType: 'text', copyFormatFrom: 'D2' },
        ],
      }), 'utf8')
      const written = await runBridge(writePayload)
      expect(written.written.map((item: any) => item.cell)).toEqual(['D2', 'E2'])

      const second = await runBridge(inspectPayload)
      expect(second.sheets[0].merges).toContain('A2:A4')
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'D2')).toMatchObject({ text: '完成自动巡检修复', wrapText: true })
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'E2')).toMatchObject({ text: '继续联调', wrapText: true })
      expect(second.sheets[0].cells.find((cell: any) => cell.address === 'J18')?.text).toBe('d')

      const bytes = await readFile(workbook)
      expect(bytes.subarray(0, 2).toString()).toBe('PK')
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })
})

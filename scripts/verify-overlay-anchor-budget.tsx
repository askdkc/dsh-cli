/** Root model-dialog geometry and OverlayAbove budget regressions. Run: node --import tsx/esm scripts/verify-overlay-anchor-budget.tsx */
process.env.FORCE_COLOR = '3'
process.env.TERM_PROGRAM = 'WezTerm'
process.env.DSH_CLI_THEME = 'dark'
process.env.DSH_CLI_LANG ??= 'zh'

const [{ PassThrough, Writable }, React, { Terminal }, { render, Box, Text, AlternateScreen }, { ModelDialogLayer }, { ModelPicker }, { overlaySpaceAbove, clampOverlayHeight }, { settled, viewportLines }] = await Promise.all([
  import('node:stream'), import('react'), import('@xterm/headless'), import('../src/ui.js'),
  import('../src/components/ModelDialogLayer.js'), import('../src/components/ModelPicker.js'),
  import('../src/components/overlayBudget.js'), import('./lib/term-test.mjs'),
])
import assert from 'node:assert/strict'

assert.equal(overlaySpaceAbove({ anchorTop: 20, rootHeight: 48, terminalRows: 48 }), 20)
assert.equal(overlaySpaceAbove({ anchorTop: 60, rootHeight: 62, terminalRows: 48 }), 45)
assert.equal(overlaySpaceAbove({ anchorTop: 3, rootHeight: 80, terminalRows: 48 }), 0)
assert.equal(clampOverlayHeight(40, 45), 40)
assert.equal(clampOverlayHeight(40, 12), 12)
assert.equal(clampOverlayHeight(40, undefined), 40)
assert.equal(clampOverlayHeight(undefined, undefined), undefined)
assert.equal(clampOverlayHeight(undefined, 9), 9)
assert.equal(clampOverlayHeight(40, 0), 1)

for (const [columns, rows, transcriptRows, fullscreen, alternate] of [
  [80, 24, 18, false, false], [60, 15, 12, false, false], [40, 10, 4, false, true],
  [80, 24, 18, true, false], [60, 15, 12, true, false], [40, 10, 4, true, false],
] as const) {
  const term = new Terminal({ cols: columns, rows, scrollback: 500, allowProposedApi: true })
  let output = ''
  class Stdout extends Writable {
    columns = columns; rows = rows; isTTY = true
    _write(chunk: unknown, _encoding: BufferEncoding, callback: () => void): void {
      output += String(chunk)
      term.write(String(chunk), callback)
    }
  }
  class Stderr extends Writable { isTTY = true; _write(_chunk: unknown, _encoding: BufferEncoding, callback: () => void): void { callback() } }
  class Stdin extends PassThrough { isTTY = true; setRawMode(): this { return this }; ref(): this { return this }; unref(): this { return this } }
  const model = { provider: 'deepseek', id: 'deepseek-v4', name: 'DeepSeek V4' }
  const pickerRows = [{ kind: 'heading' as const, key: 'heading:deepseek', label: 'DeepSeek' },
    { kind: 'model' as const, key: 'deepseek/deepseek-v4', section: 'deepseek', model, providerName: 'DeepSeek' }]
  function Screen(): React.ReactNode {
    const [fallback, setFallback] = React.useState(false)
    const picker = (height: number) => React.createElement(ModelPicker, { rows: pickerRows, focusIndex: 1, currentModel: 'deepseek/deepseek-v4', favorites: [],
      query: '', cursor: 0, height, status: 'ready', switching: false, onPick: () => {}, onWheelStep: () => {} })
    if (fallback) return React.createElement(AlternateScreen, null,
      React.createElement(Box, { width: '100%', height: rows, alignItems: 'center', justifyContent: 'center' },
        React.createElement(Box, { width: Math.min(72, columns - 2), height: Math.min(26, rows - 2) }, picker(Math.min(26, rows - 2)))))
    return React.createElement(Box, { flexDirection: 'column', width: '100%', height: fullscreen ? rows : undefined },
      ...Array.from({ length: transcriptRows }, (_, index) => React.createElement(Text, { key: index }, `transcript-${index}`)),
      React.createElement(ModelDialogLayer, { fullscreen, onClose: () => {}, onInsufficientSpace: () => setFallback(true) }, size => picker(size.rows)))
  }
  const instance = await render(React.createElement(Screen),
    { stdout: new Stdout() as never, stderr: new Stderr() as never, stdin: new Stdin() as never, exitOnCtrlC: false, patchConsole: false })
  try {
    assert.equal(await settled(() => viewportLines(term, rows).some(line => line.includes('DeepSeek V4'))), true,
      `${columns}x${rows}: ${JSON.stringify(viewportLines(term, rows))}`)
    const lines = viewportLines(term, rows)
    assert.equal(lines.some(line => line.includes(process.env.DSH_CLI_LANG === 'en' ? 'Model' : '模型')), true)
    assert.equal(lines.some(line => line.includes('❯')), true)
    assert.equal(output.includes('\x1b[?1049h'), alternate)
    if (process.env.CAPTURE_MODEL_DIALOG && columns === 80 && rows === 24 && !fullscreen) {
      const { writeFileSync } = await import('node:fs')
      const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
      const palette = ['#20232b', '#d75f5f', '#86b78b', '#d6aa6e', '#769ee3', '#b58bd0', '#7bb9c0', '#d8dce4']
      const color = (value: number, rgb: boolean, fallback: string) => rgb ? `#${value.toString(16).padStart(6, '0')}` : palette[value % 8] ?? fallback
      const cellWidth = 9
      const cells: string[] = []
      for (let y = 0; y < rows; y++) {
        const line = term.buffer.active.getLine(term.buffer.active.viewportY + y)
        for (let x = 0; x < columns; x++) {
          const cell = line?.getCell(x)
          if (!cell || cell.getWidth() === 0) continue
          if (!cell.isBgDefault()) cells.push(`<rect x="${x * cellWidth}" y="${y * 20}" width="${cellWidth * cell.getWidth()}" height="20" fill="${color(cell.getBgColor(), cell.isBgRGB(), '#171b24')}"/>`)
          const value = cell.getChars()
          if (value.trim()) cells.push(`<text x="${x * cellWidth}" y="${y * 20 + 15}" fill="${cell.isFgDefault() ? '#e3e7ef' : color(cell.getFgColor(), cell.isFgRGB(), '#e3e7ef')}" font-family="Menlo,monospace" font-size="15">${escape(value)}</text>`)
        }
      }
      writeFileSync(process.env.CAPTURE_MODEL_DIALOG, `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cellWidth}" height="480" viewBox="0 0 ${columns * cellWidth} 480"><rect width="${columns * cellWidth}" height="480" fill="#171b24"/>${cells.join('')}</svg>`)
    }
  } finally { instance.unmount() }
  if (alternate) assert.equal(await settled(() => output.includes('\x1b[?1049l')), true)
}
console.log('verify-overlay-anchor-budget: passed')

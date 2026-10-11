/** Human command grammar; protocol validation remains at the consumer boundary. */
import type { CodeAnalysisRequest } from './adapter/ports/code-intelligence.js'

export const CODE_COMMAND_HELP = [
  '/code status · /code cancel',
  '/code outline <path> · /code diagnostics <path>',
  '/code query <declarations|calls|imports> <path>',
  '/code <enclosing|span|definition|references|implementation|hover|completion> <path> <line> <character>',
  'Positions are zero-based UTF-16. Reads use disk snapshots and never apply edits.',
]
export function parseCodeCommand(input: string): CodeAnalysisRequest | undefined {
  const match = /^(\S+)\s+(.+)$/u.exec(input.trim())
  if (!match) return undefined
  const [, kind, tail] = match
  if (kind === 'outline') return { path: tail, structure: { method: 'structure.outline' } }
  if (kind === 'diagnostics') return { path: tail, semantic: { kind } }
  if (kind === 'query') {
    const query = /^(declarations|calls|imports)\s+(.+)$/u.exec(tail)
    return query ? { path: query[2], structure: { method: 'structure.query', queryId: query[1] as 'declarations' | 'calls' | 'imports' } } : undefined
  }
  const cursor = /^(.+)\s+(\d+)\s+(\d+)$/u.exec(tail)
  if (!cursor) return undefined
  const position = { line: Number(cursor[2]), character: Number(cursor[3]) }
  if (!Number.isSafeInteger(position.line) || !Number.isSafeInteger(position.character)) return undefined
  if (kind === 'enclosing') return { path: cursor[1], structure: { method: 'structure.enclosing', position } }
  if (kind === 'span') return { path: cursor[1], span: { position } }
  if (!['definition', 'references', 'implementation', 'hover', 'completion'].includes(kind)) return undefined
  return { path: cursor[1], semantic: { kind: kind as 'definition' | 'references' | 'implementation' | 'hover' | 'completion', position } }
}

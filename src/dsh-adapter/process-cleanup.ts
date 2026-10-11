import { execFileSync } from 'node:child_process'

type ProcessIdentity = { pid: number; parent: number; started: string }

/** Retain identities before disposal can orphan children by exiting their parents. */
export function captureOwnedProcesses(): ProcessIdentity[] {
  return descendants(readProcessTable())
}

/** Kill remaining descendants, including captured children that have been reparented. */
export function killOwnedProcesses(captured: readonly ProcessIdentity[]): void {
  const table = readProcessTable()
  const live = new Map(table.map(entry => [entry.pid, entry]))
  const owned = new Map([...captured, ...descendants(table)].map(entry => [entry.pid, entry]))
  const failures: unknown[] = []
  // Children precede their parents so a surviving shell cannot orphan its workers.
  for (const entry of [...owned.values()].reverse()) {
    if (live.get(entry.pid)?.started !== entry.started) continue
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Could not terminate all dsh-cli child processes')
}

function descendants(table: readonly ProcessIdentity[]): ProcessIdentity[] {
  const owned = new Set([process.pid])
  const result: ProcessIdentity[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const entry of table) {
      if (!owned.has(entry.parent) || owned.has(entry.pid)) continue
      owned.add(entry.pid)
      result.push(entry)
      grew = true
    }
  }
  return result
}

/** Read only process identities; start times prevent signalling a reused PID. */
function readProcessTable(): ProcessIdentity[] {
  if (process.platform === 'win32') {
    const output = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | Select-Object ProcessId,ParentProcessId,@{Name="Started";Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}} | ConvertTo-Json -Compress',
    ], { encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const parsed: unknown = JSON.parse(output)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.map((row: unknown) => {
      if (row === null || typeof row !== 'object') throw new Error('Invalid Windows process identity')
      const entry = row as Record<string, unknown>
      if (!Number.isSafeInteger(entry.ProcessId) || !Number.isSafeInteger(entry.ParentProcessId) || typeof entry.Started !== 'string' || entry.Started === '') {
        throw new Error('Invalid Windows process identity')
      }
      return { pid: entry.ProcessId as number, parent: entry.ParentProcessId as number, started: entry.Started }
    })
  }
  const output = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
    encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return output.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (match === null) throw new Error('Invalid process identity')
    return { pid: Number(match[1]), parent: Number(match[2]), started: match[3]! }
  })
}

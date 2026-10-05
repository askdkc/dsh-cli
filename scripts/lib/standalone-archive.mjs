import { c as createTar } from 'tar'

/** Write a complete gzip archive before returning; filesystem errors propagate. */
export function createStandaloneArchive(file, cwd, entries) {
  // tar 7.5.x async Pack can deadlock on pnpm hardlinks when lstat completes
  // out of order (node-tar #460). The build already runs sequentially.
  createTar({
    file, cwd, gzip: true, sync: true, strict: true,
    filter: (_path, stat) => {
      // Windows file indexes may exceed Number's precision (node-tar #431).
      // Store those files in full rather than aliasing distinct file contents.
      if (!Number.isSafeInteger(stat.ino)) stat.nlink = 1
      return true
    },
  }, entries)
}

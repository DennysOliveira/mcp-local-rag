// Shared filesystem walker for `list_files` (MCP tool) and `list` (CLI subcommand).
//
// Walks BASE_DIR recursively for files matching a given extension set, then filters by:
//   1. Explicit excludePaths (absolute prefixes — typically DB and model cache dirs)
//   2. BASE_DIR/.gitignore patterns (read at runtime; graceful no-op when absent)
//   3. .git/ (always excluded as a baseline)
//
// Returns sorted absolute paths. Single source of truth so the MCP tool and CLI
// stay in sync as ignore semantics evolve.

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import ignore from 'ignore'

export interface WalkOptions {
  /** Absolute path to the base directory. Caller is responsible for resolution. */
  baseDir: string
  /** Lowercase extensions including leading dot, e.g. new Set(['.md', '.mdx']). */
  extensions: Set<string>
  /** Absolute path prefixes (with trailing path separator) to skip. */
  excludePaths: string[]
}

/**
 * List supported files under baseDir, applying extension, excludePath, and
 * .gitignore filters. Returns absolute paths, sorted ascending.
 */
export async function walkSupportedFiles(opts: WalkOptions): Promise<string[]> {
  const baseDir = resolve(opts.baseDir)
  const { extensions, excludePaths } = opts

  // Build the ignore matcher. .git/ is always excluded; .gitignore augments it.
  const patterns: string[] = ['.git/']
  try {
    const content = await readFile(join(baseDir, '.gitignore'), 'utf-8')
    for (const line of content.split(/\r?\n/)) patterns.push(line)
  } catch {
    // No .gitignore — proceed with the .git/ baseline only.
  }
  const ig = ignore().add(patterns)

  const entries = await readdir(baseDir, { recursive: true, withFileTypes: true })
  const out: string[] = []
  for (const e of entries) {
    if (!e.isFile()) continue
    if (!extensions.has(extname(e.name).toLowerCase())) continue
    const full = join(e.parentPath, e.name)
    if (excludePaths.some((ep) => full.startsWith(ep))) continue
    const rel = relative(baseDir, full)
    if (!rel || rel.startsWith('..')) continue
    // `ignore` library expects POSIX-style separators.
    const relPosix = sep === '/' ? rel : rel.split(sep).join('/')
    if (ig.ignores(relPosix)) continue
    out.push(full)
  }
  out.sort()
  return out
}

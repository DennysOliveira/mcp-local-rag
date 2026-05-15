// CLI compact subcommand — run table.optimize() to prune stale index/version files.
//
// Bulk ingest writes a new index snapshot per call. Over hundreds of ingests
// these accumulate on disk and dwarf the live data. table.optimize() prunes
// them. Exposed as a first-class subcommand so users can run it manually or
// from a cron/git hook.
//
// NOTE: cleanupOlderThan must be `new Date()`, not `new Date(0)`. The JS
// binding interprets the value as "ms ago from now" (`now.getTime() - given`),
// so `new Date()` → 0ms-ago → matches everything, while `new Date(0)` →
// 57-years-ago → matches nothing.

import { execSync } from 'node:child_process'
import { connect } from '@lancedb/lancedb'
import type { GlobalOptions } from './options.js'
import { resolveGlobalConfig } from './options.js'

const HELP_TEXT = `Usage: mcp-local-rag [global-options] compact

Run table.optimize() on the chunks table — compact data fragments and
prune old version/index files. Safe to run anytime; no-op if nothing to do.

Options:
  --json                 Emit machine-readable JSON instead of plain text
  -h, --help             Show this help

Global options (must appear before "compact"):
  --db-path <path>       LanceDB database path
  --cache-dir <path>     Model cache directory
  --model-name <name>    Embedding model`

function parseArgs(args: string[]): { help: boolean; json: boolean } {
  let help = false
  let json = false
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') help = true
    else if (arg === '--json') json = true
    else {
      console.error(`Unknown option: ${arg}`)
      console.error(HELP_TEXT)
      process.exit(1)
    }
  }
  return { help, json }
}

function snapshot(tablePath: string): { disk: string; fragments: number; versions: number } {
  let disk = '?'
  let fragments = -1
  let versions = -1
  try {
    disk = execSync(`du -sh "${tablePath}"`).toString().split('\t')[0]?.trim() ?? '?'
  } catch {}
  try {
    fragments = Number.parseInt(
      execSync(`find "${tablePath}" -type f -name '*.lance' | wc -l`).toString().trim(),
      10
    )
  } catch {}
  try {
    versions = Number.parseInt(
      execSync(`ls "${tablePath}/_versions" 2>/dev/null | wc -l`).toString().trim(),
      10
    )
  } catch {}
  return { disk, fragments, versions }
}

export async function runCompact(args: string[], globalOptions: GlobalOptions = {}): Promise<void> {
  const { help, json } = parseArgs(args)
  if (help) {
    console.error(HELP_TEXT)
    process.exit(0)
  }

  const globalConfig = resolveGlobalConfig(globalOptions)
  const tableName = 'chunks'
  const tablePath = `${globalConfig.dbPath}/${tableName}.lance`

  try {
    const before = snapshot(tablePath)
    const db = await connect(globalConfig.dbPath, { readConsistencyInterval: 0 })
    const table = await db.openTable(tableName)
    const t0 = Date.now()
    const result = await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true })
    const elapsedMs = Date.now() - t0
    const after = snapshot(tablePath)

    if (json) {
      process.stdout.write(JSON.stringify({ before, after, elapsedMs, result }))
      process.stdout.write('\n')
    } else {
      console.log(
        `BEFORE: disk=${before.disk} fragments=${before.fragments} versions=${before.versions}`
      )
      console.log(`optimize: ${elapsedMs}ms`)
      console.log(
        `  compaction: ${result.compaction.fragmentsRemoved} removed, ${result.compaction.fragmentsAdded} added`
      )
      console.log(
        `  prune: ${result.prune.bytesRemoved} bytes, ${result.prune.oldVersionsRemoved} versions`
      )
      console.log(
        `AFTER:  disk=${after.disk} fragments=${after.fragments} versions=${after.versions}`
      )
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`Error: ${reason}`)
    process.exit(1)
  }
}

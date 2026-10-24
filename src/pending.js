// Waiting messages and interrupted turns outlive a plugin reload or a host
// restart (2026-10-24). They used to live only in memory: dsh-hmr reloads the
// plugin on every src save, and each reload dropped every waiting message
// without a word, and the turn it stopped never replied. On teardown they are
// written beside the state file; the next mount takes the file (renaming it,
// so it is replayed once) and queues them again in their old order.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The pending file for a state file, or undefined without one. */
export function pendingFile(stateFile) {
  if (stateFile === undefined) return undefined
  return stateFile.replace(/\.json$/, '') + '.pending.json'
}

/** Whether a saved entry has the shape the channel can queue again. */
function isEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && typeof entry.key === 'string' && typeof entry.channel === 'string'
    && Array.isArray(entry.parts) && entry.parts.length > 0
    && entry.parts.every((part) => typeof part?.who === 'string' && typeof part?.text === 'string')
}

/**
 * Write the entries synchronously (teardown calls this before anything else,
 * and the next mount reads the file right after). Nothing to save writes nothing.
 */
export function savePending(file, entries, logger) {
  if (file === undefined || entries.length === 0) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), entries }, null, 1))
    renameSync(tmp, file)
    logger.info('saved ' + entries.length + ' waiting conversation(s) to ' + file)
  } catch (error) {
    logger.warn('pending file write failed, waiting messages are lost: ' + (error?.message ?? String(error)))
  }
}

/**
 * Read and consume the saved entries: the file is renamed to `.restored`
 * (kept for diagnosis) so a later mount never replays them. Absent or
 * unreadable files yield no entries; malformed entries are skipped.
 */
export function takePending(file, logger) {
  if (file === undefined) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn('pending file unreadable, ignored: ' + (error?.message ?? String(error)))
    return []
  }
  try {
    renameSync(file, file + '.restored')
  } catch (error) {
    logger.warn('pending file could not be consumed, not restoring it twice: ' + (error?.message ?? String(error)))
    return []
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
  const valid = entries.filter(isEntry).map((entry) => ({
    key: entry.key,
    channel: entry.channel,
    threadTs: typeof entry.threadTs === 'string' ? entry.threadTs : undefined,
    ackTs: Array.isArray(entry.ackTs) ? entry.ackTs.filter((ts) => typeof ts === 'string') : [],
    mentionUserIds: Array.isArray(entry.mentionUserIds) ? entry.mentionUserIds.filter((id) => typeof id === 'string') : [],
    parts: entry.parts.map((part) => ({ who: part.who, text: part.text })),
    interrupted: entry.interrupted === true,
  }))
  if (valid.length < entries.length) logger.warn('skipped ' + (entries.length - valid.length) + ' malformed pending entr(ies)')
  return valid
}

// Handing the bot over to another host (2026-10-25). Two Socket Mode
// connections on one Slack app split the events between them, so the bot
// moves by closing this host's socket once the other host's is open. While
// the receive-off file exists beside the state file the channel keeps no
// socket: turns already running and messages already waiting finish here and
// reply through the Web API, new messages reach the other host only. What is
// left here goes to the drain file until nothing is; deleting the receive-off
// file opens the socket again.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The receive-off file for a state file, or undefined without one. */
export function receiveOffFile(stateFile) {
  if (stateFile === undefined) return undefined
  return stateFile.replace(/\.json$/, '') + '.receive-off'
}

/** The drain status file for a state file, or undefined without one. */
export function drainFile(stateFile) {
  if (stateFile === undefined) return undefined
  return stateFile.replace(/\.json$/, '') + '.drain.json'
}

/** Whether the receive-off file is there. */
export function receiveIsOff(file) {
  return file !== undefined && existsSync(file)
}

/** Write the drain status (what still runs or waits here), replacing the old one. */
export function writeDrain(file, status, logger) {
  if (file === undefined) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(status, null, 1))
    renameSync(tmp, file)
  } catch (error) {
    logger.warn('drain file write failed: ' + (error?.message ?? String(error)))
  }
}

/** Remove the drain status (receiving again). */
export function clearDrain(file) {
  if (file === undefined) return
  try {
    rmSync(file, { force: true })
  } catch { /* nothing to clear */ }
}

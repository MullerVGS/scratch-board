// Os scratchpads de sessão dos agentes: o segundo root, efêmero e alheio.
//
// `/tmp/claude-0/-root-projetos/<session-id>/scratchpad/` é onde os agentes largam
// arquivo temporário. O board lê e não toca — como, aliás, ele não toca em nada.

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { PADS, refOf } from './paths.js'

async function walk(dir, base = dir) {
  const out = []
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const path = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walk(path, base)))
      continue
    }
    const s = await stat(path).catch(() => null)
    if (!s) continue
    out.push({ name: relative(base, path), path, ref: refOf(path), size: s.size, mtime: s.mtimeMs })
  }
  return out
}

/**
 * Lista os scratchpads das sessões de agente, do mais recente ao mais antigo.
 *
 * Sessão sem arquivo nenhum é omitida: a esmagadora maioria nunca escreve nada, e
 * listá-las afogaria as poucas que têm conteúdo. O diretório é efêmero (`/tmp`) —
 * o board mostra o que existe agora e não promete que continuará existindo.
 */
export async function listPads() {
  let sessions = []
  try {
    sessions = (await readdir(PADS, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }

  const pads = await Promise.all(
    sessions.map(async (session) => {
      const dir = join(PADS, session, 'scratchpad')
      const files = (await walk(dir)).sort((a, b) => b.mtime - a.mtime)
      return {
        session,
        short: session.slice(0, 8),
        dir,
        ref: refOf(dir),
        files,
        bytes: files.reduce((n, f) => n + f.size, 0),
        mtime: files.reduce((n, f) => Math.max(n, f.mtime), 0),
      }
    }),
  )

  return pads.filter((p) => p.files.length).sort((a, b) => b.mtime - a.mtime)
}

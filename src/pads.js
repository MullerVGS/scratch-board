// Os scratchpads de sessão dos agentes: o root que **não é uma origem**, efêmero e alheio.
//
// `/tmp/claude-0/-root-projetos/<session-id>/scratchpad/` é onde os agentes largam
// arquivo temporário. O board lê e não toca — como, aliás, ele não toca em nada.
//
// Eles ficam **fora** dos namespaces de tracker, e é uma distinção de natureza, não de
// arrumação: um namespace é um `.scratch/` versionado, que as skills mantêm; um scratchpad
// é lixo de sessão em `/tmp`, que some no reboot. O `ref` de um pad é o caminho absoluto
// real — ele vale a partir de qualquer cwd, e é a única forma de ele ser colável.

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { PADS, padRef } from './paths.js'

/**
 * As árvores que a travessia **poda**, em qualquer profundidade.
 *
 * O teste de pertinência é **derivado × rascunhado**, e é o que decide quem entra aqui: um
 * `node_modules` não é o que a sessão escreveu, é o que uma ferramenta baixou para ela — é
 * reconstruível a partir de um `package.json`, nenhum humano vai abrir um arquivo dele na
 * gaveta, e ele chega aos milhares. `__pycache__` e `.venv` passariam no mesmo teste no dia
 * em que aparecerem.
 *
 * **Um diretório de saída não passa.** Um `data/` cheio de CSV que o agente gerou *é* o
 * trabalho da sessão, mesmo pesando centenas de MB: podá-lo seria o board mentindo sobre o
 * que a sessão fez — e mentir sobre o disco é o pecado que este projeto inteiro existe para
 * não cometer. Peso não é o critério; **origem** é.
 *
 * A poda é da **travessia**, não da exibição — daí o `continue` antes da recursão. Filtrar
 * depois de andar já teria pago a conta: medido contra um `node_modules` de 400 pacotes
 * (14.400 arquivos), `listPads()` levava **935ms** e o card anunciava **14.404 arquivos**,
 * afogando os 4 rascunhos que a sessão de fato escreveu.
 */
const PRUNED = new Set(['node_modules'])

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
      // Podado: não se desce, e por isso não se conta, não se soma e não se data. Os
      // descendentes nunca são visitados — é a travessia que custa, não a lista.
      if (PRUNED.has(e.name)) continue
      out.push(...(await walk(path, base)))
      continue
    }
    const s = await stat(path).catch(() => null)
    if (!s) continue
    out.push({ name: relative(base, path), path, ref: padRef(path), size: s.size, mtime: s.mtimeMs })
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
        ref: padRef(dir),
        files,
        bytes: files.reduce((n, f) => n + f.size, 0),
        mtime: files.reduce((n, f) => Math.max(n, f.mtime), 0),
      }
    }),
  )

  return pads.filter((p) => p.files.length).sort((a, b) => b.mtime - a.mtime)
}

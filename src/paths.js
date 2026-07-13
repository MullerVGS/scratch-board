// Os roots que o board lê, e a tradução entre os dois vocabulários de caminho.
//
// Os mesmos arquivos têm dois nomes: o do container, que o board usa para ler, e o do
// workspace, que é o único que faz sentido colar num agente. Cada item da API carrega os
// dois — `path` para o board, `ref` para o humano. Quem sabe qual root montou o quê é o
// processo que resolveu os roots, então a derivação é daqui, não do cliente.
//
// Vive num módulo só porque `board.js`, `pads.js` e `server.js` precisam dos três: se
// `refOf` morasse no `server.js`, os dois primeiros o importariam de volta — ciclo.

import { join, resolve, relative, sep } from 'node:path'

export const SCRATCH = resolve(process.env.SCRATCH_DIR ?? '/workspace/.scratch')
export const ARCHIVE = join(SCRATCH, 'archive')
// Os scratchpads de sessão dos agentes. Segundo root, montado read-only: é o
// rascunho que o agente deixou para trás, não estado do board.
export const PADS = resolve(process.env.PADS_DIR ?? '/workspace/pads')

const SCRATCH_REF = process.env.SCRATCH_REF ?? '.scratch'
const PADS_REF = process.env.PADS_REF ?? '/tmp/claude-0/-root-projetos'

const REFS = [
  [SCRATCH, SCRATCH_REF],
  [PADS, PADS_REF],
]

export const refOf = (path) => {
  const hit = REFS.find(([root]) => path === root || path.startsWith(root + sep))
  if (!hit) return path
  const rest = relative(hit[0], path)
  return rest ? `${hit[1]}/${rest}` : hit[1]
}

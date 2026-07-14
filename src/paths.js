// Os roots que o board lê, e a tradução entre os dois vocabulários de caminho.
//
// Um **namespace** é um `.scratch/` inteiro — esforços, mapas, issues, archive, grafo,
// gaveta, comandos, push. O board não tem mais *um* `.scratch/`: ele tem os que estiverem
// montados sob o diretório comum (`SCRATCHES`), e **cada filho direto dele é um
// namespace**, com o nome da pasta como nome do namespace.
//
// **O compose é a configuração, e é a única.** Não há lista em env, nem arquivo de config
// paralelo: um mount novo sob o mesmo diretório é uma origem nova no próximo start. Uma
// segunda lista seria uma segunda fonte da verdade, e as duas divergiriam.
//
// Os mesmos arquivos têm dois nomes: o do container, que o board usa para ler, e o do
// workspace, que é o único que faz sentido colar num agente. Cada item da API carrega os
// dois — `path` para o board, `ref` para o humano. **Os comandos partem de
// `/root/projetos`**, e é isso que decide o `ref` de cada origem: a de casa produz
// `.scratch/...` (o caminho é relativo a ela mesma) e qualquer outra produz
// `<nome>/.scratch/...`. O caminho interno do container nunca é apresentado.
//
// Vive num módulo só porque `board.js`, `pads.js` e `server.js` precisam disto: se a
// tradução morasse no `server.js`, os dois primeiros o importariam de volta — ciclo.

import { readdir } from 'node:fs/promises'
import { join, resolve, relative, sep } from 'node:path'

/** O diretório comum. Cada filho direto é um namespace; o compose decide quais existem. */
export const SCRATCHES = resolve(process.env.SCRATCHES_DIR ?? '/workspace/scratches')

// Os scratchpads de sessão dos agentes. Root à parte, e **fora dos namespaces**: eles são
// rascunho efêmero do Claude, não tracker de repositório nenhum. Read-only, como tudo aqui.
export const PADS = resolve(process.env.PADS_DIR ?? '/workspace/pads')

/**
 * A origem de casa: o workspace de onde os comandos partem. É a primeira aba, e a única
 * cujo `ref` é nu — `.scratch/...`, não `projetos/.scratch/...`, porque colar o segundo
 * num agente que já roda em `/root/projetos` não leva a lugar nenhum.
 */
const HOME = process.env.HOME_NS ?? 'projetos'

const PADS_REF = process.env.PADS_REF ?? '/tmp/claude-0/-root-projetos'

/** O caminho `path`, dito no vocabulário de `ref` — ou `null` se ele não mora sob `root`. */
const under = (root, ref, path) => {
  if (path !== root && !path.startsWith(root + sep)) return null
  const rest = relative(root, path)
  return rest ? `${ref}/${rest}` : ref
}

export const padRef = (path) => under(PADS, PADS_REF, path) ?? path
export const refIn = (ns, path) => under(ns.root, ns.ref, path) ?? path

/**
 * As origens montadas, na ordem em que aparecem: **a de casa primeiro**, o resto em ordem
 * alfabética. Um `.scratch/` que ninguém montou não existe para o board, e um diretório
 * comum vazio devolve lista vazia — que a tela sabe dizer.
 *
 * Roda uma vez, no `start()`: a descoberta é do startup, e um mount novo só aparece quando
 * o container é recriado. É o que o compose já garante — mudar o compose *é* recriar.
 */
export async function discover(dir = SCRATCHES) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { /* nada montado ainda, ou nunca */ }

  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => (a === HOME ? -1 : b === HOME ? 1 : a.localeCompare(b)))
    .map((name) => ({
      name,
      root: join(dir, name),
      ref: name === HOME ? '.scratch' : `${name}/.scratch`,
    }))
}

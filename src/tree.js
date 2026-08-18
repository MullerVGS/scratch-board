// A árvore: ler o `.scratch/` **de uma origem** e projetar a estrutura de arquivos que a API
// serve. É a projeção que o board serve, e a diferença para o que veio antes é o que o board
// deixou de exigir: **não há mais um esforço obrigatório**. Sem coluna, sem status obrigatório,
// sem PRD nem issues — há o que estiver no disco, arquivo por arquivo, pasta por pasta.
//
// Nada de parsing aqui — o dialeto dos `.md` mora em `shared/parse.js`, que o browser também
// importa. Nada de HTTP: este módulo não sabe que existe um servidor. E **nada de cache**:
// `buildTree()` é, por contrato, "leia o disco agora". Quem guarda o resultado e decide se ele
// mudou é o `cache.js`; separar as duas coisas é o que faz a supressão do push ser
// demonstrável em vez de prometida.
//
// **Uma origem por árvore.** `buildTree(ns)` monta a de *um* namespace, e nada aqui sabe que
// existem outros: o isolamento é a forma da função, não uma regra a lembrar.
//
// **O `mtime` entra no nó, e isso é diferente do board velho.** Ali o carimbo era proibido no
// payload porque o `mtime` de um *diretório* pula quando qualquer entrada nasce, morre ou é
// renomeada lá dentro — inclusive um `.swp` que o board nem projetava. Aqui o `mtime` de uma
// pasta é o **máximo dos filhos que a árvore de fato projeta** (recursivo), nunca o do inode do
// diretório: um oculto não conta, e sem escrita a árvore inteira é byte-idêntica. Um `save`
// reordena a árvore e vira um push legítimo; ocioso não tem save e não empurra byte nenhum.

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, extname, sep } from 'node:path'

import { normalizeStatus, parseDoc } from '../shared/parse.js'

import { refIn } from './paths.js'

/** A chave de rota `#/<ns>/<rel>` é sempre POSIX — o `\` do Windows não pode virar `/` no hash. */
const toPosix = (p) => (sep === '/' ? p : p.split(sep).join('/'))

/**
 * Os filhos **visíveis** de um diretório, já na ordem-base determinística.
 *
 * O `readdir` não promete ordem, e o desempate da árvore cai nela: por isso ordena-se
 * alfabeticamente **aqui**, antes de qualquer coisa. Uma ordem-base que flutuasse moveria o
 * hash da supressão num empate de `mtime` sem ninguém escrever nada — um push fantasma.
 *
 * Oculto (`.`) nunca é projetado, em nenhuma profundidade: um `.git/` ou um `.swp` de editor
 * não é conteúdo do esforço. Symlink e outros tipos exóticos ficam de fora — só arquivo e
 * diretório viram nó.
 */
async function visibleEntries(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.isFile()))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Um nó de **arquivo**. O `mtime` é o do próprio arquivo (`stat().mtimeMs`), e é ele que ordena.
 *
 * O selo (`status`/`title`) só existe em `.md`, e só entra no nó **se o arquivo o tiver** —
 * nada de `status: undefined` serializado, que moveria o hash sem carregar informação. O
 * `status` passa por `normalizeStatus`, para que um vocabulário novo apareça com `?` em vez de
 * sumir.
 */
async function fileNode(ns, dir, name) {
  const path = join(dir, name)
  const { mtimeMs } = await stat(path)
  const node = {
    type: 'file',
    name,
    path,
    ref: refIn(ns, path),
    rel: toPosix(relative(ns.root, path)),
    mtime: mtimeMs,
  }
  if (extname(name) === '.md') {
    const { header, title } = parseDoc(await readFile(path, 'utf8'))
    if (header.status !== undefined) node.status = normalizeStatus(header.status)
    if (title !== undefined) node.title = title
  }
  return node
}

/**
 * Um nó de **diretório**, com os filhos já ordenados. O `mtime` da pasta é o **máximo** dos
 * filhos (recursivo) — é como a recência de um save fundo sobe até a raiz e faz o trabalho
 * quente abrir a tela. Pasta vazia não tem o que datar: vale `0` e afunda.
 */
async function dirNode(ns, parent, name) {
  const path = join(parent, name)
  const children = await buildLevel(ns, path)
  return {
    type: 'dir',
    name,
    path,
    ref: refIn(ns, path),
    rel: toPosix(relative(ns.root, path)),
    mtime: children.reduce((max, c) => Math.max(max, c.mtime), 0),
    children,
  }
}

/**
 * Um nível da árvore, ordenado. **A estabilidade do `sort` é load-bearing**: as entradas já
 * chegam em ordem alfabética, então um empate de `mtime` cai de volta nela (o `sort` do JS é
 * estável desde o ES2019). O que sai é por `mtime` desc, e o empate é determinístico.
 *
 * As leituras dos filhos correm em paralelo; a ordem é dada pelo `sort` no fim, não por quem
 * termina primeiro.
 */
async function buildLevel(ns, dir) {
  const entries = await visibleEntries(dir)
  const nodes = await Promise.all(
    entries.map((e) => (e.isDirectory() ? dirNode(ns, dir, e.name) : fileNode(ns, dir, e.name))),
  )
  return nodes.sort((a, b) => b.mtime - a.mtime)
}

/**
 * A projeção de **uma** origem, lida do disco agora.
 *
 * Devolve `{ ns, root, ref, tree }` — `ns` é o **nome** (o mesmo do envelope SSE), `root` o
 * caminho da origem no container (por onde o board lê, nunca aparece na tela), `ref` o
 * caminho da origem no vocabulário do workspace (o que o humano copia — a raiz do
 * breadcrumb, quando o alvo da rota é a própria origem), `tree` os nós ordenados. Não carrega
 * `error`: a origem que deu para ler não está quebrada.
 *
 * **Root inexistente é árvore vazia, não erro.** Um `.scratch/` que a branch atual não tem
 * (`ENOENT`) é uma origem sem esforço nenhum, e vazio é a verdade — a branch não tem trabalho.
 * Qualquer outra falha de leitura (`ENOTDIR` num `.scratch/` que é arquivo, uma permissão que
 * nem o root vence, um diretório que o disco recusou) **sobe** e vira um board de erro no
 * `cache.js` (`errorTree`), contido nesta origem: vazio e quebrado são estados diferentes, e
 * confundi-los é a mentira mais cara que este board pode contar.
 */
export async function buildTree(ns) {
  let entries
  try {
    entries = await visibleEntries(ns.root)
  } catch (err) {
    if (err.code === 'ENOENT') return { ns: ns.name, root: ns.root, ref: refIn(ns, ns.root), tree: [] }
    throw err
  }
  const tree = (
    await Promise.all(
      entries.map((e) => (e.isDirectory() ? dirNode(ns, ns.root, e.name) : fileNode(ns, ns.root, e.name))),
    )
  ).sort((a, b) => b.mtime - a.mtime)
  return { ns: ns.name, root: ns.root, ref: refIn(ns, ns.root), tree }
}

/**
 * A árvore de uma origem que **não deu para ler**. Ela existe para que a falha fique contida na
 * origem que a sofreu — sem ela, um `readFile` que estoura num repo derrubaria a montagem de
 * todos — e para que o board **diga o que houve** em vez de fingir que a origem está vazia.
 *
 * A forma é a mesma de uma árvore de verdade (mesmas chaves, `tree` vazia), então a supressão
 * por hash continua valendo: enquanto o erro for o mesmo, ele não é reempurrado a cada varredura.
 */
export const errorTree = (ns, error) => ({ ns: ns.name, root: ns.root, ref: refIn(ns, ns.root), error, tree: [] })

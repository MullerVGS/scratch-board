// O board: ler o `.scratch/` **de uma origem** e montar a projeção que a API serve.
//
// Esforços, issues e as arestas de bloqueio entre elas. Nada de parsing aqui — o dialeto
// dos `.md` mora em `shared/doc.js`, que o browser também importa. Nada de HTTP: este
// módulo não sabe que existe um servidor.
//
// **Uma origem por board.** `buildBoard(ns)` monta o board de *um* namespace, e nada aqui
// sabe que existem outros: o isolamento não é uma regra que alguém precise lembrar de
// respeitar, é a forma da função. Dois esforços com o mesmo slug em origens diferentes são
// dois esforços, sem uma linha de código para separá-los.
//
// E **nada de cache**: `buildBoard()` é, por contrato, "leia o disco agora". Quem guarda o
// resultado e decide se ele mudou é o `cache.js`; separar as duas coisas é o que faz a
// supressão do push ser demonstrável em vez de prometida.
//
// Nenhum carimbo do filesystem entra no que sai daqui. O esforço já publicou um `mtime` —
// o do *diretório* —, e ele saiu: aquele número pula quando qualquer entrada nasce, morre
// ou é renomeada lá dentro, inclusive um `.swp` que o board nem projeta. Ninguém o lia, e
// dentro do hash ele moveria o hash sem o board mudar, matando a supressão. Carimbo de
// filesystem não descreve este domínio (ver "Out of Scope" no PRD do push).

import { readFile, readdir } from 'node:fs/promises'
import { join, extname } from 'node:path'

import {
  COLUMNS,
  KNOWN,
  columnOf,
  isClosed,
  normalizeStatus,
  parseBlockedBy,
  parseDoc,
  summarize,
} from '../shared/doc.js'

import { refIn } from './paths.js'

async function readIssue(ns, effortSlug, dir, file) {
  const path = join(dir, file)
  const { header, title } = parseDoc(await readFile(path, 'utf8'))
  const status = normalizeStatus(header.status)
  return {
    file,
    path,
    ref: refIn(ns, path),
    id: `${effortSlug}/${file}`,
    number: /^(\d+)/.exec(file)?.[1] ?? '',
    title: title ?? file.replace(/\.md$/, ''),
    status,
    closed: isClosed(status),
    column: columnOf(status),
    type: header.type ?? null,
    repo: header.repo ?? null,
    blockedBy: parseBlockedBy(header['blocked by']),
  }
}

export async function readEffort(ns, root, slug) {
  const dir = join(root, slug)
  const issuesDir = join(dir, 'issues')

  let files = []
  try {
    files = (await readdir(issuesDir)).filter((f) => extname(f) === '.md').sort()
  } catch { /* esforço sem issues/ — só PRD, é válido */ }

  const issues = await Promise.all(files.map((f) => readIssue(ns, slug, issuesDir, f)))

  // Um item está bloqueado se qualquer issue que ele lista ainda não fechou. Uma
  // referência a issue que não existe não bloqueia: não há o que esperar. As referências
  // são locais ao esforço — logo, locais à origem: um `Blocked by: 02` nunca atravessa
  // um namespace, nem quando o slug do outro lado é o mesmo.
  const byNumber = new Map(issues.map((i) => [i.number.padStart(2, '0'), i]))
  for (const issue of issues) {
    issue.blocked = issue.blockedBy.some((d) => {
      const dep = byNumber.get(d.number)
      return dep ? !isClosed(dep.status) : false
    })
  }

  // Cada documento carrega o que precisa para se apresentar: o título humano e o
  // primeiro parágrafo. É o que alimenta o resumo do card — sem um segundo request.
  const docs = []
  for (const name of ['map.md', 'PRD.md']) {
    let raw
    try {
      raw = await readFile(join(dir, name), 'utf8')
    } catch { continue /* ausente */ }
    const { title } = parseDoc(raw)
    docs.push({ name, title: title ?? null, blurb: summarize(raw) })
  }

  // O mapa manda quando existe: é o documento que o wayfinder mantém vivo, enquanto
  // o PRD congela na intenção original.
  const lede = docs[0] ?? null

  const closed = issues.filter((i) => isClosed(i.status)).length
  const moving = issues.some((i) => !['needs-triage', 'needs-info'].includes(i.status))

  return {
    // O esforço sabe de que origem veio, e é assim que o cliente inteiro sabe: o `ns` viaja
    // no dado em vez de ser um parâmetro que cada view teria que lembrar de repassar. É o
    // que impede um card de uma origem de abrir a gaveta contra o board de outra.
    ns: ns.name,
    slug,
    // O diretório do esforço, no vocabulário do container. Com ele, o cliente compõe o
    // caminho de um documento (`<path>/map.md`) sem remontar o root da origem na mão.
    path: dir,
    ref: refIn(ns, dir),
    docs,
    title: lede?.title ?? null,
    blurb: lede?.blurb ?? '',
    issues,
    total: issues.length,
    closed,
    // "Pronto para arquivar" = tem issues e todas fecharam. Um esforço só com PRD
    // nunca é arquivável automaticamente: é trabalho pretendido, não concluído.
    archivable: issues.length > 0 && closed === issues.length,
    // "Parado" é sobre movimento, não sobre progresso: ou nunca foi decomposto em
    // issues, ou tudo que existe está preso em triagem. Um esforço com issue
    // `ready-for-agent` está enfileirado, não parado — mesmo com zero fechadas.
    stalled: issues.length === 0 || !moving,
  }
}

async function listSlugs(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'archive' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * A projeção de **uma** origem. Um root que não existe, ou que existe vazio, devolve um
 * board vazio — e vazio é um estado legítimo, que a tela sabe mostrar.
 */
export async function buildBoard(ns) {
  const archiveRoot = join(ns.root, 'archive')
  const [activeSlugs, archivedSlugs] = await Promise.all([listSlugs(ns.root), listSlugs(archiveRoot)])
  const efforts = await Promise.all(activeSlugs.map((s) => readEffort(ns, ns.root, s)))
  const archived = await Promise.all(archivedSlugs.map((s) => readEffort(ns, archiveRoot, s)))
  return { ns: ns.name, root: ns.root, ref: ns.ref, columns: COLUMNS, statuses: KNOWN, efforts, archived }
}

/**
 * O board de uma origem que **não deu para ler** — um `.md` sem permissão, um mount que
 * sumiu por baixo, um diretório que o disco recusou.
 *
 * Ele existe para que a falha fique **contida na origem que falhou**: sem ele, uma leitura
 * que estoura derrubaria a montagem das outras, e um repositório com um arquivo quebrado
 * apagaria o board inteiro. E ele **diz o que houve** em vez de fingir que a origem está
 * vazia — vazio e quebrado são coisas diferentes, e confundi-las é a mentira de sempre.
 *
 * A forma é a mesma de um board de verdade (mesmas chaves, listas vazias), então a
 * supressão por hash continua valendo: enquanto o erro for o mesmo, ele não é reempurrado.
 */
export const errorBoard = (ns, error) => ({
  ns: ns.name,
  root: ns.root,
  ref: ns.ref,
  columns: COLUMNS,
  statuses: KNOWN,
  efforts: [],
  archived: [],
  error,
})

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
// **O `mtime` é lido aqui, e não sai daqui.** Ele ordena — os esforços e, dentro de cada um,
// as issues, de modo que o trabalho quente suba — mas **nenhum carimbo de filesystem entra no
// payload**, e a distinção é a decisão central deste módulo:
//
// (A ordem que sai daqui é a certa. O que a *tela* faz com ela é outra história: o kanban a
// respeita, e a visão geral a quebra em seções — limitação assumida, escrita no `AGENTS.md`.)
//
// - **Publicar o `mtime` mataria o push.** Ele muda a *cada* salvamento do agente. No board
//   serializado, ele moveria o hash toda vez, e o evento viraria `message` (~71 KB + um
//   re-render) em vez do `files` (~126 bytes) — colapsando as duas supressões independentes
//   que o `AGENTS.md` descreve em **Dois eventos**. Um teste proíbe a string `mtime` no board
//   serializado, e é ele o guarda disto.
// - **Publicar só a *ordem* não mata nada.** O hash se move quando o **ranking** muda — que é
//   quando a tela reordena de verdade, um push legítimo. O agente salva o ticket X: ele sobe
//   ao topo (um push), e os dez salvamentos seguintes não movem nada, porque ele já está em
//   primeiro.
//
// Daí a forma das leituras abaixo: elas devolvem **`{ at, ... }`** — o carimbo *ao lado* do
// documento, nunca dentro dele. A garantia deixa de ser uma regra que alguém precisa lembrar
// de respeitar na hora de montar o objeto, e passa a ser a forma da função: o `at` não tem
// como ser serializado por acidente, porque ele nunca esteve no que se serializa.
//
// **E a atividade é a dos arquivos que o board projeta — nunca a do diretório.** O `mtime` de
// um *diretório* pula quando qualquer entrada nasce, morre ou é renomeada lá dentro,
// inclusive um `.swp` de editor que o board nem projeta: ordenar por ele faria um arquivo
// temporário reordenar a tela e empurrar o board. Há um teste que prende isso.

import { readFile, readdir, stat } from 'node:fs/promises'
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

/**
 * Ordena pelo mais recente. **A estabilidade do `sort` é load-bearing**, não um detalhe: as
 * entradas chegam aqui em ordem alfabética (o `.sort()` do `readdir`, o `listSlugs`), então
 * um empate de carimbo — dois esforços sem documento nenhum, ambos em `0` — cai de volta
 * nessa ordem, que é determinística. Uma ordem que flutuasse no empate moveria o hash sem
 * ninguém escrever nada: um push fantasma, exatamente o que a supressão existe para não ter.
 */
const byActivity = (a, b) => b.at - a.at

/**
 * Um documento e **quando ele foi tocado**, numa ida só ao disco. É a única forma de ler
 * aqui: quem lê um `.md` para projetá-lo também precisa do carimbo que o ordena, e as duas
 * coisas saírem juntas é o que impede que uma delas seja esquecida no caminho novo.
 *
 * Some quem sumiu: um arquivo que evaporou entre o `readdir` e a leitura estoura, como
 * sempre estourou — e o `buildBoard()` o converte num board de erro, contido nesta origem.
 */
async function readStamped(path) {
  const [raw, { mtimeMs }] = await Promise.all([readFile(path, 'utf8'), stat(path)])
  return { raw, at: mtimeMs }
}

async function readIssue(ns, effortSlug, dir, file) {
  const path = join(dir, file)
  const { raw, at } = await readStamped(path)
  const { header, title } = parseDoc(raw)
  const status = normalizeStatus(header.status)
  return {
    at,
    issue: {
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
    },
  }
}

export async function readEffort(ns, root, slug) {
  const dir = join(root, slug)
  const issuesDir = join(dir, 'issues')

  let files = []
  try {
    files = (await readdir(issuesDir)).filter((f) => extname(f) === '.md').sort()
  } catch { /* esforço sem issues/ — só PRD, é válido */ }

  // As issues saem **por atividade**, e a ordem do array *é* a ordem da tela: o kanban
  // (`public/effort.js`) filtra por coluna, e `filter` preserva a ordem — então ordenar a
  // lista uma vez, aqui, ordena **dentro de cada coluna**, que é onde o olho procura.
  //
  // A ordem numérica que se perde não some do board: o número continua em destaque no card,
  // e a leitura estrutural — as arestas do `Blocked by:` — vive no grafo.
  const stamped = (await Promise.all(files.map((f) => readIssue(ns, slug, issuesDir, f))))
    .sort(byActivity)
  const issues = stamped.map((s) => s.issue)

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
  const docStamps = []
  for (const name of ['map.md', 'PRD.md']) {
    let doc
    try {
      doc = await readStamped(join(dir, name))
    } catch { continue /* ausente */ }
    const { title } = parseDoc(doc.raw)
    docs.push({ name, title: title ?? null, blurb: summarize(doc.raw) })
    docStamps.push(doc.at)
  }

  // O mapa manda quando existe: é o documento que o wayfinder mantém vivo, enquanto
  // o PRD congela na intenção original.
  const lede = docs[0] ?? null

  const closed = issues.filter((i) => isClosed(i.status)).length
  const moving = issues.some((i) => !['needs-triage', 'needs-info'].includes(i.status))

  return {
    // A atividade de um esforço é a do **documento mais recente que ele projeta** — uma
    // issue, o mapa ou o PRD. Nunca o `mtime` do diretório: aquele pula com o `.swp` do
    // editor, e um arquivo que o board não mostra não pode reordenar a tela.
    //
    // Um esforço sem documento nenhum vale `0` e afunda para o fim — não há o que datar, e
    // fingir uma data seria o board inventando um fato.
    at: Math.max(0, ...stamped.map((s) => s.at), ...docStamps),
    effort: {
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
    },
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
  const [active, archived] = await Promise.all([
    Promise.all(activeSlugs.map((s) => readEffort(ns, ns.root, s))),
    Promise.all(archivedSlugs.map((s) => readEffort(ns, archiveRoot, s))),
  ])

  // **Aqui o carimbo morre.** Ele ordenou, e o `.map()` o deixa para trás: o que sai desta
  // função — e vira o JSON que o hash da supressão observa — carrega a *ordem* e nenhum
  // `mtime`. O esforço mexido por último vem primeiro; o parado afunda.
  //
  // Os arquivados também: o `mv` do arquivamento **preserva o `mtime`** dos `.md`, então a
  // lista de arquivados sai pela atividade que cada esforço teve em vida — o último a ser
  // encerrado no topo. É mais informativo que o alfabético que ela tinha, e é de graça.
  return {
    ns: ns.name,
    root: ns.root,
    ref: ns.ref,
    columns: COLUMNS,
    statuses: KNOWN,
    efforts: active.sort(byActivity).map((e) => e.effort),
    archived: archived.sort(byActivity).map((e) => e.effort),
  }
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

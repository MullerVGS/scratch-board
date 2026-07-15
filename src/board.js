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
// **O `mtime` cru é lido aqui, e não sai daqui.** Ele ordena — os esforços e, dentro de cada
// um, as issues, de modo que o trabalho quente suba — e nada mais: *quando* o trabalho andou
// não vem dele (ele mente, um toque tangencial o move), vem do **catálogo** — a transição de
// `Status:` que o `history.js` persiste. O que **nunca** atravessa o fio é o carimbo bruto, e
// a distinção é a decisão central deste módulo:
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
// - **E o `held` de cada issue** — o instante em que ela entrou na coluna atual, que alimenta
//   o `"em <coluna> há N"` do card — atravessa o fio, mas **não é o `mtime`**: é um carimbo de
//   transição do catálogo, **imóvel** (dez salvamentos depois, o mesmo byte), como os `start` da
//   barra do Gantt. Publicá-lo não move o hash; o relativo e a unidade são conta do navegador.
//
// Daí a forma das leituras abaixo: elas devolvem **`{ at, ... }`** — o carimbo *ao lado* do
// documento, nunca dentro dele. A garantia deixa de ser uma regra que alguém precisa lembrar
// de respeitar na hora de montar o objeto, e passa a ser a forma da função: o `at` não tem
// como ser serializado por acidente, porque ele nunca esteve no que se serializa. O que entra
// no objeto é o que se **decidiu** publicar, e só isso.
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
 * Duas escritas separadas por menos disto são **a mesma rajada**, não duas atividades.
 *
 * Medido na frota, e os dois grupos não se tocam:
 *
 * | | intervalo entre escritas |
 * | --- | --- |
 * | rajada de criação (`/to-tickets` compondo `01…07`) | **4s – 25s** |
 * | trabalho de verdade (reivindicar, resolver, tocar) | **≥ 389s** (~6,5 min) |
 *
 * 60s cai no meio desse vale: 2,4× acima do maior gap de rajada, 6,5× abaixo do menor gap de
 * trabalho. Não é um número escolhido no gosto — é o meio de uma separação que existe no disco.
 */
const BURST_MS = 60_000

/** Um arquivo sem `NN` não pertence à espinha numerada e vai para o fim da sua rajada. */
const numberOf = (issue) =>
  issue.number === '' ? Number.MAX_SAFE_INTEGER : Number(issue.number)

/**
 * A ordem das **issues**: por tempo, mais recente primeiro — **exceto dentro de uma rajada, onde
 * manda o número.**
 *
 * O problema que isto resolve: o `/to-tickets` escreve `01…07` de uma vez, com ~20s entre um e
 * outro. Pelo `mtime` puro, o `07` é o mais recente e a coluna sai **invertida** — a frontier
 * (`01`) no fim, que é o pior lugar possível para ela. E **não se conserta sozinho**: um ticket
 * em `ready-for-agent` é, por definição, um que ninguém tocou desde que nasceu (tocá-lo muda o
 * `Status:`, e isso o **tira da coluna**). A inversão seria permanente, e permanente justamente
 * na coluna de onde se escolhe o trabalho.
 *
 * **Por que agrupar por lacuna, e não quantizar o carimbo.** Um balde de tempo absoluto
 * (`Math.floor(at / N)`) *parece* a solução óbvia e não funciona: uma rajada de sete tickets a
 * 20s **abrange 95–140 segundos**, então ela atravessa dois ou três baldes de minuto e o corte a
 * parte no meio — sairia `06,07 → 04,05 → 01,02,03`, pior que a inversão limpa. Balde tem borda,
 * e a rajada cai em cima dela. Já um balde grande o bastante para conter a rajada inteira (um
 * dia) apaga o que o board existe para mostrar: o ticket tocado às 15h deixaria de subir sobre a
 * rajada das 9h **do mesmo dia**.
 *
 * O que separa rajada de trabalho não é a **hora**; é a **distância entre elas**. Então é isso
 * que se mede.
 *
 * A ordem é função pura do conjunto de `mtime`s: sem escrita, ela não muda — logo a varredura de
 * 90s não reordena nada sozinha, e o board parado continua parado.
 */
function orderIssues(stamped) {
  const byTime = [...stamped].sort(byActivity)
  const out = []

  for (let i = 0; i < byTime.length; ) {
    // A rajada se estende enquanto o vizinho seguinte estiver a menos de `BURST_MS` do anterior.
    // É encadeado de propósito: os gaps são de ~20s, mas o vão inteiro passa de dois minutos.
    let j = i + 1
    while (j < byTime.length && byTime[j - 1].at - byTime[j].at < BURST_MS) j++

    out.push(...byTime.slice(i, j).sort((a, b) => numberOf(a.issue) - numberOf(b.issue)))
    i = j
  }
  return out
}

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

/**
 * O **dia UTC** de um instante. É a granularidade do **cerco** do esforço no Gantt — o
 * `created`/`ended` derivados do `birthtime`/`ctime` do diretório (ver `readEffort`).
 *
 * O dia é a precisão certa ali ("quando o esforço rodou") e é o que mantém o campo estável no
 * fio: o `ctime` de um arquivado pode escorregar (um `chmod`, um restore), mas não em
 * granularidade de dia. O *quando o trabalho andou* — fino, ao minuto — não vem daqui; vem do
 * catálogo, via `projectColumnEntry` e `projectBar`.
 */
const dayOf = (at) => new Date(at).toISOString().slice(0, 10)

/**
 * A barra do Gantt (ticket 04), destilada do catálogo. **Sólido é fato, hachurado é cerco:**
 *
 * - Se o servidor **observou** o ticket transicionar (`observations.length > 1`), a barra é
 *   `medido` e vem **subdividida pelas colunas** que ele atravessou — é daí que sai o "tempo em
 *   coluna". Cada faixa começa no instante em que o servidor confirmou aquela coluna (`at`), e
 *   transições **dentro da mesma coluna** (`ready-for-agent → ready-for-human`) não a quebram.
 * - Se ele **nunca** o viu andar, não há faixa nenhuma: o Gantt desenha a barra **hachurada**
 *   sobre o intervalo do esforço (o `created`→`ended` do diretório, que o cliente já tem). O
 *   hachurado é um intervalo que *contém* o fato, nunca um fato — é o que deixa os tickets
 *   antigos aparecerem sem uma única data inventada.
 *
 * **Só os `at` de transição atravessam o fio, e eles são imóveis** (o instante em que
 * `pronto → curso` aconteceu não se move com salvamento nenhum), então não ferem a supressão —
 * ao contrário do `mtime`. O fim da barra (a resolução, ou "hoje" do ticket aberto) é conta do
 * cliente: o último `at` já diz quando fechou, e "hoje" envelhece no relógio de quem olha.
 */
function projectBar(observations) {
  if (observations.length <= 1) return { measured: false }
  const segments = []
  for (const { status, at } of observations) {
    const column = columnOf(status)
    if (segments.at(-1)?.column === column) continue
    segments.push({ column, start: at })
  }
  return { measured: true, segments }
}

/**
 * O **tempo na coluna atual** (`issue.held`), destilado do catálogo — o fato absoluto de que o
 * card diz `"em <coluna> há N"`. Substitui o `"parado há N dias"` que lia o `mtime` e que um
 * toque tangencial zerava: aqui só a **transição de `Status:`** move o contador, então ele
 * responde a *"quando o trabalho andou"* em vez de *"quando o arquivo foi tocado"*.
 *
 * Devolve `{ at, floor }`:
 *
 * - **`at`** — o instante ISO em que o ticket entrou na coluna atual, ou `null` quando o
 *   catálogo ainda não sabe: volume perdido, ou uma transição recém-escrita cuja observação
 *   ainda não rodou (a leitura vem *antes* do `observe()` no mesmo `sync()` — a retaguarda de
 *   um ciclo que o `AGENTS.md` documenta). Nesse caso o card cala, em vez de rotular o tempo da
 *   coluna velha com o nome da nova.
 * - **`floor`** — `true` quando o servidor **nunca viu** o ticket entrar nessa coluna, só o
 *   encontrou já nela (o primeiro `seen` abriu a trilha aqui): o `at` é um **piso**
 *   (`"há ≥N"`), não um fato, e o viés está no lado seguro — subestima o encalhe, nunca o
 *   esconde. Vira `false` no instante em que uma transição observada preencher a coluna atual.
 *
 * O `at` é **imóvel** (um instante de transição ou de primeiro-encontro, persistido no log e
 * relido igual), então atravessa o fio sem ferir a supressão — como os `start` da barra, e ao
 * contrário do `mtime`. O relativo, a unidade e o limiar são conta do navegador.
 */
function projectColumnEntry(observations, currentColumn) {
  // As colunas percorridas, mescladas — uma transição **dentro** da mesma coluna
  // (`ready-for-agent → ready-for-human`) não abre faixa nem reinicia o contador.
  const runs = []
  for (const { status, at } of observations) {
    const column = columnOf(status)
    if (runs.at(-1)?.column === column) continue
    runs.push({ column, start: at })
  }
  const last = runs.at(-1)
  // O catálogo pode estar um ciclo atrás de uma transição recém-escrita: a última faixa
  // observada não é a coluna atual do arquivo. O honesto é calar até o próximo ciclo preenchê-la.
  if (!last || last.column !== currentColumn) return { at: null, floor: false }
  // Piso quando a coluna atual é a **primeira** que o servidor viu: ele não observou a entrada
  // nela, só a encontrou já lá. Uma coluna alcançada por transição (`runs.length > 1`) é fato.
  return { at: last.start, floor: runs.length === 1 }
}

async function readIssue(ns, effortSlug, dir, file, history) {
  const path = join(dir, file)
  const { raw, at } = await readStamped(path)
  const { header, title } = parseDoc(raw)
  const status = normalizeStatus(header.status)
  const column = columnOf(status)
  const number = /^(\d+)/.exec(file)?.[1] ?? ''
  // Uma leitura do catálogo, dois consumidores. Sem catálogo (volume perdido, ou um contexto
  // que não o passa), `observations()` devolve `[]` — a barra nasce hachurada e o `held` nasce
  // sem instante: a degradação honesta que o PRD exige. Perder o volume degrada, não zera.
  const obs = history?.observations(ns.name, effortSlug, number) ?? []
  return {
    at,
    issue: {
      file,
      path,
      ref: refIn(ns, path),
      id: `${effortSlug}/${file}`,
      number,
      title: title ?? file.replace(/\.md$/, ''),
      status,
      closed: isClosed(status),
      column,
      type: header.type ?? null,
      repo: header.repo ?? null,
      blockedBy: parseBlockedBy(header['blocked by']),
      // O tempo na coluna atual (`held`, o `"em <coluna> há N"`) e a barra do Gantt — os dois
      // fatos que o catálogo destila, e que substituem o `mtime` como eixo de tempo.
      held: projectColumnEntry(obs, column),
      bar: projectBar(obs),
    },
  }
}

export async function readEffort(ns, root, slug, history, archived = false) {
  const dir = join(root, slug)
  const issuesDir = join(dir, 'issues')

  // O `birthtime` do **diretório** é a data de criação do esforço — de verdade. Ninguém
  // recria um diretório: o `mkdir` acontece uma vez, o `Write` atômico de um `.md` lá dentro
  // não toca o inode dele, e o `mv` do arquivamento (`rename`) o preserva. É o oposto do
  // `birthtime` de *arquivo*, que o `Write` dos agentes reseta a cada salvamento — a
  // armadilha que o `AGENTS.md` documenta em "Carimbo de filesystem não é eixo de tempo".
  //
  // E ele pode atravessar o fio sem ferir a supressão porque é **imóvel**: dez salvamentos
  // depois, o campo é o mesmo byte. Num filesystem sem `birthtime` o stat devolve `0`, e aí
  // não se publica nada — ausência, nunca uma data inventada (1970 mentiria com confiança).
  // O `ctime` marca o `mv` do arquivamento (`rename` preserva o inode do diretório, mas mexe no
  // `ctime`) — logo é o **fim real** de um esforço encerrado, direto do disco. Um esforço ativo
  // não terminou: `ended` é `null`, e o Gantt estica o cerco até "hoje", que é do navegador.
  const { birthtimeMs, ctimeMs } = await stat(dir)
  const born = birthtimeMs > 0 ? dayOf(birthtimeMs) : null
  const ended = archived && ctimeMs > 0 ? dayOf(ctimeMs) : null

  let files = []
  try {
    files = (await readdir(issuesDir)).filter((f) => extname(f) === '.md').sort()
  } catch { /* esforço sem issues/ — só PRD, é válido */ }

  // As issues saem **por tempo, com a rajada de criação desfeita pelo número** — ver
  // `orderIssues`. A ordem do array *é* a ordem da tela: o kanban (`public/effort.js`) filtra
  // por coluna, e `filter` preserva a ordem — então ordenar a lista uma vez, aqui, ordena
  // **dentro de cada coluna**, que é onde o olho procura.
  const stamped = orderIssues(await Promise.all(files.map((f) => readIssue(ns, slug, issuesDir, f, history))))
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
      // A criação do esforço — o `born` acima, e este é **exato**, não piso: o diretório
      // nasceu quando nasceu. É a borda esquerda da barra-pai do Gantt global (ticket 04) e
      // o piso/cerco que as issues herdam para o hachurado.
      created: born,
      // O fim do esforço, ou `null` enquanto ele vive. Junto com o `created`, é o **cerco** de
      // disco em que as barras hachuradas (tickets nunca observados) se inscrevem — e a borda
      // direita da barra-pai no Gantt global.
      ended,
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
 *
 * O `history` é o catálogo, **lido** aqui para destilar a barra do Gantt de cada issue (ver
 * `projectBar`). Continua não havendo cache nem HTTP neste módulo: o catálogo é uma leitura,
 * como o disco. `undefined` degrada para barras hachuradas.
 */
export async function buildBoard(ns, history) {
  const archiveRoot = join(ns.root, 'archive')
  const [activeSlugs, archivedSlugs] = await Promise.all([listSlugs(ns.root), listSlugs(archiveRoot)])
  const [active, archived] = await Promise.all([
    Promise.all(activeSlugs.map((s) => readEffort(ns, ns.root, s, history, false))),
    Promise.all(archivedSlugs.map((s) => readEffort(ns, archiveRoot, s, history, true))),
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

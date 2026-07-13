// O board: ler o `.scratch/` do disco e montar a projeção que a API serve.
//
// Esforços, issues e as arestas de bloqueio entre elas. Nada de parsing aqui — o dialeto
// dos `.md` mora em `shared/doc.js`, que o browser também importa. Nada de HTTP: este
// módulo não sabe que existe um servidor.
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

import { SCRATCH, ARCHIVE, refOf } from './paths.js'

async function readIssue(effortSlug, dir, file) {
  const path = join(dir, file)
  const { header, title } = parseDoc(await readFile(path, 'utf8'))
  const status = normalizeStatus(header.status)
  return {
    file,
    path,
    ref: refOf(path),
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

export async function readEffort(root, slug) {
  const dir = join(root, slug)
  const issuesDir = join(dir, 'issues')

  let files = []
  try {
    files = (await readdir(issuesDir)).filter((f) => extname(f) === '.md').sort()
  } catch { /* esforço sem issues/ — só PRD, é válido */ }

  const issues = await Promise.all(files.map((f) => readIssue(slug, issuesDir, f)))

  // Um item está bloqueado se qualquer issue que ele lista ainda não fechou. Uma
  // referência a issue que não existe não bloqueia: não há o que esperar.
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
    slug,
    ref: refOf(dir),
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

export async function buildBoard() {
  const [activeSlugs, archivedSlugs] = await Promise.all([listSlugs(SCRATCH), listSlugs(ARCHIVE)])
  const efforts = await Promise.all(activeSlugs.map((s) => readEffort(SCRATCH, s)))
  const archived = await Promise.all(archivedSlugs.map((s) => readEffort(ARCHIVE, s)))
  return { root: SCRATCH, columns: COLUMNS, statuses: KNOWN, efforts, archived }
}

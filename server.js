import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve, relative, extname, sep } from 'node:path'

// O parser do dialeto `.scratch/` vive num lugar só, e este é um dos dois que o usam —
// o outro é o browser, que o importa de `/shared/doc.js` (servido logo abaixo).
import {
  COLUMNS,
  KNOWN,
  columnOf,
  isClosed,
  normalizeStatus,
  parseBlockedBy,
  parseDoc,
  summarize,
} from './shared/doc.js'

const PORT = Number(process.env.PORT ?? 7777)
const SCRATCH = resolve(process.env.SCRATCH_DIR ?? '/workspace/.scratch')
const ARCHIVE = join(SCRATCH, 'archive')
// Os scratchpads de sessão dos agentes. Segundo root, montado read-only: é o
// rascunho que o agente deixou para trás, não estado do board.
const PADS = resolve(process.env.PADS_DIR ?? '/workspace/pads')
const PUBLIC = resolve(import.meta.dirname, 'public')
// O parser que o browser também importa. É servido estático, sob o mesmo prefixo que o
// `import` do `md.js` escreve (`../shared/doc.js`), para que o especificador resolva
// igual nos dois lados: no filesystem, para o Node; na URL, para o browser.
const SHARED = resolve(import.meta.dirname, 'shared')

// Os mesmos arquivos têm dois nomes: o do container, que o board usa para ler e
// escrever, e o do workspace, que é o único que faz sentido colar num agente.
// Cada item carrega os dois — `path` para a API, `ref` para o humano.
const SCRATCH_REF = process.env.SCRATCH_REF ?? '.scratch'
const PADS_REF = process.env.PADS_REF ?? '/tmp/claude-0/-root-projetos'

const REFS = [
  [SCRATCH, SCRATCH_REF],
  [PADS, PADS_REF],
]

const refOf = (path) => {
  const hit = REFS.find(([root]) => path === root || path.startsWith(root + sep))
  if (!hit) return path
  const rest = relative(hit[0], path)
  return rest ? `${hit[1]}/${rest}` : hit[1]
}

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

async function readEffort(root, slug) {
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
  let mtime = 0
  try { mtime = (await stat(dir)).mtimeMs } catch { /* ignora */ }

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
    mtime,
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

async function buildBoard() {
  const [activeSlugs, archivedSlugs] = await Promise.all([listSlugs(SCRATCH), listSlugs(ARCHIVE)])
  const efforts = await Promise.all(activeSlugs.map((s) => readEffort(SCRATCH, s)))
  const archived = await Promise.all(archivedSlugs.map((s) => readEffort(ARCHIVE, s)))
  return { root: SCRATCH, columns: COLUMNS, statuses: KNOWN, efforts, archived }
}

/** Prende um `path` vindo do cliente aos roots que o board pode ler. */
function safePath(input) {
  const p = resolve(input)
  const ok = [SCRATCH, PADS].some((r) => p === r || p.startsWith(r + sep))
  if (!ok) throw new Error('caminho fora dos diretórios permitidos')
  return p
}

// ---------- scratchpads de sessão ----------

/** Um arquivo grande ou binário não vai para a gaveta; só o fato de existir importa. */
const TEXT_LIMIT = 512 * 1024

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
async function listPads() {
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// O `listen` fica atrás do teste de módulo principal: `node server.js` sobe o servidor,
// `import` (dos testes) só pega as funções puras. Sem isso, `node --test` levantaria a
// porta 7777 e ficaria pendurado.
const isMain = process.argv[1] && resolve(process.argv[1]) === import.meta.filename

if (isMain) createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname === '/api/board') return send(res, 200, await buildBoard())

    if (url.pathname === '/api/pads') return send(res, 200, { root: PADS, pads: await listPads() })

    if (url.pathname === '/api/file') {
      const path = safePath(url.searchParams.get('path') ?? '')
      const { size } = await stat(path)
      if (size > TEXT_LIMIT) {
        return send(res, 200, { path, content: `— arquivo de ${size} bytes, grande demais para exibir —` })
      }
      const buf = await readFile(path)
      // NUL nos primeiros bytes é o sinal barato de binário: evita despejar um PNG na gaveta.
      const binary = buf.subarray(0, 8000).includes(0)
      return send(res, 200, {
        path,
        content: binary ? `— binário, ${size} bytes —` : buf.toString('utf8'),
      })
    }

    // Estático de dois roots: `public/` na raiz da URL, e `shared/` sob `/shared/` — é
    // por ali que o `md.js` do browser importa o parser que o servidor também usa.
    const [root, file] = url.pathname.startsWith('/shared/')
      ? [SHARED, url.pathname.slice('/shared/'.length)]
      : [PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1)]
    const path = resolve(root, file)
    if (!path.startsWith(root + sep)) return send(res, 403, { error: 'proibido' })
    return send(res, 200, await readFile(path, 'utf8'), MIME[extname(path)] ?? 'text/plain')
  } catch (err) {
    const missing = err.code === 'ENOENT'
    send(res, missing ? 404 : 400, { error: missing ? 'não encontrado' : err.message })
  }
}).listen(PORT, () => {
  console.log(`scratch-board em http://localhost:${PORT}  (lendo ${SCRATCH})`)
})

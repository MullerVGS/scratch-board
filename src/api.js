// A API de leitura e **escrita** dos `.scratch/`, para agentes fora da máquina (sessões de nuvem).
//
// É um processo à parte do board, de propósito: o board continua sendo o que nunca escreve, com
// as origens `:ro`, e esta é a única peça que grava. Cada uma com o seu compose, o seu mount.
//
// **As origens são as do board** — mesmo `discover()`, mesmo `FOLDERS`, mesmo `ref`: cada filho
// de `REPOS_DIR` é uma origem, e a raiz é o `.scratch/` de dentro. O que muda é o que se monta.
// Pasta que não é git monta só o `.scratch/`, e aí nada além dele existe para a API. Repo git
// monta o repo (o inode preso do checkout vale igual aqui), e aí quem prende a escrita é o
// `resolveIn()` abaixo.
//
// Autenticação é a chave `sk_...` (`keys.js`) em `X-Scratch-Token`. Atrás da borda o
// `Authorization` não é nosso: o header auth do Pangolin é `Basic user:senha` nele, e esta API
// não sabe disso nem precisa. `Authorization: Bearer sk_...` também vale, para uso local.
//
// Escrita é **condicionada**: `If-Match` com o ETag que o agente leu, ou `If-None-Match: *` para
// criar. O arquivo mudou no meio → 412, e o agente relê. A gravação é temporário oculto +
// `rename`, o mesmo padrão que o watcher do board já conhece, então quem olha o board vê a
// escrita chegar ao vivo.

import { createServer } from 'node:http'
import { appendFile, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { REPOS, discover, refIn } from './paths.js'
import { buildTree } from './tree.js'
import { STATE_DIR, createKeyStore } from './keys.js'

const PORT = Number(process.env.PORT ?? 7778)
const MAX_BODY = 1024 * 1024
const TEXT = new Set(['.md', '.txt', '.json'])

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const send = (res, code, body, headers = {}) => {
  const json = typeof body !== 'string'
  res.writeHead(code, {
    'content-type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(json ? JSON.stringify(body) : body)
}

const sha1 = (buf) => createHash('sha1').update(buf).digest('hex')
const unquote = (etag) => etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '')
const inside = (root, p) => p === root || p.startsWith(root + sep)

/** A árvore do board sem o caminho do container: `path` sai, `rel` e `ref` ficam. */
const stripPaths = (nodes) => nodes.map(({ path, children, ...n }) => (children ? { ...n, children: stripPaths(children) } : n))

/**
 * Um `rel` vindo do cliente → caminho absoluto dentro da raiz, ou 400.
 *
 * Recusa `..`, absoluto e segmento oculto (`.git`, temporários) no texto, e depois confere o
 * **real**: o ancestral existente mais próximo tem que estar dentro da raiz real (symlink que sai
 * da raiz), e o próprio alvo, se existe, não pode ser symlink. É a contenção que importa quando o
 * mount é o repo inteiro em rw.
 */
async function resolveIn(root, rel) {
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).some((s) => s === '..' || s.startsWith('.'))) {
    throw new HttpError(400, 'caminho inválido')
  }
  const target = resolve(root, rel)
  if (!inside(root, target) || target === root) throw new HttpError(400, 'caminho inválido')

  const realRoot = await realpath(root)
  let probe = dirname(target)
  for (;;) {
    try {
      if (!inside(realRoot, await realpath(probe))) throw new HttpError(400, 'caminho inválido')
      break
    } catch (err) {
      if (err instanceof HttpError) throw err
      if (err.code !== 'ENOENT') throw err
      probe = dirname(probe)
    }
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new HttpError(400, 'caminho inválido')
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (err.code !== 'ENOENT') throw err
  }
  return target
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'corpo acima de 1 MB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

const readOrNull = (path) =>
  readFile(path).catch((err) => {
    if (err.code === 'ENOENT') return null
    throw err
  })

export async function startApi(port = PORT, { reposDir = REPOS, stateDir = STATE_DIR, folders = process.env.FOLDERS ?? '' } = {}) {
  const namespaces = await discover(reposDir, folders)
  const store = createKeyStore(stateDir)
  const auditFile = join(stateDir, 'audit.log')

  const audit = async (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
    console.log(`audit ${line}`)
    await mkdir(stateDir, { recursive: true })
    await appendFile(auditFile, line + '\n')
  }

  /** A origem pedida, se a chave alcança: 403 fora do escopo, 404 se não está montada. */
  const origin = (key, name) => {
    const allowed = key.origins.includes('*') || key.origins.includes(name)
    if (!allowed) throw new HttpError(403, `a chave não alcança a origem "${name}"`)
    const ns = namespaces.find((n) => n.name === name)
    if (!ns) throw new HttpError(404, `origem "${name}" não montada`)
    return ns
  }

  const textOnly = (rel) => {
    if (!TEXT.has(extname(rel))) throw new HttpError(415, 'só .md, .txt e .json')
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://api')
    if (url.pathname === '/healthz') return send(res, 200, { ok: true })

    const token = req.headers['x-scratch-token'] ?? /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    if (!token) throw new HttpError(401, 'token ausente')
    const check = await store.verify(token)
    if (!check.ok) throw new HttpError(401, check.reason)
    const { key } = check

    if (req.method === 'GET' && url.pathname === '/api/origins') {
      return send(res, 200, namespaces
        .filter((n) => key.origins.includes('*') || key.origins.includes(n.name))
        .map((n) => ({ name: n.name, ref: n.ref })))
    }

    const ns = origin(key, url.searchParams.get('ns') ?? '')

    if (req.method === 'GET' && url.pathname === '/api/tree') {
      const board = await buildTree(ns)
      return send(res, 200, { ns: board.ns, ref: board.ref, tree: stripPaths(board.tree) })
    }

    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('path') ?? ''
      const target = await resolveIn(ns.root, rel)

      if (req.method === 'GET') {
        const body = await readOrNull(target)
        if (body === null) throw new HttpError(404, 'arquivo não existe')
        return send(res, 200, body.toString('utf8'), { etag: `"${sha1(body)}"` })
      }

      if (req.method === 'PUT') {
        textOnly(rel)
        const ifMatch = req.headers['if-match']
        const create = req.headers['if-none-match']?.trim() === '*'
        if (!ifMatch && !create) throw new HttpError(428, 'mande If-Match: <etag> ou If-None-Match: *')

        const body = await readBody(req)
        const current = await readOrNull(target)
        if (create && current !== null) throw new HttpError(412, 'arquivo já existe')
        if (!create && (current === null || sha1(current) !== unquote(ifMatch))) {
          throw new HttpError(412, 'arquivo mudou desde a leitura: releia e refaça')
        }

        await mkdir(dirname(target), { recursive: true })
        const tmp = join(dirname(target), `.${basename(target)}.tmp-${randomBytes(4).toString('hex')}`)
        await writeFile(tmp, body)
        await rename(tmp, target)

        const etag = sha1(body)
        await audit({
          key: key.id,
          label: key.label,
          op: current === null ? 'create' : 'update',
          path: `${ns.name}/${relative(ns.root, target).split(sep).join('/')}`,
          before: current === null ? null : sha1(current),
          after: etag,
        })
        return send(res, current === null ? 201 : 200, { ok: true, etag, ref: refIn(ns, target) }, { etag: `"${etag}"` })
      }
    }

    throw new HttpError(404, 'rota não existe')
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message })
      console.error(err)
      send(res, 500, { error: 'erro interno' })
    })
  })
  await new Promise((ok) => server.listen(port, ok))
  return server
}

if (import.meta.filename === process.argv[1]) {
  const server = await startApi()
  console.log(`scratch-api na porta ${server.address().port}`)
}

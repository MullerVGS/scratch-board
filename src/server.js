// Só HTTP: rotas, estáticos e a contenção dos caminhos que chegam do cliente.
//
// O que o board *é* mora ao lado — `board.js` monta a projeção do `.scratch/`, `pads.js`
// lê os scratchpads, `../shared/doc.js` entende o dialeto dos `.md`. Aqui só se responde.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'

import { SCRATCH, PADS } from './paths.js'
import { buildBoard } from './board.js'
import { listPads } from './pads.js'

const PORT = Number(process.env.PORT ?? 7777)
const PUBLIC = resolve(import.meta.dirname, '..', 'public')
// O parser que o browser também importa. É servido estático, sob o mesmo prefixo que o
// `import` do `md.js` escreve (`../shared/doc.js`), para que o especificador resolva
// igual nos dois lados: no filesystem, para o Node; na URL, para o browser.
const SHARED = resolve(import.meta.dirname, '..', 'shared')

/** Um arquivo grande ou binário não vai para a gaveta; só o fato de existir importa. */
const TEXT_LIMIT = 512 * 1024

/** Prende um `path` vindo do cliente aos roots que o board pode ler. */
function safePath(input) {
  const p = resolve(input)
  const ok = [SCRATCH, PADS].some((r) => p === r || p.startsWith(r + sep))
  if (!ok) throw new Error('caminho fora dos diretórios permitidos')
  return p
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

// O `listen` fica atrás do teste de módulo principal: `node src/server.js` sobe o servidor,
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

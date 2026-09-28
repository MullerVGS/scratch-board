// As chaves temporárias da API de escrita (`api.js`), e o CLI que o humano usa para emiti-las.
//
// Uma chave é `sk_<id>_<segredo>`: o `id` é público (aparece no `list`, no `audit.log`, no
// `revoke`), o segredo só existe no momento do `issue`. O `keys.json` guarda o **sha256** do
// segredo, nunca ele — um volume vazado não entrega chave nenhuma.
//
// O arquivo é relido a **cada** `verify()`: o CLI roda em outro processo (`docker exec`), e um
// `revoke` tem que valer na próxima requisição, sem restart. O arquivo é pequeno; o custo é nada.
//
// Escopo é só a lista de origens (`*` = todas as montadas). Toda chave escreve. Validade máxima
// de 7 dias: chave que não expira vira a senha fixa que a borda do Pangolin já é.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join, resolve } from 'node:path'

const MAX_TTL = 7 * 86400e3
const UNIT = { m: 60e3, h: 3600e3, d: 86400e3 }

export const STATE_DIR = resolve(process.env.STATE_DIR ?? '/state')

export function parseTtl(ttl) {
  const [, n, unit] = /^(\d+)([mhd])$/.exec(String(ttl)) ?? []
  if (!n) throw new Error(`ttl "${ttl}" inválido: use 30m, 24h, 7d`)
  const ms = Number(n) * UNIT[unit]
  if (ms > MAX_TTL) throw new Error('ttl acima do máximo de 7 dias')
  return ms
}

const sha256 = (s) => createHash('sha256').update(s).digest()

export function createKeyStore(dir = STATE_DIR) {
  const file = join(dir, 'keys.json')

  const load = async () => {
    try {
      return JSON.parse(await readFile(file, 'utf8'))
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
  }

  const save = async (keys) => {
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
  }

  return {
    async issue({ origins, ttl = '24h', label = '', now = Date.now() }) {
      if (!origins?.length) throw new Error('--origins é obrigatório')
      const id = randomBytes(4).toString('hex')
      const secret = randomBytes(24).toString('base64url')
      const key = {
        id,
        hash: sha256(secret).toString('hex'),
        origins,
        label,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + parseTtl(ttl)).toISOString(),
      }
      await save([...(await load()), key])
      return { id, token: `sk_${id}_${secret}`, expiresAt: key.expiresAt }
    },

    async list() {
      return (await load()).map(({ hash, ...rest }) => rest)
    },

    /** `--all` revoga todas. Devolve quantas saíram. */
    async revoke(id) {
      const keys = await load()
      const kept = id === '--all' ? [] : keys.filter((k) => k.id !== id)
      await save(kept)
      return keys.length - kept.length
    },

    /** `{ ok: true, key }` ou `{ ok: false, reason }` — o motivo vai ao corpo do 401. */
    async verify(token) {
      const [, id, secret] = /^sk_([0-9a-f]{8})_([A-Za-z0-9_-]+)$/.exec(token ?? '') ?? []
      const key = id && (await load()).find((k) => k.id === id)
      if (!key || !timingSafeEqual(sha256(secret), Buffer.from(key.hash, 'hex'))) {
        return { ok: false, reason: 'token inválido' }
      }
      if (Date.parse(key.expiresAt) <= Date.now()) return { ok: false, reason: 'token expirado' }
      const { hash, ...rest } = key
      return { ok: true, key: rest }
    },
  }
}

// ---------- o CLI: `node src/keys.js issue|list|revoke` ----------

const flag = (args, name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}

async function cli([cmd, ...args]) {
  const store = createKeyStore()
  if (cmd === 'issue') {
    const origins = flag(args, 'origins', '').split(',').filter(Boolean)
    const { id, token, expiresAt } = await store.issue({ origins, ttl: flag(args, 'ttl', '24h'), label: flag(args, 'label', '') })
    console.log(`id:      ${id}\nexpira:  ${expiresAt}\ntoken:   ${token}\n(o token não é mostrado de novo)`)
  } else if (cmd === 'list') {
    const keys = await store.list()
    if (!keys.length) return console.log('nenhuma chave')
    for (const k of keys) {
      const state = Date.parse(k.expiresAt) <= Date.now() ? 'EXPIRADA' : 'ativa'
      console.log(`${k.id}  ${state.padEnd(8)}  ${k.expiresAt}  ${k.origins.join(',').padEnd(16)}  ${k.label}`)
    }
  } else if (cmd === 'revoke') {
    if (!args[0]) throw new Error('uso: revoke <id>|--all')
    console.log(`${await store.revoke(args[0])} revogada(s)`)
  } else {
    console.log('uso: node src/keys.js issue --origins a,b|* [--ttl 24h] [--label x] | list | revoke <id>|--all')
    process.exitCode = 1
  }
}

if (import.meta.filename === process.argv[1]) {
  cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message)
    process.exitCode = 1
  })
}

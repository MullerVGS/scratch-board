/**
 * Renderer de Markdown do board — o suficiente para os `.md` do `.scratch/`, e nada além.
 *
 * Não é um renderer de propósito geral: é o dialeto que as skills escrevem. Por isso
 * ele conhece coisas que um renderer genérico não conheceria — o cabeçalho
 * `Chave: valor` do preâmbulo vira metadado estruturado, `Blocked by:` vira link para
 * a issue, caminho de arquivo vira alvo copiável e link relativo vira navegação. É
 * justamente esse conhecimento que faz a gaveta valer mais que um `<pre>`.
 *
 * O HTML sai como string, com `data-ref` / `data-issue` / `data-open` nos alvos
 * interativos; quem amarra o comportamento é o `app.js`, que tem o board para
 * resolver os refs.
 */

const HEADER_KEYS = ['status', 'type', 'repo', 'blocked by', 'parent', 'label', 'prd']
const HEADER_LINE = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/

/**
 * O que parece caminho de arquivo do workspace.
 *
 * Deliberadamente conservador: ou começa num diretório que conhecemos, ou termina numa
 * extensão que conhecemos. Um regex frouxo transformaria "e/ou" num botão de copiar.
 */
const PATH_SRC =
  '(?:\\.scratch|\\.agents|docs|public|src)\\/[\\w./@-]+' +
  '|(?:[\\w.@-]+\\/)+[\\w.@-]+\\.(?:md|js|mjs|ts|tsx|json|ya?ml|css|html|py|sh|sql|conf|toml|env)'
const PATHS = () => new RegExp(PATH_SRC, 'g')
const IS_PATH = new RegExp(`^(?:${PATH_SRC})$`)

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** Caminho: clicar copia. Copia-se o que se lê — o texto na tela é o texto no clipboard. */
const pathChip = (p) =>
  `<button type="button" class="ref" data-ref="${esc(p)}" title="Copiar caminho">${esc(p)}</button>`

/** Referência a outra issue do mesmo esforço: clicar abre a issue na gaveta. */
const issueChip = (n) =>
  `<button type="button" class="issueref" data-issue="${esc(n)}" title="Abrir issue ${esc(n)}">${esc(n)}</button>`

/**
 * Link relativo (`[review-01.md](../review-01.md)`): abre o documento na própria gaveta.
 *
 * É assim que os documentos de um esforço se citam — o mapa aponta para as issues, a
 * issue aponta para o review. Renderizar só o rótulo jogaria fora o destino, que é a
 * única parte acionável; abrir numa aba nova jogaria fora o contexto. A gaveta navega.
 */
const docLink = (label, href) =>
  `<button type="button" class="doclink" data-open="${esc(href)}" title="Abrir ${esc(href)}">${label}</button>`

// Marcadores de substituição. Bytes de controle porque nenhum `.md` os contém: não há
// texto real que possa ser confundido com um marcador.
const NUL = String.fromCharCode(0) // trecho entre crases, ainda não resolvido
const SOH = String.fromCharCode(1) // HTML já pronto, fora do alcance dos regexes
const CODE_MARK = new RegExp(`${NUL}(\\d+)${NUL}`, 'g')
const HTML_MARK = new RegExp(`${SOH}(\\d+)${SOH}`, 'g')

/**
 * Inline: código, ênfase, link e caminho.
 *
 * Tudo que já virou HTML sai de cena — vira um marcador — e só volta no fim. Sem isso
 * as transformações se atropelam: o regex de caminho encontra o `href` que o regex de
 * link acabou de escrever e enfia um `<button>` dentro do atributo, gerando HTML
 * quebrado. O mesmo vale para as crases: um `*` dentro de um trecho de código viraria
 * itálico.
 *
 * Na volta, um trecho entre crases que *é* um caminho vira chip: é a forma mais comum
 * de citar arquivo nesses documentos, e é onde copiar mais serve. Dentro do rótulo de
 * um link, não — botão dentro de botão é HTML inválido, e ali o link já é a ação.
 */
function inline(text) {
  const codes = []
  const frags = []
  const stash = (html) => `${SOH}${frags.push(html) - 1}${SOH}`

  let s = String(text).replace(/`([^`]+)`/g, (_, c) => `${NUL}${codes.push(c) - 1}${NUL}`)

  s = esc(s)
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, label, href) =>
    stash(
      /^https?:/.test(href)
        ? `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
        : docLink(label, href),
    ),
  )
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
  s = s.replace(PATHS(), (p) => stash(pathChip(p)))

  // O HTML pronto volta primeiro; o código que morava dentro dele vira código puro.
  const asCode = (str) =>
    str.replace(CODE_MARK, (_, i) => `<code>${esc(codes[Number(i)])}</code>`)
  s = s.replace(HTML_MARK, (_, i) => asCode(frags[Number(i)]))

  // O código que sobrou está no corpo do texto: aí sim, caminho vira chip.
  return s.replace(CODE_MARK, (_, i) => {
    const raw = codes[Number(i)]
    return IS_PATH.test(raw.trim()) ? pathChip(raw.trim()) : `<code>${esc(raw)}</code>`
  })
}

/** O preâmbulo vai do topo até a primeira seção `## `. Só ali existe estado. */
const preambleEnd = (lines) => {
  const at = lines.findIndex((l) => l.startsWith('## '))
  return at === -1 ? lines.length : at
}

/**
 * `Blocked by:` não é uma lista de números — na prática é `01 (resolvido), 08 — a
 * revisão achou defeito no decayOffline; a bancada deve testar o binário corrigido`.
 *
 * Só o número que **abre** cada fragmento vira link; o resto continua prosa. Chipar
 * qualquer número do texto transformaria "a revisão 01 achou" num link, e engolir o
 * fragmento inteiro num chip esconderia a justificativa — que é justamente a parte
 * que você precisa ler antes de decidir furar a fila.
 */
function blockedValue(value) {
  return value
    .split(',')
    .map((part) => {
      const m = /^\s*(\d+)\s*(.*)$/.exec(part)
      if (!m) return `<span class="meta-note">${inline(part.trim())}</span>`
      return m[2] ? `${issueChip(m[1])} <span class="meta-note">${inline(m[2])}</span>` : issueChip(m[1])
    })
    .join('<span class="meta-note">, </span>')
}

/**
 * O cabeçalho vira uma tabela de metadados, não prosa.
 *
 * Os três dialetos do `.scratch/` põem as chaves antes ou depois do `# Título`; aqui
 * elas sempre aparecem logo abaixo dele. Normalizar a *exibição* não é normalizar o
 * arquivo — o `.md` continua exatamente como estava.
 */
function metaBlock(pairs) {
  if (!pairs.length) return ''
  const rows = pairs
    .map(([key, value]) => {
      const v =
        key === 'blocked by'
          ? blockedValue(value)
          : key === 'status'
            ? `<span class="chip" data-s="${esc(value)}">${esc(value)}</span>`
            : inline(value)
      return `<div class="meta-row"><span class="meta-k">${esc(key)}</span><span class="meta-v">${v}</span></div>`
    })
    .join('')
  return `<div class="meta">${rows}</div>`
}

const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

const LIST_ITEM = /^(\s*)(?:[-*+]|\d+\.)\s+(.*)$/
const TASK = /^\[([ xX])\]\s+(.*)$/

export function renderMarkdown(raw) {
  const lines = String(raw)
    .replace(/\r\n/g, '\n')
    // Comentário HTML é invisível em markdown, e os templates das skills usam-no para
    // instruir o agente (`<!-- uma linha por ticket fechado -->`). Escapá-lo o
    // transformaria em prosa: some antes de qualquer outra coisa.
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
  const end = preambleEnd(lines)

  // Cabeçalho e título saem do fluxo: são renderizados no topo, em ordem fixa.
  const meta = []
  const consumed = new Set()
  let title = null

  for (let i = 0; i < end; i++) {
    const t = lines[i].trim()
    if (title === null && t.startsWith('# ')) {
      title = t.slice(2).trim()
      consumed.add(i)
      continue
    }
    const m = HEADER_LINE.exec(t)
    const key = m && m[1].trim().toLowerCase()
    if (key && HEADER_KEYS.includes(key)) {
      meta.push([key, m[2].trim()])
      consumed.add(i)
    }
  }

  const out = []
  if (title) out.push(`<h1>${inline(title)}</h1>`)
  out.push(metaBlock(meta))

  let i = 0
  while (i < lines.length) {
    if (consumed.has(i)) {
      i++
      continue
    }
    const line = lines[i]
    const t = line.trim()

    if (!t) {
      i++
      continue
    }

    if (t.startsWith('```')) {
      const lang = t.slice(3).trim()
      const body = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++])
      i++ // a crase de fechamento
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`)
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) {
      const level = Math.min(h[1].length, 6)
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      i++
      continue
    }

    if (/^([-*_])\1{2,}$/.test(t)) {
      out.push('<hr />')
      i++
      continue
    }

    if (t.startsWith('>')) {
      const body = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        body.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(`<blockquote>${inline(body.join(' '))}</blockquote>`)
      continue
    }

    // Tabela: só é tabela se a linha seguinte for o separador. Uma linha solta com `|`
    // é prosa, e prosa não deve virar cabeçalho de tabela.
    if (t.startsWith('|') && lines[i + 1] && TABLE_SEP.test(lines[i + 1].trim())) {
      const head = cells(lines[i])
      i += 2
      const body = []
      while (i < lines.length && lines[i].trim().startsWith('|')) body.push(cells(lines[i++]))
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('')
      const tr = body.map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
      out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`)
      continue
    }

    if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items = []
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        const [, indent, text] = LIST_ITEM.exec(lines[i])
        const task = TASK.exec(text)
        const cls = indent.length >= 2 ? ' class="nested"' : ''
        items.push(
          task
            ? `<li${cls} data-task="${task[1].toLowerCase() === 'x' ? 'done' : 'open'}">${inline(task[2])}</li>`
            : `<li${cls}>${inline(text)}</li>`,
        )
        i++
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }

    // Parágrafo: acumula até a linha em branco ou até o próximo bloco começar.
    const para = []
    while (i < lines.length && !consumed.has(i)) {
      const cur = lines[i]
      const ct = cur.trim()
      if (!ct || ct.startsWith('```') || ct.startsWith('#') || ct.startsWith('>') || ct.startsWith('|')) break
      if (LIST_ITEM.test(cur) || /^([-*_])\1{2,}$/.test(ct)) break
      para.push(ct)
      i++
    }
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
  }

  return out.join('\n')
}

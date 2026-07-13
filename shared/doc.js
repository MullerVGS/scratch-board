/**
 * O dialeto do `.scratch/`, num lugar só.
 *
 * Este módulo é o parser dos `.md` que as skills escrevem: o cabeçalho `Chave: valor`,
 * o vocabulário de status, as colunas do board e o `Blocked by:` que promete uma lista
 * de números e entrega prosa.
 *
 * Ele existiu **duas vezes** — uma no `server.js`, outra no `public/md.js` — e as duas
 * cópias divergiram: o servidor guardava o fragmento inteiro do `Blocked by:` e o
 * procurava na lista de issues, o que nunca acha ninguém quando há prosa junto do
 * número, e a issue ficava silenciosamente **não bloqueada**. O renderer estava certo;
 * o servidor, errado; e não havia como saber qual. A razão da duplicação — um roda no
 * Node, o outro no browser — não sobrevive ao fato de os dois serem ESM no mesmo
 * filesystem: o servidor publica `shared/` em `/shared/`, e o browser importa daqui.
 *
 * **Nada neste arquivo pode tocar `node:` nem o DOM.** É o preço de ele rodar dos dois
 * lados, e é o que o mantém puro (`string → objeto`) e testável sem harness nenhum.
 */

export const OPEN = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'claimed', 'partial']
export const CLOSED = ['resolved', 'done', 'wontfix']
export const KNOWN = [...OPEN, ...CLOSED]

// Colunas do board. Um status desconhecido cai em `triagem` e o card mostra o rótulo cru,
// para que um vocabulário novo apareça em vez de sumir.
export const COLUMNS = [
  { id: 'triagem', label: 'Triagem', statuses: ['needs-triage', 'needs-info'] },
  { id: 'pronto', label: 'Pronto', statuses: ['ready-for-agent', 'ready-for-human'] },
  { id: 'curso', label: 'Em curso', statuses: ['claimed', 'partial'] },
  { id: 'fechado', label: 'Fechado', statuses: ['resolved', 'done', 'wontfix'] },
]

export const columnOf = (status) =>
  COLUMNS.find((c) => c.statuses.includes(status))?.id ?? 'triagem'

export const isClosed = (status) => CLOSED.includes(status)

export function normalizeStatus(value) {
  const s = (value ?? '').trim().toLowerCase()
  return KNOWN.includes(s) ? s : s ? `?${s}` : 'needs-triage'
}

// Chaves de cabeçalho reconhecidas. Restringir a esta lista impede que uma frase
// em prosa com dois-pontos ("Nota: ...") seja lida como estado.
export const HEADER_KEYS = ['status', 'type', 'repo', 'blocked by', 'parent', 'label', 'prd']

export const HEADER_LINE = /^([A-Za-z][A-Za-z ]*?):\s*(.*)$/

/** O preâmbulo vai do topo até a primeira seção `## `. Só ali existe estado. */
export const preambleEnd = (lines) => {
  const at = lines.findIndex((l) => l.startsWith('## '))
  return at === -1 ? lines.length : at
}

/**
 * Lê o cabeçalho `Chave: valor` do preâmbulo.
 *
 * O workspace tem três dialetos: o wayfinder põe as chaves antes do `# Título`;
 * o issue tracker e o restore-tui põem depois. Varrer o preâmbulo inteiro cobre
 * os três sem precisar saber qual é qual.
 */
export function parseDoc(raw) {
  const lines = raw.split('\n')
  const header = {}
  for (const line of lines.slice(0, preambleEnd(lines))) {
    const m = HEADER_LINE.exec(line)
    if (!m) continue
    const key = m[1].trim().toLowerCase()
    if (HEADER_KEYS.includes(key)) header[key] = m[2].trim()
  }
  const title = lines.find((l) => l.startsWith('# '))?.slice(2).trim()
  return { header, title }
}

/**
 * O primeiro parágrafo em prosa do documento — o que o esforço *é*, em uma frase.
 *
 * Um slug (`pos-2101-flapping-guard`) não conta história nenhuma, e abrir o PRD para
 * lembrar custa uma navegação. O parágrafo que o autor escreveu primeiro quase sempre
 * conta; é ele que o card mostra.
 *
 * **Começa depois do preâmbulo**, e essa é a decisão que faz o resumo prestar. O
 * preâmbulo é cabeçalho — e não só as chaves de `HEADER_KEYS`: os documentos trazem
 * `Data:`, `Labels:` e o que mais o autor inventar. Filtrar por lista de chaves
 * conhecidas deixaria "Data: 2026-07-12" virar o resumo de um PRD. A fronteira do
 * `## ` não depende de adivinhar chave nenhuma: acima dela é metadado, abaixo é texto.
 *
 * Documento sem seção alguma cai para o corpo inteiro — é tudo que ele tem.
 */
export function summarize(raw) {
  const lines = raw.split('\n')
  const start = preambleEnd(lines)
  const body = start === lines.length ? lines : lines.slice(start)

  const para = []
  let fenced = false

  for (const line of body) {
    const t = line.trim()
    if (t.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    // Bullet, tabela e citação ficam de fora: fora de contexto, informam menos que nada.
    const prose =
      t &&
      !t.startsWith('#') &&
      !t.startsWith('|') &&
      !t.startsWith('>') &&
      !t.startsWith('---') &&
      !/^([-*+]|\d+\.)\s/.test(t)

    if (prose) para.push(t)
    else if (para.length) break // o primeiro parágrafo basta
  }

  const text = para.join(' ').replace(/[*`]/g, '')
  return text.length > 320 ? `${text.slice(0, 317).trimEnd()}…` : text
}

/**
 * Quebra o `Blocked by:` em fragmentos — **todos** eles, com número ou sem.
 *
 * `Blocked by:` promete uma lista de números e entrega prosa: `01 (resolvido), 08 — a
 * revisão achou defeito no decayOffline; a bancada deve testar o binário corrigido`.
 * Só o número que **abre** cada fragmento separado por vírgula é referência; o resto é
 * a justificativa, e é o que se lê antes de decidir furar a fila.
 *
 * Cada fragmento carrega o `number` canônico de dois dígitos (é ele que resolve a
 * aresta, porque os arquivos são numerados a partir de `01`), o `label` como o autor
 * escreveu (é ele que a gaveta mostra), a `note` e o fragmento cru.
 *
 * Fragmento sem número que o abra (`(nada — pode começar já)`) vem com `number: null`:
 * ele não referencia issue nenhuma, mas continua sendo prosa a ser lida — o servidor o
 * descarta (ver `parseBlockedBy`), o renderer o mostra.
 */
export const splitBlockedBy = (value) =>
  (value ?? '').split(',').map((part) => {
    const raw = part.trim()
    const m = /^\s*(\d+)\s*(.*)$/.exec(part)
    return m
      ? { number: m[1].padStart(2, '0'), label: m[1], note: m[2].trim(), raw }
      : { number: null, label: null, note: raw, raw }
  })

/**
 * As dependências de verdade: os fragmentos que abrem com número.
 *
 * Casar o fragmento inteiro contra a lista de issues nunca acha ninguém quando há prosa
 * junto do número — foi exatamente assim que o bloqueio sumiu em silêncio no servidor.
 *
 * O `label` fica de fora de propósito: isto é o que o `/api/board` serializa, e é
 * contrato — o número canônico resolve a aresta, e como o autor o escreveu só interessa
 * a quem *mostra* o fragmento (a gaveta), não a quem o resolve.
 */
export const parseBlockedBy = (value) =>
  splitBlockedBy(value)
    .filter((d) => d.number)
    .map(({ number, note, raw }) => ({ number, note, raw }))

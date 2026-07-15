/**
 * As issues de um esforço, como objetos — **sem DOM**.
 *
 * É o vocabulário que o kanban, o grafo e a gaveta compartilham: qual é o título
 * limpo, quem depende de quem, o que ainda segura quem.
 */

/**
 * O título do arquivo costuma repetir o número (`06 — Task: ...`), que o card já
 * mostra à esquerda. Some com o prefixo — inclusive no texto copiado, porque o que
 * se cola num prompt é o nome da issue, não a numeração dela.
 */
export const cleanTitle = (issue) =>
  issue.number ? issue.title.replace(new RegExp(`^0*${Number(issue.number)}\\s*[—–-]\\s*`), '') : issue.title

/** Índice por número canônico (dois dígitos) — é ele que resolve a referência do `Blocked by:`. */
export const numberIndex = (issues) => new Map(issues.map((i) => [i.number.padStart(2, '0'), i]))

/**
 * As referências do `Blocked by:` são locais ao esforço (`01`, `02`) — o grafo de um
 * esforço nunca alcança outro. Uma referência a issue inexistente é descartada aqui:
 * não há nó para ligar, e o servidor já não a conta como bloqueio. Auto-referência
 * também cai: um nó não é aresta para si mesmo.
 */
export function depsOf(issue, byNumber) {
  return issue.blockedBy
    .map((d) => ({ ...d, dep: byNumber.get(d.number) }))
    .filter((d) => d.dep && d.dep !== issue)
}

/** As dependências que ainda seguram a issue — as fechadas já cumpriram o papel delas. */
export const openDeps = (issue, effort) =>
  depsOf(issue, numberIndex(effort.issues)).filter((d) => !d.dep.closed)

/**
 * **O piso abaixo do qual o rótulo não informa.** Um ticket que entrou na coluna há segundos
 * não diz encalhe nenhum — `"em curso há 0min"` é ruído. Abaixo de um minuto, o card cala.
 *
 * Ele mora no cliente pela mesma razão que o relativo mora: fosse um corte do servidor, o
 * ticket cruzando o limiar **enquanto ninguém escreve** mudaria o payload, e a varredura de
 * 90s empurraria o board sozinho. O servidor manda o fato imóvel (`issue.held.at`); quem
 * envelhece é o relógio de quem olha.
 */
export const MIN_COLUMN_MS = 60_000

/**
 * O intervalo `ms` na **maior unidade que ainda informa** — a conta que o card faz para
 * `"em <coluna> há N"`. Boa parte do trabalho aqui dura menos de um dia, e um rótulo preso em
 * dias diria `"há 0 dias"` o tempo todo; então ele desce: **dias**, senão **horas**, senão
 * **minutos**. É a única razão de o servidor mandar o instante ao segundo, e não um dia.
 */
function elapsed(ms) {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d} ${d === 1 ? 'dia' : 'dias'}`
}

/**
 * O rótulo do card: **`"em pronto há 6 dias"`** — o tempo na coluna atual —, ou `null` quando
 * ele não informa nada. Lê `issue.held = { at, floor }`, o instante absoluto em que o ticket
 * entrou na coluna e se esse instante é fato ou piso.
 *
 * - **Piso** (`floor`): o servidor nunca viu o ticket entrar nessa coluna, só o encontrou já
 *   nela — o `≥` diz isso (`"em pronto há ≥3 dias"`), e some sozinho quando a transição é
 *   observada. O viés está no lado seguro: subestima o encalhe, jamais o esconde.
 * - **Issue fechada nunca recebe rótulo** — está pronta, não parada. Um `"em fechado há N"`
 *   seria uma data verdadeira contando uma história falsa.
 * - **Sem `held.at`, nada é dito** — o catálogo ainda não sabe, e não se inventa uma data.
 * - **Abaixo de um minuto, nada é dito** — acabou de entrar, não informa (ver `MIN_COLUMN_MS`).
 *
 * O `now` entra por parâmetro porque a conta é pura — e é assim que ela se testa sem relógio
 * nenhum a mockar.
 */
export function columnLabel(issue, now = Date.now()) {
  if (issue.closed) return null
  const at = issue.held?.at
  if (!at) return null
  const ms = now - Date.parse(at)
  if (ms < MIN_COLUMN_MS) return null
  const prefix = issue.held.floor ? '≥' : ''
  return `em ${issue.column} há ${prefix}${elapsed(ms)}`
}

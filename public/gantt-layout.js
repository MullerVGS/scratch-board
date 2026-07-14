/**
 * O layout do Gantt — **puro**, sem uma linha de DOM.
 *
 * É o grafo com o X virando tempo: as mesmas setas do `Blocked by:`, e a profundidade
 * trocada pelo eixo de datas que o disco sempre soube (`created` como piso, `touched` como
 * resolução). Recebe issues (objetos) e devolve geometria (números); quem desenha é o
 * `gantt.js`. A separação não é cosmética — é o que torna os invariantes testáveis sem um
 * navegador (`test/gantt-layout.test.js`), e o precedente do grafo já pagou essa aposta.
 *
 * O "hoje" entra **por parâmetro**: um relógio aqui dentro faria o desenho depender de
 * quando ele rodou, e os testes virariam loteria de meia-noite. Quem sabe que horas são é
 * quem desenha — a mesma doutrina do `now` do `staleLabel()`.
 */
import { depsOf } from './issues.js'

export const LABEL_W = 220
export const BAR_H = 28
export const ROW_GAP = 10
export const PAD = 18
export const AXIS_H = 24

/**
 * O passo de um dia em pixels se ajusta ao vão do esforço — um de três dias não pode caber
 * em três lascas, e um de meses não pode medir quilômetros —, mas dentro de limites: abaixo
 * do mínimo os tiques se atropelam, acima do máximo um dia vira um deserto.
 */
const TARGET_W = 720
const MIN_DAY_W = 24
const MAX_DAY_W = 96

/** Dias inteiros em UTC, dos dois lados — misturar dia local com carimbo UTC é que erraria. */
const dayNum = (day) => Math.floor(Date.parse(day) / 864e5)
const dayISO = (n) => new Date(n * 864e5).toISOString().slice(0, 10)

/**
 * As bordas de uma barra são fatos, cada um do seu jeito:
 *
 * - **direita de ticket fechado** = o `touched` (o dia do `mtime`): a última escrita num
 *   ticket `resolved` *foi* a que o fechou;
 * - **direita de ticket aberto** = hoje — a barra mostra o quanto ele já está custando;
 * - **esquerda** = o `created`, que hoje é um **piso** (o nascimento do diretório do
 *   esforço) e viaja marcado como tal. Piso não é fato, e a barra sai de borda aberta.
 * - **sem `created` nenhum**, não se inventa: a barra se ancora na única data que existe —
 *   a própria borda direita — e se declara incerta. Data podre mente com mais confiança
 *   que a ausência dela.
 *
 * E o disco pode contradizer o piso (um `cp -p` fabrica `mtime` anterior ao `mkdir`): a
 * barra se recolhe à borda direita em vez de nascer com largura negativa.
 */
function spanOf(issue, today) {
  const end = issue.closed && issue.touched ? dayNum(issue.touched) : dayNum(today)
  const start = issue.created ? Math.min(dayNum(issue.created.day), end) : end
  return { start, end, floor: !issue.created || issue.created.floor !== false }
}

/**
 * As linhas contam a história na ordem em que ela aconteceu: quem fechou primeiro vem
 * primeiro, e as abertas — que correm até hoje — afundam para o fim. No empate, fechada
 * antes de aberta (terminar é anterior a continuar), e depois o número, para a ordem não
 * flutuar entre duas rodadas do mesmo dado.
 */
const byResolution = (spans) => (a, b) =>
  spans.get(a).end - spans.get(b).end ||
  (a.closed === b.closed ? a.number.localeCompare(b.number) : a.closed ? -1 : 1)

export function ganttLayout(issues, byNumber, today) {
  if (!issues.length) {
    return {
      bars: [],
      arrows: [],
      ticks: [],
      todayX: null,
      dayW: MIN_DAY_W,
      width: LABEL_W + PAD * 2,
      height: AXIS_H + PAD * 2,
    }
  }

  const spans = new Map(issues.map((i) => [i, spanOf(i, today)]))
  const rows = [...issues].sort(byResolution(spans))

  const minDay = Math.min(...[...spans.values()].map((s) => s.start))
  const maxDay = Math.max(...[...spans.values()].map((s) => s.end))
  const span = Math.max(maxDay - minDay, 1)
  const dayW = Math.max(MIN_DAY_W, Math.min(MAX_DAY_W, Math.round(TARGET_W / span)))
  const x = (d) => LABEL_W + PAD + (d - minDay) * dayW

  const bars = rows.map((issue, ri) => {
    const s = spans.get(issue)
    return {
      issue,
      x: x(s.start),
      y: AXIS_H + PAD + ri * (BAR_H + ROW_GAP),
      // Menos de um dia vira uma lasca visível — zero pixels seria a tela escondendo um
      // ticket que existiu.
      w: Math.max((s.end - s.start) * dayW, 4),
      floor: s.floor,
      open: !issue.closed,
    }
  })
  const barOf = new Map(bars.map((b) => [b.issue, b]))

  // A seta sai da resolução do bloqueante e entra na barra do bloqueado **dali em diante**
  // (`max`): no leque da fatia 1 todo mundo nasce do mesmo piso, e apontar para a borda
  // esquerda do bloqueado seria a seta voltando no tempo. Não há recursão aqui — cada
  // aresta é geometria própria —, então ciclo não tem como estourar; a referência morta o
  // `depsOf` já descarta.
  //
  // E quando o disco diz que o bloqueado fechou ANTES do bloqueante, a seta aponta para
  // além da barra dele — para o vazio. É escolha, não descuido: as duas constâncias ("nunca
  // para trás no tempo" e "entra na barra") são inconciliáveis nesse dado, a primeira é
  // acceptance criteria, e a seta no vazio é a contradição do disco ficando visível em vez
  // de redesenhada como se fizesse sentido.
  const arrows = []
  for (const issue of issues) {
    for (const { dep, note, raw } of depsOf(issue, byNumber)) {
      const from = barOf.get(dep)
      const to = barOf.get(issue)
      const x1 = from.x + from.w
      arrows.push({
        from: dep,
        to: issue,
        note,
        raw,
        blocking: !dep.closed,
        x1,
        y1: from.y + BAR_H / 2,
        x2: Math.max(x1, to.x),
        y2: to.y > from.y ? to.y : to.y + BAR_H,
      })
    }
  }

  // O eixo: tiques diários enquanto se leem; semanais e depois mensais quando o vão cresce.
  const step = span <= 14 ? 1 : span <= 98 ? 7 : 30
  const ticks = []
  for (let d = minDay; d <= maxDay; d += step) ticks.push({ day: dayISO(d), x: x(d) })

  // A linha de "hoje" — só quando hoje cabe no desenho. Num esforço encerrado no passado,
  // marcá-lo seria esticar o eixo para apontar um dia em que nada daqui aconteceu.
  const t = dayNum(today)
  return {
    bars,
    arrows,
    ticks,
    todayX: t >= minDay && t <= maxDay ? x(t) : null,
    dayW,
    width: x(maxDay) + PAD,
    height: AXIS_H + PAD * 2 + rows.length * (BAR_H + ROW_GAP) - ROW_GAP,
  }
}

/**
 * Sai da ponta do bloqueante e entra pela borda horizontal do bloqueado — um S vertical,
 * que degenera numa reta quando a queda é a pino (x1 === x2, o caso comum no leque).
 */
export function arrowPath({ x1, y1, x2, y2 }) {
  const ym = (y1 + y2) / 2
  return `M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`
}

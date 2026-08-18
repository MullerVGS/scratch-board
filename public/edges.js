/**
 * A maquinaria de setas do grafo: os `<marker>` e o traço com a prosa do `Blocked by:` no
 * tooltip. Vive à parte para existir **uma vez** — cópia que diverge é dívida, como o parser
 * já ensinou. Tudo aqui é `svg()`, nunca `el()`: um `<marker>` montado como HTML nasce fora do
 * namespace SVG e o navegador o aceita e **ignora** — as setas somem sem erro nenhum. O
 * `prefix` dos ids mantém os marcadores num escopo próprio, longe de qualquer outro `<defs>`
 * que um dia divida o DOM.
 */
import { svg } from './dom.js'

export const EDGE_KINDS = ['blocking', 'satisfied']

/** Os dois marcadores de ponta — sólido para o bloqueio vivo, o mesmo desenho para o cumprido. */
export function edgeDefs(prefix) {
  const defs = svg('defs', {})
  for (const kind of EDGE_KINDS) {
    const marker = svg('marker', {
      id: `${prefix}-arrow-${kind}`,
      viewBox: '0 0 8 8',
      refX: 7,
      refY: 4,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto-start-reverse',
    })
    marker.append(svg('path', { d: 'M 0 0 L 8 4 L 0 8 z', class: `arrow ${kind}` }))
    defs.append(marker)
  }
  return defs
}

/**
 * Um traço de aresta: a curva, a ponta e a justificativa do bloqueio no hover — a prosa
 * depois do número é o que se lê antes de decidir furar a fila.
 */
export function edgeEl(prefix, { d, blocking, from, to, note, raw }) {
  const kind = blocking ? 'blocking' : 'satisfied'
  const path = svg('path', {
    class: `gedge ${kind}`,
    d,
    'marker-end': `url(#${prefix}-arrow-${kind})`,
  })
  const tip = svg('title', {})
  tip.textContent = note ? `${from.number} → ${to.number}: ${note}` : `${from.number} → ${to.number}`
  path.append(tip)
  path.setAttribute('data-raw', raw)
  return path
}

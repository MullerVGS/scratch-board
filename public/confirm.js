/**
 * O gesto que transforma uma lembrança em fato confirmado. O desenho acompanha o ponteiro
 * continuamente; só o `pointerup` arredonda para a hora e escreve no catálogo.
 */
import { api, el, toast } from './dom.js'

const HOUR = 3600e3
const snap = (at) => Math.round(at / HOUR) * HOUR

const handles = () => [
  el('<span class="gdrag-handle gdrag-left" aria-hidden="true"></span>'),
  el('<span class="gdrag-handle gdrag-right" aria-hidden="true"></span>'),
]

/**
 * Liga move/resize a uma barra. Menos de 3px continua sendo clique; acima disso é confirmação.
 * `range` está em ms e `target` é a identidade estável do catálogo, nunca um caminho de arquivo.
 */
export function draggableConfirmation(node, { range, pxPerMs, target, onClick }) {
  node.append(...handles())
  node.tabIndex = 0
  node.setAttribute('role', 'button')

  node.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      onClick?.()
    }
  }

  node.onpointerdown = (down) => {
    if (down.button !== 0) return
    down.preventDefault()
    down.stopPropagation()

    const mode = down.target.closest('.gdrag-left')
      ? 'resizeLeft'
      : down.target.closest('.gdrag-right')
        ? 'resizeRight'
        : 'move'
    const original = { left: node.style.left, width: node.style.width }
    const startX = down.clientX
    let current = { ...range }

    const move = (ev) => {
      ev.preventDefault()
      const delta = (ev.clientX - startX) / pxPerMs
      if (mode === 'move') current = { start: range.start + delta, end: range.end + delta }
      if (mode === 'resizeLeft') current = { start: Math.min(range.end, range.start + delta), end: range.end }
      if (mode === 'resizeRight') current = { start: range.start, end: Math.max(range.start, range.end + delta) }
      node.style.left = `${Number.parseFloat(original.left) + (current.start - range.start) * pxPerMs}px`
      node.style.width = `${Math.max(2, (current.end - current.start) * pxPerMs)}px`
    }

    const up = async (ev) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (Math.abs(ev.clientX - startX) < 3) {
        node.style.left = original.left
        node.style.width = original.width
        onClick?.()
        return
      }

      const start = snap(current.start)
      const end = Math.max(start, snap(current.end))
      try {
        await api('/api/confirm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...target, start: new Date(start).toISOString(), end: new Date(end).toISOString() }),
        })
        toast('Intervalo confirmado no catálogo')
      } catch (err) {
        node.style.left = original.left
        node.style.width = original.width
        toast(`Não foi possível confirmar: ${err.message}`)
      }
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return node
}

/**
 * Utilidades de DOM, de rede e de copiar. É o que todas as views usam e nenhuma
 * delas deveria reimplementar.
 */

export const api = async (path, opts) => {
  const res = await fetch(path, opts)
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? res.statusText)
  return body
}

/** Monta **HTML**. Para SVG, use o `svg()` abaixo — e leia o porquê antes de trocá-los. */
export const el = (html) => {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

/**
 * Monta um nó no **namespace SVG**, e existe exatamente por isso.
 *
 * `el()` monta HTML: um `<defs>`/`<marker>` construído por ele nasceria no
 * namespace HTML, e o navegador o **aceita e ignora** — as setas do grafo somem
 * sem erro nenhum, sem aviso no console, sem nada. Não é redundância com o `el()`:
 * é a única forma de o marcador existir de verdade.
 */
export const svg = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  return node
}

/**
 * Faz um nó "apertável": clique, Enter e espaço disparam a mesma ação. É o contrato dos
 * cards, dos nós do grafo e das barras do Gantt — tudo que tem `role="button"` sem ser um
 * `<button>` precisa dos três, ou o teclado fica de fora.
 */
export function pressable(node, fn) {
  node.onclick = fn
  node.onkeydown = (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault()
      fn()
    }
  }
  return node
}

export const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function toast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (t.hidden = true), 2600)
}

export async function copy(text, msg) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // clipboard API exige contexto seguro; em http://localhost o fallback cobre o resto
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  toast(msg)
}

/**
 * Botão de copiar. Fica no DOM sempre (invisível até hover ou foco), para que o
 * teclado o alcance; confirma na própria affordance — o ✓ diz *o que* foi copiado,
 * coisa que um toast no rodapé não diz quando há vários botões na tela.
 *
 * Para o `stopPropagation`: quase todo alvo copiável mora dentro de algo clicável
 * (card que navega, linha que abre a gaveta). Copiar não é navegar.
 */
export function copyBtn(text, what, label = null) {
  const b = el(`
    <button class="copy ${label ? 'labelled' : ''}" type="button"
            aria-label="Copiar ${esc(what)}" title="Copiar ${esc(what)}">
      <span class="ico" aria-hidden="true"></span>${label ? `<span>${esc(label)}</span>` : ''}
    </button>
  `)
  b.onclick = (ev) => {
    ev.stopPropagation()
    copy(text, `Copiado: ${what}`)
    b.classList.add('done')
    clearTimeout(b.timer)
    b.timer = setTimeout(() => b.classList.remove('done'), 1400)
  }
  return b
}

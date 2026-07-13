/**
 * A moldura: os três pontos fixos da página que toda view escreve, mais as duas coisas
 * que o cabeçalho diz sobre o próprio board — se ele ainda está ouvindo, e o botão que
 * força a releitura quando você não confia no que está vendo.
 *
 * `view` é onde a tela é montada, `crumbs` é a trilha do topo e `tally` é a contagem
 * à direita.
 *
 * **A honestidade da conexão.** Um board que empurra falha em silêncio, e silêncio é
 * indistinguível de "nada mudou": sem indicador, o servidor morto e o board parado têm o
 * mesmo pixel. O pontinho do `<h1>` é o que distingue os dois — verde ouvindo, âmbar
 * tentando voltar, vermelho quando desistiu de fingir. Ele é a única coisa na tela que
 * pode dizer *não sei*, e é por isso que ele existe.
 */
import { el, toast } from './dom.js'

export const view = document.getElementById('view')
export const crumbs = document.getElementById('crumbs')
export const tally = document.getElementById('tally')

const dot = document.querySelector('h1 .dot')

/** Quanto tempo tentando reconectar antes de admitir que o servidor não está lá. */
const DEAD_MS = 6000
/** Piso da animação do botão: um giro que dura 20ms não é feedback, é um piscar. */
const SPIN_MS = 420

const LABEL = {
  live: 'conectado — o board chega sozinho',
  retry: 'reconectando…',
  dead: 'sem conexão com o servidor — o que você vê pode estar velho',
}

let deadTimer = null

/** O estado da conexão vira um atributo; a cor e o pulso são do CSS (`shell.css`). */
function setConn(state) {
  dot.dataset.conn = state
  dot.title = LABEL[state]
  dot.setAttribute('aria-label', LABEL[state])
}

const nap = (ms) => new Promise((ok) => setTimeout(ok, ms))

/** A válvula de escape: relê o board por HTTP, agora, porque você mandou. */
function mountRefresh(onRefresh) {
  const btn = el(`
    <button id="refresh" class="icon refresh" type="button"
            title="Reler o board do disco" aria-label="Reler o board do disco">⟳</button>
  `)

  btn.onclick = async () => {
    btn.classList.add('spin')
    btn.disabled = true
    try {
      // O `/api/board` não serve cache: ele relê o disco de verdade (e, se algo tiver
      // mudado, as outras abas recebem o push). O botão não é uma mentira.
      // O `nap` é só para o giro ser visível — o board costuma voltar antes dele.
      await Promise.all([onRefresh(), nap(SPIN_MS)])
      toast('Board relido do disco')
    } catch (err) {
      toast(`Falha ao reler: ${err.message}`)
    } finally {
      btn.disabled = false
      btn.classList.remove('spin')
    }
  }

  tally.after(btn)
  return btn
}

/** Desistiu: o servidor não voltou, e o board para de fingir que sabe. */
function die() {
  clearTimeout(deadTimer)
  deadTimer = null
  setConn('dead')
}

/**
 * Liga o cabeçalho ao stream: o pontinho passa a contar a verdade sobre a conexão, e o
 * botão de refresh ganha o que chamar.
 *
 * O `EventSource` reconecta sozinho, então um erro **não** é a morte — `readyState`
 * `CONNECTING` é ele tentando de novo, e é isso que o âmbar diz. Só depois de `DEAD_MS`
 * sem conseguir voltar é que o indicador vira vermelho: dizer "morto" no primeiro soluço
 * seria tão desonesto quanto continuar verde com o servidor no chão.
 *
 * A contagem é desde a última vez que o stream esteve **aberto**, não desde o último
 * erro — e a distinção não é sutil, é a diferença entre funcionar e não funcionar. O
 * `EventSource` erra a cada tentativa (`retry: 2000`), então rearmar o relógio a cada
 * erro o adiaria para sempre: o indicador ficaria âmbar, eternamente "reconectando", com
 * o servidor no chão. Foi assim que ele nasceu, e foi o navegador que denunciou.
 */
export function bindConnection(source, onRefresh) {
  mountRefresh(onRefresh)
  setConn('retry') // ainda não abriu: o board só fica verde quando o stream responde

  source.onopen = () => {
    clearTimeout(deadTimer)
    deadTimer = null
    setConn('live')
  }

  source.onerror = () => {
    // `CLOSED` é o fim de linha: o `EventSource` não tenta mais, e nem adianta esperar.
    if (source.readyState === EventSource.CLOSED) return die()
    // Já admitiu que não sabe. Continua tentando, calado — voltar para o âmbar a cada
    // tentativa seria piscar de vermelho a âmbar de dois em dois segundos para sempre.
    if (dot.dataset.conn === 'dead') return
    setConn('retry')
    deadTimer ??= setTimeout(die, DEAD_MS)
  }
}

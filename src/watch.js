// O disco falando. E só isso: este módulo **emite**, não decide.
//
// `fs.watch` é barulhento por natureza — um único `Write` de agente dispara `rename` *e*
// `change`, e um esforço que nasce com seis arquivos dispara mais de uma dúzia de eventos
// em poucos milissegundos. Quem reconstruísse o board a cada evento reconstruiria seis
// vezes o mesmo board e empurraria seis vezes a mesma tela.
//
// Daí o debounce: o evento não emite nada, ele arma um timer curto e rearma se outro
// chegar. O que sai daqui é **uma** notificação com a lista dos caminhos que mexeram.
//
// O que o watcher não sabe: o que é um board, o que é um hash, quem está assistindo. Quem
// decide o que fazer com "algo mudou" é o `cache.js`, e é essa fronteira que torna a
// supressão testável — o cache pode ser exercitado sem um disco vivo por baixo.

import { watch } from 'node:fs'
import { join } from 'node:path'

const DEBOUNCE_MS = 120
// O modo de falha de um sistema de push é o **silêncio**, e silêncio é indistinguível de
// "nada mudou". Um watcher morto (limite de inotify, root removido e recriado) deixaria o
// board mostrando dados velhos com cara de vivos — pior que o polling que estamos matando.
// Então uma falha do watch não é fatal nem silenciosa: ele se derruba e tenta de novo.
const RETRY_MS = 2000

/**
 * Vigia `root` recursivamente e chama `onChange(paths)` uma vez por rajada.
 *
 * Devolve a função que encerra o watch. `paths` são caminhos absolutos, deduplicados.
 */
export function watchTree(root, onChange, { debounce = DEBOUNCE_MS, retry = RETRY_MS } = {}) {
  let watcher = null
  let timer = null
  let retryTimer = null
  let closed = false
  let touched = new Set()

  const flush = () => {
    timer = null
    const paths = [...touched]
    touched = new Set()
    onChange(paths)
  }

  const arm = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(flush, debounce)
  }

  const reopen = () => {
    if (closed || retryTimer) return
    try { watcher?.close() } catch { /* já morto */ }
    watcher = null
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, retry)
    // Não é o watcher que segura o processo de pé — é o servidor HTTP.
    retryTimer.unref?.()
  }

  const open = () => {
    if (closed) return
    try {
      // Recursivo: um esforço novo é um **diretório** novo, e ele tem que aparecer sem
      // reiniciar nada. Verificado: o inotify atravessa o bind mount `:ro` do container,
      // o recursivo funciona no ext4, e ele pega arquivo criado dentro de diretório que
      // nasceu *depois* do watch começar.
      watcher = watch(root, { recursive: true }, (_type, name) => {
        if (name) touched.add(join(root, name))
        arm()
      })
      watcher.on('error', reopen)
    } catch {
      reopen()
    }
  }

  open()

  return () => {
    closed = true
    if (timer) clearTimeout(timer)
    if (retryTimer) clearTimeout(retryTimer)
    try { watcher?.close() } catch { /* já morto */ }
  }
}

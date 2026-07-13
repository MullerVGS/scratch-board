/**
 * O ponto de entrada — e só isso.
 *
 * O board é um assunto por módulo: `dom.js` (DOM, rede e copiar), `shell.js` (a
 * moldura), `state.js` (o board na mão do cliente), `prompts.js` (o comando que
 * destrava cada estado), `issues.js` e `graph-layout.js` (puros, sem DOM),
 * `overview.js`, `effort.js`, `graph.js`, `pads.js`, `drawer.js` e `router.js`.
 *
 * Aqui só se liga o fio: a gaveta ao documento, o hash ao roteador, e o board à tela.
 */
import { esc } from './dom.js'
import { view } from './shell.js'
import { initDrawer } from './drawer.js'
import { route, refresh } from './router.js'

initDrawer()

addEventListener('hashchange', route)

refresh().catch((err) => {
  view.innerHTML = `<p class="empty">Falha ao ler o board: ${esc(err.message)}</p>`
})

// O board pergunta ao disco a cada 5s porque ninguém o avisa. É o que o push vem matar.
setInterval(() => refresh().catch(() => {}), 5000)

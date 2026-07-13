/**
 * Do estado de um esforço/issue para o comando que o destrava.
 *
 * O board não invoca skill nenhuma: ele monta o comando com os caminhos certos e
 * te dá o texto. Quem julga é o agente, e a decisão de disparar é sua.
 *
 * Os caminhos vêm do `ref` que o servidor calcula — o nome do arquivo no
 * workspace, não no container. Colar `/workspace/.scratch/...` num agente não leva
 * a lugar nenhum.
 *
 * **Se o vocabulário de skills mudar, é aqui — e só aqui.** O mapeamento inteiro vive
 * em `effortPrompts()` e `issuePrompts()`; é onde ele deve continuar.
 */
import { el, esc, copyBtn } from './dom.js'

/** Os documentos do esforço são objetos (`{name, title, blurb}`), não nomes soltos. */
export const hasDoc = (effort, name) => effort.docs.some((d) => d.name === name)

export function effortPrompts(e, archived) {
  if (archived) return []
  const out = []

  // O wayfinder é o resolve-tudo: onde existe mapa, ele escolhe o ticket, reivindica
  // e resolve. Não há o que decidir aqui, então vem primeiro.
  if (hasDoc(e, 'map.md')) {
    out.push({
      cmd: `/wayfinder ${e.ref}/map.md`,
      hint: 'trabalha o mapa: pega o próximo ticket da frontier e resolve',
      primary: !e.archivable,
    })
  }
  if (e.archivable) {
    out.push({
      cmd: `/scratch archive ${e.slug}`,
      hint: 'destila o aprendizado em memória e move para archive/',
      primary: true,
    })
  }
  if (!e.total && hasDoc(e, 'PRD.md')) {
    out.push({ cmd: `/to-tickets ${e.ref}/PRD.md`, hint: 'decompõe o PRD em issues com arestas de bloqueio' })
  }
  if (!e.total && !hasDoc(e, 'PRD.md') && !hasDoc(e, 'map.md')) {
    out.push({ cmd: `/wayfinder`, hint: 'esforço sem documento: charte o mapa a partir da ideia solta' })
  }
  return out
}

export function issuePrompts(i, e, archived) {
  if (archived || i.column === 'fechado') return []
  // Bloqueada não é trabalhável: oferecer o comando seria convidar a furar a fila.
  if (i.blocked) return []

  // Ticket de wayfinder — tem `Type:` e um mapa acima dele. O comando é o do mapa
  // com o ticket nomeado: a skill reivindica, resolve e atualiza o Decisions-so-far.
  if (i.type && hasDoc(e, 'map.md')) {
    return [{ cmd: `/wayfinder ${e.ref}/map.md ${i.ref}`, hint: `ticket ${i.type} — reivindica e resolve`, primary: true }]
  }
  if (i.status === 'needs-triage' || i.status === 'needs-info') {
    return [{ cmd: `/triage ${i.ref}`, hint: 'categoriza, verifica e escreve o brief para o agente' }]
  }
  if (i.status === 'ready-for-agent') {
    return [{ cmd: `/implement ${i.ref}`, hint: 'implementa a issue', primary: true }]
  }
  if (i.status === 'ready-for-human') {
    return [{ cmd: `/grilling ${i.ref}`, hint: 'é sua: grelhe a decisão antes de escrevê-la' }]
  }
  return []
}

/** O comando aparece literal: você copia o que leu, não uma caixa-preta. */
function promptRow(p) {
  const row = el(`
    <div class="prompt ${p.primary ? 'primary' : ''}">
      <code>${esc(p.cmd)}</code>
      <span class="hint">${esc(p.hint)}</span>
    </div>
  `)
  row.append(copyBtn(p.cmd, 'comando', 'copiar'))
  return row
}

export function promptStrip(prompts) {
  if (!prompts.length) return null
  const strip = el('<div class="prompts"></div>')
  for (const p of prompts) strip.append(promptRow(p))
  return strip
}

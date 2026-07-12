# scratch-board

Board de leitura para um diretório `.scratch/` — os esforços em curso, os documentos de cada um, e o comando que destrava o próximo passo.

Um esforço é uma pasta com um `PRD.md`, um `map.md` e issues numeradas. O board varre tudo, mostra em que estado cada coisa está, e deixa você ler o documento sem sair da página.

- **Esforços** com título e resumo, para lembrar do que se trata sem abrir o arquivo.
- **Issues** com status, bloqueios e o `Blocked by:` como link para a issue bloqueante.
- **Gaveta** que renderiza o markdown, navega pelos links relativos entre documentos e volta pela trilha.
- **Comando por estado**: cada esforço e cada issue mostram, pronto para copiar, o comando que os move — e o que está bloqueado não mostra nenhum.

Esse último ponto é o encaixe com o [mattpocock/skills](https://github.com/mattpocock/skills): `wayfinder`, `to-tickets`, `triage`, `implement`. O board conhece o vocabulário delas e monta a invocação com os caminhos certos; quem decide rodar é você.

## Os `.md` são a fonte da verdade

Não há banco, cache nem índice: cada request relê o disco. E o board **não escreve** — nem um byte. Quem muda status é você, ou a skill que resolveu o ticket, no arquivo. O board mostra o resultado no refresh seguinte, e o `.scratch/` sobe montado read-only para que isso seja uma garantia, não uma promessa.

O que ele mecaniza é o que é determinístico: ler o estado, resumir o documento, compor o comando. O julgamento fica de fora.

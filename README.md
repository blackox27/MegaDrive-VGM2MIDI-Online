# VGM2MID Mega Drive Studio 3.2

Aplicativo HTML local para converter VGM/VGZ/GYM em MIDI, revisar PCM/DAC e ouvir a prévia com SF2. Interface em **Português (BR) e English**. Funciona sem servidor, instalação ou internet.

## Uso

1. Extraia o ZIP e abra **VGM2MID-MegaDrive-3.2.html** no navegador.
2. Escolha o idioma no cabeçalho. A preferência é lembrada se o navegador permitir armazenamento local.
3. Use **Adicionar músicas** para VGM/VGZ/VGM.GZ/GYM. Use **Carregar SF2** para `assets/soundfonts/Mega_16-Bit_FM_SF2.sf2` ou outra fonte SF2. As áreas de arrastar também são separadas.
4. Escolha instrumentos, presets, volume e transposição por pista. Ouça, pause, pare ou busque uma posição. Espaço reproduz/pausa fora dos campos.
5. Revise PCM/DAC: ouça trechos e seus monitores, baixe WAV ou ajuste a nota/percussão.
6. Baixe MIDI ou o lote ZIP com diagnósticos. MIDI não incorpora a SF2 ou os samples; carregue a mesma fonte no sintetizador externo.

O HTML contém todos os scripts, estilos, catálogos de idiomas e documentos necessários ao aplicativo. A SF2 fica separada para não inflar o HTML e permitir trocar de fonte. O navegador só acessa os arquivos que você selecionar.

## Novidades e correções

- PT-BR/EN para controles, opções GM, mensagens, atributos de acessibilidade, ajuda, análise e diagnóstico.
- Trocar o idioma preserva ajustes, fila, soundfont, controles e reprodução.
- Nomes de arquivos, metadados e nomes originais de presets preservados.
- Ativar/desativar todas as pistas; Espaço para reproduzir/pausar fora dos campos.
- Notas sobrepostas mantêm seus destaques e teclas até seu próprio término.
- Troca de página PCM encerra a audição e limpa o monitor.
- Reprodução bloqueada durante conversão/carregamento; ausência de pistas ativas recebe aviso.
- Erros de importação em lotes mistos continuam visíveis após converter os arquivos válidos.
- Limpeza de vozes se uma camada SF2 falha e respeito ao limite restante de camadas/vozes.
- Buffers do traço reutilizados; Blob do Worker reutilizado; saída PCM transferida por ArrayBuffer.
- Código formatado, separado por responsabilidade e isolado do escopo global da aplicação.

## Pastas

```text
VGM2MID-MegaDrive-3.2.html      aplicativo pronto para abrir
VGM2MID-Analise-3.2.html        relatório bilíngue e referências
src/
  core/                       parser VGM/GYM, PCM e MIDI
  audio/                      reprodução, sampler SF2 e DSP de ondas
  ui/                         renderização, piano roll, PCM e monitores
  io/                         importação e exportação
  i18n/                       pt-BR.json, en.json e tradutor local
  workers/                    protocolo de conversão
  styles/                     CSS
  app/                        estado e inicialização
  index.template.html         estrutura visual do aplicativo
scripts/                      construção e empacotamento
assets/
  soundfonts/                 SF2 original e catálogo
  demos/                      exemplos sintéticos
docs/                         ajuda e análise em PT-BR/EN
tests/                       casos automatizados
  helpers/                    simulação local da interface
  fixtures/                   entradas e arquivos de teste
  results/                    resultados por grupo
Validacao.json                resultados consolidados
SHA256SUMS.txt                 hashes dos arquivos do pacote
```

## Desenvolvimento

O uso normal não precisa de npm, Node ou Python. Para alterar o código:

- Construir o HTML: `python3 scripts/build.py` (somente Python padrão).
- Instalar dependências de teste: `npm ci` (Node.js 22 ou posterior).
- Verificar: `npm test`.
- Conferir formatação: `npm run format:check`.
- Criar pacote após os testes: `npm run package`.

Os módulos da aplicação são combinados em uma função isolada na ordem definida em `scripts/build.py`. Assim o HTML abre em `file://` sem importar módulos de uma origem local ou buscar JSON. Os motores independentes têm exportação para Node. Dependências npm são apenas de desenvolvimento.

## Validação e limites

192 verificações automatizadas passaram: 56 parser/regressão, 28 PCM, 10 chips/MIDI, 11 SF2, 12 ondas, 38 interface anterior, 24 internacionalização e 13 novas regressões. Interface executada em jsdom com Canvas/Web Audio simulados e Workers Node; não houve validação visual/sonora em navegador real nesta revisão. VGMs são sintéticos; a SF2 testada é a enviada.

O suporte a chips não foi ampliado nesta revisão. PCM misto/polifônico continua sujeito a notas/oitavas incorretas. Não há suporte SF3/Ogg ou implementação integral dos filtros, LFOs, efeitos e moduladores SF2. RF5C68/164, PWM, OPL4, QSound e outros chips/ADPCM permanecem fora da transcrição. Os monitores representam a prévia, não a saída analógica original dos chips. BPM altera a grade MIDI preservando o tempo em segundos; não muda a velocidade da prévia.

Veja a ajuda dentro do aplicativo e o relatório para cotas e referências primárias. O arquivo SF2 enviado foi preservado byte a byte.

## English

Open **VGM2MID-MegaDrive-3.2.html** locally and choose **English** in the header. Use **Add music** for VGM/VGZ/GZIP/GYM files and **Load SF2** for the supplied font in `assets/soundfonts` or another PCM16 SF2. No server, installation or internet is required for normal use. English help and review are included in the app and standalone report.

This version adds persistent, offline PT-BR/English selection, state-preserving language changes, enable/disable all tracks, a Space transport shortcut, fixes for overlapping notes, PCM navigation, mixed import warnings, preview state and SF2 failure cleanup. It reuses waveform buffers and the Worker Blob and transfers recovered PCM buffers to reduce copying.

192 automated checks passed. UI tests use jsdom with mocked Canvas/Web Audio and Node Workers; no real-browser visual/audio validation was performed. VGM fixtures are synthetic; the supplied SF2 was parsed and its PCM data checked. PCM transcription remains approximate, unsupported chip features remain outside conversion, and SF3/Ogg/advanced SF2 synthesis are not fully supported. MIDI does not embed samples. BPM changes the MIDI grid while preserving timing in seconds.

Source layout and developer commands are shown above. Build with `python3 scripts/build.py`; run `npm ci` and `npm test` for developer validation. All runtime dependencies are embedded in the HTML; the soundfont remains a separate, unchanged asset.

## Créditos / Credits

Original VGM2MID: Paul Jensen, updates by Valley Bell. This web implementation is independent. Soundfont metadata and original preset names are retained in `assets/soundfonts/Soundfont-Catalogo.json`.

"""Deterministic offline build. Standard Python library only; no bundler/runtime install needed."""
from pathlib import Path
import json, hashlib
ROOT=Path(__file__).resolve().parent.parent
S=ROOT/'src'
MODULES=['app/state.js','io/import.js','ui/render.js','ui/piano-roll.js','io/export.js','ui/pcm.js','audio/player.js','ui/scopes.js','audio/soundfont-loader.js','app/bootstrap.js']

def build():
    template=(S/'index.template.html').read_text()
    catalog={lang:json.loads((S/'i18n'/f'{lang}.json').read_text()) for lang in ['pt-BR','en']}
    assert catalog['pt-BR'].keys()==catalog['en'].keys(),'Missing translation'
    docs={token:''.join('<div data-doc-lang="'+lang+'"'+(' hidden' if lang=='en' else '')+'>'+ (ROOT/'docs'/f'{name}.{lang}.html').read_text()+'</div>' for lang in ['pt-BR','en']) for token,name in [('HELP','help'),('AUDIT','audit')]}
    sections={**docs,'CSS':(S/'styles/studio.css').read_text(),'CATALOG':'globalThis.VGMLocales='+json.dumps(catalog,ensure_ascii=False)+';','I18N':(S/'i18n/i18n.js').read_text(),'WORKER':(S/'workers/convert.js').read_text(),'CORE':(S/'core/vgm.js').read_text(),'SF2':(S/'audio/sf2.js').read_text(),'SCOPES':(S/'audio/scopes.js').read_text(),'APP':"(()=>{\n'use strict';\n"+'\n'.join('// MODULE: '+n+'\n'+(S/n).read_text() for n in MODULES)+'\n})();'}
    for token,content in sections.items():
        if token not in ['CSS','HELP','AUDIT']:content=content.replace('</script','<\\/script')
        template=template.replace('__'+token+'__',content)
    assert not any('__'+k+'__' in template for k in sections),'Unresolved template'
    output=ROOT/'VGM2MID-MegaDrive-3.2.html';output.write_text(template)
    print(json.dumps({'output':str(output),'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()}))
if __name__=='__main__':build()

"""Build a clean offline release, verify results and preserve the supplied SF2."""
from pathlib import Path
import hashlib,json,zipfile,subprocess,sys
ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT.parent/'deliverables';OUT.mkdir(exist_ok=True)
GROUPS={'parser':'results.json','pcm_dac':'pcm-results.json','chips_midi':'chips-results.json','sf2':'sf2-results.json','waveform':'scopes-results.json','ui':'ui-results.json','i18n':'i18n-results.json','review':'review-results.json'}

def package():
    groups={name:json.loads((ROOT/'tests/results'/file).read_text()) for name,file in GROUPS.items()}
    for name,group in groups.items():
        assert group['passed']==group['total'],f'Failed tests: {name}'
    total=sum(group['total'] for group in groups.values())
    validation={'version':'3.2.0','date':'2026-10-15','total':total,'passed':total,'real_browser_tested':False,'interface_environment':'jsdom with mocked Canvas and Web Audio; Node Workers','vgm_fixtures':'synthetic','soundfont_fixture':'original supplied PCM16 SF2, unchanged','groups':groups}
    (ROOT/'Validacao.json').write_text(json.dumps(validation,ensure_ascii=False,indent=2)+'\n')
    app=ROOT/'VGM2MID-MegaDrive-3.2.html'
    before=app.read_bytes()
    subprocess.run([sys.executable,str(ROOT/'scripts/build.py')],check=True)
    assert app.read_bytes()==before,'Build changed: rebuild and validate the intended source'
    report='''<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VGM2MID — Análise 3.2 / Review 3.2</title><style>body{font:16px/1.65 system-ui,sans-serif;background:#101016;color:#e8e8f1;margin:0}main{max-width:1050px;margin:auto;padding:32px}a{color:#8cb8ff}h1{font-size:34px;line-height:1.2}h2{margin-top:28px}.overline{color:#d6b66c;font-size:12px}select{font:inherit;padding:8px;background:#252530;color:white;border:1px solid #68687a;border-radius:6px}header{display:flex;align-items:center;gap:18px;flex-wrap:wrap;border-bottom:2px solid #c42e49;padding-bottom:20px;margin-bottom:28px}.validation{color:#b4d1ff}[hidden]{display:none!important}</style><main><header><label>Idioma / Language <select id="language"><option value="pt-BR">Português (BR)</option><option value="en">English</option></select></label><span class="validation">'''+str(total)+''' / '''+str(total)+''' · Validação automatizada / Automated validation</span></header>'''
    for lang in ['pt-BR','en']:
        report+='<article data-lang="'+lang+'"'+(' hidden' if lang=='en' else '')+'>'+(ROOT/'docs'/f'audit.{lang}.html').read_text()+'</article>'
    report+='''</main><script>const select=document.getElementById('language');function change(value){const lang=value==='en'?'en':'pt-BR';select.value=lang;document.documentElement.lang=lang;for(const node of document.querySelectorAll('[data-lang]'))node.hidden=node.dataset.lang!==lang;try{localStorage.setItem('vgm2mid.language',lang);}catch{}}select.onchange=()=>change(select.value);let saved;try{saved=localStorage.getItem('vgm2mid.language');}catch{}change(saved);</script></html>'''
    report_path=ROOT/'VGM2MID-Analise-3.2.html';report_path.write_text(report)
    top=[app,report_path,ROOT/'README.md',ROOT/'package.json',ROOT/'package-lock.json',ROOT/'Validacao.json']
    tree=[p for folder in ['src','docs','scripts','tests','assets'] for p in (ROOT/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts]
    files=sorted(set(top+tree))
    sums=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(ROOT).as_posix()+'\n' for p in files)
    (ROOT/'SHA256SUMS.txt').write_text(sums);files.append(ROOT/'SHA256SUMS.txt')
    sf=ROOT/'assets/soundfonts/Mega_16-Bit_FM_SF2.sf2'
    assert hashlib.sha256(sf.read_bytes()).hexdigest()=='ae5f8218f57fca2fe07e0e0e35f8c5a9cfb4e742217f53c7a2083aa48942d254','Supplied SF2 changed'
    destination=OUT/'VGM2MID-MegaDrive-Pacote-3.2.zip'
    with zipfile.ZipFile(destination,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
        for p in files:archive.write(p,p.relative_to(ROOT))
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        names=archive.namelist()
        assert not any('node_modules' in n or n.startswith(('Fontes/','Testes/')) or '3.1.html' in n for n in names)
        assert archive.read(app.name)==app.read_bytes()
    for p in [app,report_path]:(OUT/p.name).write_bytes(p.read_bytes())
    print(json.dumps({'total':total,'passed':total,'files':len(files),'package_bytes':destination.stat().st_size,'soundfont_unchanged':True}))
if __name__=='__main__':package()

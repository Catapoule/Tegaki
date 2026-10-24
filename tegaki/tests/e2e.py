#!/usr/bin/env python3
"""Test de bout en bout avec Chromium (Playwright) : dessin, reconnaissance, fiche, mnémonique, recherche, hors ligne.
usage : python3 tests/e2e.py <dense.json> <dossier de captures>
Le serveur doit déjà tourner sur http://localhost:8765 (cd tegaki && python3 -m http.server 8765)."""
import json, random, sys, os
from playwright.sync_api import sync_playwright

dense = json.load(open(sys.argv[1]))
shots = sys.argv[2]; os.makedirs(shots, exist_ok=True)
URL = 'http://localhost:8765/'
errors = []
rnd = random.Random(7)
checks = []

def ok(name, cond, extra=''):
    checks.append((name, bool(cond)))
    print(('OK   ' if cond else 'ECHEC'), name, extra)

def draw(page, strokes):
    box = page.locator('#pad').bounding_box()
    m = 0.1
    for st in strokes:
        pts = [(box['x'] + box['width'] * (m + (1 - 2 * m) * x / 109 + rnd.uniform(-.006, .006)),
                box['y'] + box['height'] * (m + (1 - 2 * m) * y / 109 + rnd.uniform(-.006, .006))) for x, y in st]
        pts = pts[::3] + [pts[-1]]
        page.mouse.move(*pts[0]); page.mouse.down()
        for p in pts[1:]: page.mouse.move(*p)
        page.mouse.up()

with sync_playwright() as p:
    b = p.chromium.launch()
    # ---------- mobile
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True, locale='fr-FR')
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL)
    page.wait_for_function("document.querySelector('#pad-status').textContent.includes('Prêt')", timeout=15000)
    ok('données chargées', True)
    page.screenshot(path=f'{shots}/01-mobile-accueil.png')

    target = '語' if '語' in dense else next(iter(dense))
    draw(page, dense[target])
    page.wait_for_selector('.cand')
    cands = page.locator('.cand-glyph').all_inner_texts()
    ok(f'reconnaissance de {target} (mobile)', cands and cands[0] == target, f'candidats: {"".join(cands[:8])}')
    page.screenshot(path=f'{shots}/02-mobile-candidats.png')

    # annuler un trait puis redessiner : le bouton Annuler retire bien le dernier trait
    page.wait_for_timeout(500)
    before = page.evaluate("document.querySelector('#pad-status').textContent")
    page.click('#btn-undo'); page.wait_for_timeout(400)
    after = page.evaluate("document.querySelector('#pad-status').textContent")
    ok('annuler le trait', before.startswith('14 traits') and after.startswith('13 traits'), f'{before} -> {after}')
    page.click('#btn-clear'); page.wait_for_timeout(300)
    ok('effacer vide les candidats', page.locator('.cand').count() == 0)
    draw(page, dense[target]); page.wait_for_selector('.cand')

    page.locator('.cand').first.click()
    page.wait_for_selector('.d-glyph')
    page.wait_for_timeout(2000)  # animation
    ok('fiche ouverte', page.locator('#detail.open').count() == 1 and page.inner_text('.d-glyph') == target)
    ok('composants affichés', page.locator('.part').count() >= 1, f'{page.locator(".part").count()} composants')
    page.screenshot(path=f'{shots}/03-mobile-fiche.png')
    page.evaluate("document.querySelector('#detail').scrollTo(0, 99999)")
    page.screenshot(path=f'{shots}/04-mobile-fiche-bas.png')

    # mnémonique : saisie, persistance après rechargement
    page.fill('#d-mnemo', 'Une bouche qui dit cinq mots : le langage.')
    page.wait_for_timeout(700)
    ok('note enregistrée', 'Enregistré' in page.inner_text('#d-note'))
    page.click('#d-fav')

    # génération Claude (réponse simulée)
    seen = {}
    def fake(route):
        seen['headers'] = route.request.headers; seen['body'] = json.loads(route.request.post_data)
        route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': '*'},
                      body=json.dumps({'content': [{'type': 'text', 'text': 'Histoire de test.\nLecture : « go ».'}]}))
    page.route('https://api.anthropic.com/**', fake)
    page.evaluate("localStorage.setItem('tegaki:settings:v1', JSON.stringify({key:'sk-ant-test', model:'claude-haiku-5-5'}))")
    page.reload(); page.wait_for_function("document.querySelector('#pad-status').textContent.includes('Prêt')")
    page.click('#tab-search'); page.fill('#q', target)
    page.locator('#search-results .row').first.click()
    page.on('dialog', lambda d: d.accept())
    page.click('#d-gen'); page.wait_for_function("document.querySelector('#d-mnemo').value.includes('Histoire de test')", timeout=5000)
    ok('génération Claude (simulée)', True)
    ok('en-têtes API', seen['headers'].get('x-api-key') == 'sk-ant-test' and seen['headers'].get('anthropic-dangerous-direct-browser-access') == 'true')
    ok('prompt contient le kanji et ses composants', target in seen['body']['messages'][0]['content'] and 'Composants' in seen['body']['messages'][0]['content'])
    page.screenshot(path=f'{shots}/05-mobile-genere.png')
    page.click('#d-close')
    page.wait_for_timeout(400)

    # recherche
    page.fill('#q', 'eau'); page.wait_for_timeout(200)
    r = page.locator('#search-results .row-glyph').all_inner_texts()
    ok('recherche "eau"', '水' in r[:5], f'{"".join(r[:8])}')
    page.fill('#q', 'みず'); page.wait_for_timeout(200)
    r = page.locator('#search-results .row-glyph').all_inner_texts()
    ok('recherche kana "みず"', '水' in r[:5], f'{"".join(r[:8])}')
    page.screenshot(path=f'{shots}/06-mobile-recherche.png')

    # mes kanjis + export Anki
    page.click('#tab-mine'); page.wait_for_selector('#mine-results .row')
    ok('liste perso', page.locator('#mine-results .row').count() == 1)
    with page.expect_download() as dl:
        page.click('#btn-anki')
    txt = open(dl.value.path(), encoding='utf-8').read()
    ok('export Anki', txt.startswith('#separator:tab') and target in txt, repr(txt[-90:]))
    page.screenshot(path=f'{shots}/07-mobile-mes-kanjis.png')

    # hors ligne
    page.wait_for_function("navigator.serviceWorker.controller !== null || true")
    page.evaluate("navigator.serviceWorker.ready")
    page.reload(); page.wait_for_function("document.querySelector('#pad-status').textContent.includes('Prêt')")
    ctx.set_offline(True)
    page.reload(); page.wait_for_function("document.querySelector('#pad-status').textContent.includes('Prêt')", timeout=10000)
    page.click('#tab-draw'); draw(page, dense[target]); page.wait_for_selector('.cand')
    ok('fonctionne hors ligne', page.locator('.cand-glyph').first.inner_text() == target)
    ctx.close()

    # ---------- bureau
    ctx = b.new_context(viewport={'width': 1280, 'height': 800}, locale='fr-FR')
    page = ctx.new_page()
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(URL); page.wait_for_function("document.querySelector('#pad-status').textContent.includes('Prêt')")
    page.screenshot(path=f'{shots}/08-bureau-accueil.png')
    others = [c for c in dense if c != target][:1] + [c for c in dense if c != target][5:6]
    for c in others:
        if page.locator('#btn-clear').is_enabled(): page.click('#btn-clear')
        page.wait_for_timeout(200); draw(page, dense[c]); page.wait_for_selector('.cand')
        top = page.locator('.cand-glyph').first.inner_text()
        ok(f'reconnaissance de {c} (bureau)', top == c, f'obtenu {top}')
    page.locator('.cand').first.click(); page.wait_for_selector('.d-glyph'); page.wait_for_timeout(2000)
    page.screenshot(path=f'{shots}/09-bureau-fiche.png')
    ctx.close(); b.close()

bad = [e for e in errors if 'Failed to load resource' not in e]
ok('aucune erreur console', not bad, str(bad[:3]))
print(f"\n{sum(1 for _, v in checks if v)}/{len(checks)} vérifications réussies")
sys.exit(0 if all(v for _, v in checks) else 1)

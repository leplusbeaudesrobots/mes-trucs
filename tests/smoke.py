"""Test de bout en bout de Mes trucs sur un téléphone simulé.
Usage : python3 tests/smoke.py          (sert les fichiers du dépôt lui-même, aucun serveur à lancer)
        python3 tests/smoke.py [url]    (teste une adresse réelle, ex. la page GitHub Pages)
Chromium déjà installé ailleurs : CHROMIUM=/chemin/vers/chrome python3 tests/smoke.py
"""
import mimetypes, os, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = sys.argv[1] if len(sys.argv) > 1 else "http://mes-trucs.test/"
LOCAL = len(sys.argv) == 1


def serve(route):
    path = route.request.url.split("mes-trucs.test/", 1)[1].split("?")[0] or "index.html"
    f = ROOT / path
    if not f.is_file():
        return route.fulfill(status=404, body="")
    route.fulfill(body=f.read_bytes(), content_type=mimetypes.guess_type(f.name)[0] or "application/octet-stream")
OLD_TASK = """()=>{const d=new Date();d.setDate(d.getDate()-5);const p=n=>String(n).padStart(2,'0');
  const t={old1:{title:'Appeler la mutuelle',due:d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()),
  time:null,done:false,created:1,moves:0}};localStorage.setItem('mes-trucs-v1',JSON.stringify(t));}"""


def titles(pg):
    return pg.eval_on_selector_all("li.task .t-title", "e=>e.map(x=>x.textContent)")


with sync_playwright() as p:
    exe = os.environ.get("CHROMIUM")
    b = p.chromium.launch(**({"executable_path": exe} if exe else {}))
    ctx = b.new_context(viewport={"width": 390, "height": 800}, device_scale_factor=2,
                        is_mobile=True, has_touch=True, locale="fr-FR", service_workers="block")
    if LOCAL:
        ctx.route("http://mes-trucs.test/**", serve)
        ctx.route("https://fonts.googleapis.com/**", lambda r: r.fulfill(body="", content_type="text/css"))
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))

    # Données de départ : une tâche en retard de 5 jours (règle des 3 jours)
    pg.goto(URL); pg.evaluate(OLD_TASK); pg.reload(); pg.wait_for_timeout(500)
    assert pg.locator("li[data-id=old1] .stuck").count() == 1, "badge Coincée absent"

    # Ajout + analyse du texte
    for t in ["Ramener carton mixeur demain", "Envoyer téléphone", "Lessive à 18h", "Payer loyer lundi"]:
        pg.fill("#newTitle", t); pg.click("#addBtn"); pg.wait_for_timeout(100)
    got = titles(pg)
    for t in ["Ramener carton mixeur", "Envoyer téléphone", "Lessive", "Payer loyer"]:
        assert t in got, f"titre mal nettoyé : {t} / {got}"

    # Parking
    pg.click(".chip[data-when=idea]"); pg.fill("#newTitle", "Refaire le site"); pg.click("#addBtn"); pg.wait_for_timeout(200)
    assert "Refaire le site" in titles(pg)

    # Carte Maintenant : Pas maintenant, C'est fait, Annuler
    first = pg.text_content(".focus .f-title"); pg.click(".f-skip")
    assert pg.text_content(".focus .f-title") != first, "Pas maintenant ne change pas de tâche"
    before = pg.text_content("#count"); pg.click(".f-done"); pg.wait_for_timeout(150)
    pg.click("#toastUndo"); pg.wait_for_timeout(150)
    assert pg.text_content("#count") == before, "Annuler ne restaure pas"

    # Découper la tâche coincée
    pg.click("li[data-id=old1] .t-body"); pg.wait_for_timeout(300)
    pg.click("#eSplitBtn"); pg.fill("#eSteps", "Trouver le numéro\nAppeler 10 min"); pg.click("#eSplitGo"); pg.wait_for_timeout(300)
    got = titles(pg)
    assert "Appeler la mutuelle" not in got and "Trouver le numéro" in got and "Appeler 10 min" in got

    # Bouton retour Android ferme la fiche sans quitter
    pg.click("li.task >> nth=0 >> .t-body"); pg.wait_for_timeout(300); pg.go_back(); pg.wait_for_timeout(300)
    assert not pg.evaluate("document.querySelector('#sheet').classList.contains('open')")

    # Écran d'ajout rapide via raccourci
    pg.goto(URL + "?add=1&when=tonight"); pg.wait_for_timeout(500)
    assert not pg.is_hidden("#quick") and "add=" not in pg.url
    pg.fill("#qTitle", "Sortir poubelles"); pg.keyboard.press("Enter"); pg.wait_for_timeout(100)
    pg.fill("#qTitle", "Appeler maman demain à 12h30"); pg.click(".q-add"); pg.wait_for_timeout(100)
    done = pg.eval_on_selector_all("#qDone li", "e=>e.map(x=>x.textContent)")
    assert any("Sortir poubelles" in d and "19h00" in d for d in done), done
    assert any("Appeler maman" in d and "Demain" in d and "12h30" in d for d in done), done

    # Persistance
    pg.click("#qClose"); pg.reload(); pg.wait_for_timeout(400)
    assert "Sortir poubelles" in titles(pg)

    # Le bouton retour d'Android ferme l'écran rapide sans quitter l'appli
    pg.click("#menuBtn"); pg.click("#quickBtn"); pg.wait_for_timeout(200)
    assert not pg.is_hidden("#quick")
    pg.go_back(); pg.wait_for_timeout(300)
    assert pg.is_hidden("#quick"), "retour ne ferme pas l'écran rapide"

    # Heures au format 18:30, minutes impossibles ignorées
    pg.fill("#newTitle", "Pharmacie 18:30"); pg.click("#addBtn"); pg.wait_for_timeout(100)
    pg.fill("#newTitle", "Code 18h75"); pg.click("#addBtn"); pg.wait_for_timeout(100)
    got = titles(pg)
    assert "Pharmacie" in got and "Code 18h75" in got, got

    # Rappel de sauvegarde après 14 jours, « Plus tard » le cache
    pg.evaluate("()=>{const m=JSON.parse(localStorage.getItem('mes-trucs-meta'));m.firstUse=Date.now()-20*864e5;m.lastBackup=null;localStorage.setItem('mes-trucs-meta',JSON.stringify(m))}")
    pg.reload(); pg.wait_for_timeout(300)
    assert pg.locator(".nudge").count() == 1, "rappel de sauvegarde absent"
    pg.click(".nudge .later"); assert pg.locator(".nudge").count() == 0

    # Données abîmées : l'appli démarre et garde une copie au lieu d'écraser
    pg.evaluate("()=>localStorage.setItem('mes-trucs-v1','{abîmé')"); pg.reload(); pg.wait_for_timeout(300)
    kept = pg.evaluate("()=>Object.keys(localStorage).filter(k=>k.startsWith('mes-trucs-v1-abime-')).length")
    assert kept == 1, "copie des données abîmées absente"

    # Tâche au format bizarre (vieille version, restauration) : pas de plantage
    pg.evaluate("()=>localStorage.setItem('mes-trucs-v1',JSON.stringify({x:{title:'Vieille tâche',due:'n/a'},y:{nope:1}}))")
    pg.reload(); pg.wait_for_timeout(300)
    assert titles(pg) == ["Vieille tâche"], titles(pg)

    # Tâche mère : reste en coulisse, on peut y ajouter une étape oubliée, elle se boucle toute seule
    pg.evaluate("()=>{localStorage.setItem('mes-trucs-v1','{}');}"); pg.reload(); pg.wait_for_timeout(300)
    pg.fill("#newTitle", "Préparer le salon"); pg.click("#addBtn"); pg.wait_for_timeout(100)
    pg.click("li.task .t-body"); pg.wait_for_timeout(300)
    pg.click("#eSplitBtn"); pg.fill("#eSteps", "Acheter du lait\nAppeler Paul"); pg.click("#eSplitGo"); pg.wait_for_timeout(300)
    got = titles(pg)
    assert "Préparer le salon" not in got and "Acheter du lait" in got, got
    pg.click("li.task:has-text('Appeler Paul') .t-body"); pg.wait_for_timeout(300)
    assert "Préparer le salon" in pg.text_content("#eParentBtn")
    pg.click("#eParentBtn"); pg.wait_for_timeout(200)
    assert "0 sur 2" in pg.text_content("#eKids")
    pg.click("#eSplitBtn"); pg.fill("#eSteps", "Imprimer les badges"); pg.click("#eSplitGo"); pg.wait_for_timeout(300)
    assert "Imprimer les badges" in titles(pg)
    for t in ["Acheter du lait", "Appeler Paul", "Imprimer les badges"]:
        pg.click(f"li.task:has-text('{t}') .check"); pg.wait_for_timeout(800)
    assert "bouclée" in pg.text_content("#toastMsg"), pg.text_content("#toastMsg")
    assert pg.evaluate("Object.values(JSON.parse(localStorage.getItem('mes-trucs-v1'))).find(t=>t.title==='Préparer le salon').done")
    pg.click("#toastUndo"); pg.wait_for_timeout(200)
    assert not pg.evaluate("Object.values(JSON.parse(localStorage.getItem('mes-trucs-v1'))).find(t=>t.title==='Préparer le salon').done")

    # Anciennes étapes orphelines : la tâche mère est recréée
    pg.evaluate("""()=>{localStorage.setItem('mes-trucs-v1',JSON.stringify({a:{title:'Étape 1',from:'Gros projet',done:true,created:5},b:{title:'Étape 2',from:'Gros projet',created:6}}));
      const m=JSON.parse(localStorage.getItem('mes-trucs-meta'));delete m.mothersV;localStorage.setItem('mes-trucs-meta',JSON.stringify(m));}""")
    pg.reload(); pg.wait_for_timeout(300)
    mum = pg.evaluate("Object.values(JSON.parse(localStorage.getItem('mes-trucs-v1'))).filter(t=>t.split).map(t=>t.title)")
    assert mum == ["Gros projet"], mum
    assert titles(pg) == ["Étape 2"], titles(pg)

    assert not errs, errs
    print("OK : tous les tests passent")
    b.close()

# Tegaki 手書き

Application web installable (PWA) pour dessiner un kanji, le reconnaître, voir son sens et ses lectures, et fixer un mnémonique. Les données et la reconnaissance sont embarquées : après la première ouverture, tout marche hors ligne (seule la génération d'histoires par Claude demande du réseau).

## Essayer en local

```bash
cd tegaki
python3 -m http.server 8765      # ou n'importe quel serveur statique
# puis ouvrir http://localhost:8765
```

Ouvrir `index.html` directement (file://) ne marche pas : le navigateur refuse de charger les données.

## L'avoir sur le téléphone, en déplacement

Une PWA doit être servie en HTTPS. Le plus simple, gratuit, sans serveur à gérer :

1. **GitHub Pages** : pousser ce dossier dans un dépôt, puis Settings → Pages → branche `main`, dossier `/ (root)`.
   Alternatives : Netlify Drop (glisser-déposer le dossier), Cloudflare Pages.
2. Ouvrir l'adresse sur le téléphone (Chrome/Android ou Safari/iOS), puis « Ajouter à l'écran d'accueil ».
3. La première ouverture télécharge environ 3,5 Mo de données ; ensuite l'appli est disponible sans connexion.

Pour publier une nouvelle version, change le numéro `CACHE` dans `sw.js` (`tegaki-v2`…) afin que les appareils rechargent les fichiers.

## Fonctions

- **Dessiner** : reconnaissance en direct après chaque trait (liste de 24 candidats). L'ordre et le sens des traits comptent ; un trait oublié, ajouté, fusionné ou coupé est toléré.
- **Fiche** : sens (français si KANJIDIC2 en fournit, sinon anglais), lectures on/kun, nombre de traits, niveau scolaire japonais, JLPT (ancienne échelle à 4 niveaux), fréquence, animation de l'ordre des traits.
- **Composants** : décomposition tirée de la structure de KanjiVG, chaque composant ouvre sa propre fiche.
- **Mnémonique** : une ligne de « recette » (`語 = 言 (dire) + 吾 (moi)`), un champ libre enregistré sur l'appareil, et un bouton « Proposer avec Claude ».
- **Chercher** : par sens (français ou anglais), par lecture en kana, ou en collant un kanji.
- **Mes kanjis** : favoris et histoires, export Anki (TSV avec en-têtes `#separator:tab`), sauvegarde et import JSON.

## Génération avec Claude

Réglages (roue dentée) : coller une clé d'API Anthropic. Le navigateur appelle directement `api.anthropic.com` ; la clé reste dans le stockage local de l'appareil et n'est jamais incluse dans les sauvegardes. Le modèle par défaut est `claude-haiku-5-5`, modifiable. C'est adapté à un usage strictement personnel ; pour partager l'appli, il faudrait une petite fonction serveur qui garde la clé.

## Reconstruire les données

```bash
git clone --depth 1 https://github.com/KanjiVG/kanjivg.git
pip download jamdict-data --no-deps && tar xzf jamdict_data-*.tar.gz   # contient jamdict.db.xz (KANJIDIC2)
xz -dk jamdict_data-*/jamdict_data/jamdict.db.xz
python3 tools/build_data.py --kanjivg kanjivg/kanji --jamdict jamdict_data-*/jamdict_data/jamdict.db --out data
python3 tools/make_icons.py kanjivg/kanji/05b57.svg icons
```

## Tests

```bash
python3 tools/build_data.py ... --dense dense.json          # échantillon de tracés denses
node tests/eval.mjs dense.json moyen 400 [aucun|ordre|manque|fusion|coupe]
python3 tests/e2e.py dense.json captures/                    # serveur sur :8765 requis, Playwright
```

`eval.mjs` bruite des tracés KanjiVG (échelle, rotation, ondulation, trait mal placé, erreurs d'ordre ou de fusion). Sur 400 kanji : bon kanji en première position dans 92 à 100 % des cas selon le scénario, dans les 5 premiers dans 99 à 100 %. Ce sont des tracés simulés, plus propres que de la vraie écriture : les chiffres sur un doigt ou un stylet seront moins bons.

## Limites connues et pistes

- Seuls 2 066 kanji sur 6 561 ont un sens français dans KANJIDIC2 ; les autres affichent l'anglais (badge « EN »). On peut générer les traductions manquantes avec Claude et les ajouter à `kanji.json`.
- Pas de mots d'exemple : JMdict est dans la base utilisée (`jamdict.db`), il reste à extraire quelques mots courants par kanji.
- Le moteur compare les traits dans l'ordre. Un écrivain qui change souvent l'ordre aura de moins bons scores ; une variante indépendante de l'ordre (sous-traits, comme HanziLookup) serait l'amélioration naturelle.
- Les numéros de traits de l'animation peuvent se chevaucher sur les kanji denses.
- Sur iOS, le stockage local d'un site non installé peut être purgé après une période d'inactivité : installer l'appli sur l'écran d'accueil et faire des sauvegardes JSON.

## Données et licences

- Tracés : [KanjiVG](https://kanjivg.tagaini.net) © Ulrich Apel, CC BY-SA 3.0.
- Sens, lectures, niveaux : [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project) © EDRDG, CC BY-SA 4.0 (via le paquet `jamdict-data`).
- `data/` est une œuvre dérivée de ces deux sources et reste donc sous CC BY-SA ; le code (`js/`, `css/`, `tools/`, `tests/`) est libre pour ton usage.

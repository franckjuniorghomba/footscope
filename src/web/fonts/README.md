# Polices hébergées

Outfit (700, 800) et Barlow (400, 500, 600, 700), sous-ensembles `latin` et `latin-ext`, au format WOFF2. Elles proviennent des paquets npm `@fontsource/outfit@5.3.0` et `@fontsource/barlow@5.3.0`.

Licence : SIL Open Font License 1.1, voir `OFL-Outfit.txt` et `OFL-Barlow.txt`.

Le Worker sert ces fichiers sous `/assets/fonts/` depuis le même domaine. La CSP (`default-src 'self'`) reste inchangée et aucune requête n'est envoyée à un service tiers.

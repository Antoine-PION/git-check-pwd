# Git Check Pwd

Application web statique qui recherche des motifs de secrets dans les lignes ajoutées aux commits GitHub, pour un dépôt ou les dépôts accessibles d’une organisation.

## Utilisation

Servez ce dossier avec un serveur web statique local ou hébergez-le sur HTTPS, puis ouvrez `index.html`. Une origine HTTP(S) est nécessaire pour que le navigateur puisse appeler l’API GitHub; l’ouverture directe en `file://` peut être bloquée par les règles CORS.

1. Choisissez un dépôt (`proprietaire/depot`) ou une organisation.
2. Saisissez un jeton GitHub à durée limitée, doté uniquement des autorisations de lecture nécessaires.
3. Lancez l’analyse et consultez les détections, erreurs d’accès et limites éventuelles.

Le jeton est conservé uniquement en mémoire pendant l’analyse, transmis directement de votre navigateur à `api.github.com`, puis effacé du formulaire. Il n’est envoyé ni au serveur qui héberge cette page ni à un autre service. Aucun backend, stockage local ou télémétrie n’est utilisé.

## Portée et limites

- L’application parcourt l’historique de chaque branche accessible (commits dédupliqués), récupère le détail des commits et inspecte les lignes ajoutées dans les patchs que l’API GitHub fournit. Les branches supprimées, commits devenus inaccessibles et tags seuls ne sont pas inclus.
- Les fichiers binaires, les fichiers sans patch et les patchs omis par GitHub ne peuvent pas être inspectés. Les fichiers sans patch, les commits atteignant la limite de 300 fichiers de l’API et les erreurs par dépôt sont signalés dans le rapport.
- Le détecteur couvre quelques formats connus (clés privées, jetons GitHub/AWS/Google/Stripe/Slack) et des affectations génériques de mots de passe et secrets. Il ne remplace pas un scanner spécialisé et peut produire des faux positifs ou manquer des formats.
- Les analyses d’organisations ou d’historiques volumineux peuvent dépasser les limites d’API GitHub. Les erreurs sont affichées; réduisez le périmètre ou réessayez après le renouvellement du quota.
- Un rapport sans détection ne prouve pas qu’aucun secret n’a été commité. En cas d’exposition confirmée, révoquez ou faites tourner le secret; supprimer un commit ne suffit pas.

Pour les dépôts privés, le jeton doit pouvoir lire leurs métadonnées et leur contenu. Pour une organisation, il doit aussi avoir le droit de lister ses dépôts. Un jeton finement ciblé et à durée limitée est préférable à un jeton classique étendu.

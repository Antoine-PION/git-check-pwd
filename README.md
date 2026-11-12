# Git Check Pwd

Application web statique qui recherche des motifs de secrets dans les lignes ajoutées aux commits GitHub et GitLab, pour un dépôt ou les dépôts accessibles d’un groupe.

## Utilisation

Servez ce dossier en HTTPS ou en HTTP sur `localhost`, puis ouvrez `index.html`. Évitez HTTP sur un réseau : un jeton saisi dans une page non chiffrée pourrait être intercepté. L’ouverture directe en `file://` peut être bloquée par les règles CORS.

1. Choisissez un dépôt ou un groupe / une organisation.
2. Collez l’URL HTTPS de la cible (les URL de clone terminant par `.git` sont acceptées). La plateforme est reconnue automatiquement : `github.com` utilise l’API GitHub; `gitlab.com` et les autres hôtes HTTPS utilisent l’API GitLab de l’instance correspondante.
3. Saisissez un jeton à durée limitée, doté uniquement des autorisations de lecture nécessaires.
4. Lancez l’analyse et consultez les détections, erreurs d’accès et limites éventuelles.

Le jeton est conservé uniquement en mémoire pendant l’analyse, transmis directement de votre navigateur à l’hôte de l’API de la plateforme détectée, puis effacé du formulaire. Il n’est envoyé ni au serveur qui héberge cette page ni à un autre service. Aucun backend, stockage local ou télémétrie n’est utilisé. N’entrez que des URL HTTPS de confiance : pour une instance GitLab auto-hébergée, le jeton est envoyé à l’hôte de cette instance, qui doit autoriser les requêtes CORS provenant de l’application.

## Portée et limites

- L’application parcourt l’historique de chaque branche accessible (commits dédupliqués), récupère les différences de commits et inspecte les lignes ajoutées dans les patchs fournis par l’API de la plateforme. Les branches supprimées, commits devenus inaccessibles et tags seuls ne sont pas inclus.
- Les fichiers binaires, les fichiers sans patch et les patchs omis par la plateforme ne peuvent pas être inspectés. Les fichiers sans patch, les commits atteignant les limites des API et les erreurs par dépôt sont signalés dans le rapport.
- Le détecteur couvre quelques formats connus (clés privées, jetons GitHub/AWS/Google/Stripe/Slack) et des affectations génériques de mots de passe et secrets. Il ne remplace pas un scanner spécialisé et peut produire des faux positifs ou manquer des formats.
- Les analyses de groupes ou d’historiques volumineux peuvent dépasser les limites des API GitHub ou GitLab. Les erreurs sont affichées; réduisez le périmètre ou réessayez après le renouvellement du quota.
- Un rapport sans détection ne prouve pas qu’aucun secret n’a été commité. En cas d’exposition confirmée, révoquez ou faites tourner le secret; supprimer un commit ne suffit pas.

Pour les dépôts GitHub privés, le jeton doit pouvoir lire leur contenu; pour une organisation, il doit aussi lister les dépôts. Pour GitLab, utilisez un jeton avec les scopes `read_api` et `read_repository`; l’utilisateur du jeton doit également avoir accès au groupe ou projet. Un jeton finement ciblé et à durée limitée est préférable à un jeton classique étendu.

# Git Check Pwd

Application web statique qui recherche des motifs de secrets dans les lignes ajoutées aux commits GitHub et GitLab, pour un dépôt ou les dépôts accessibles d’un groupe.

## Utilisation

Servez ce dossier en HTTPS ou en HTTP sur `localhost`, puis ouvrez `index.html`. Évitez HTTP sur un réseau : un jeton saisi dans une page non chiffrée pourrait être intercepté. L’ouverture directe en `file://` peut être bloquée par les règles CORS.

1. Choisissez un dépôt ou un groupe / une organisation.
2. Collez l’URL HTTPS de la cible (les URL de clone terminant par `.git` sont acceptées). La plateforme est reconnue automatiquement : `github.com` utilise l’API GitHub; `gitlab.com` et les autres hôtes HTTPS utilisent l’API GitLab de l’instance correspondante.
3. Saisissez un jeton à durée limitée, doté uniquement des autorisations de lecture nécessaires.
4. Lancez l’analyse et consultez les détections, erreurs d’accès et limites éventuelles.

Le jeton est conservé uniquement en mémoire pendant l’analyse, transmis directement de votre navigateur à l’hôte de l’API de la plateforme détectée, puis effacé du formulaire. Il n’est envoyé ni au serveur qui héberge cette page ni à un autre service. N’entrez que des URL HTTPS de confiance : pour une instance GitLab auto-hébergée, le jeton est envoyé à l’hôte de cette instance, qui doit autoriser les requêtes CORS provenant de l’application.

Après une analyse réussie, un rapport expurgé est automatiquement enregistré dans IndexedDB du navigateur. La liste des rapports enregistrés permet de les rouvrir ou de les supprimer. Les valeurs brutes des secrets, les fichiers sources et les jetons ne sont pas inclus dans les rapports stockés. Ces données restent propres à ce navigateur et à ce profil; elles ne sont ni synchronisées ni sauvegardées par l’application.

Pour mémoriser un jeton, cochez l’option correspondante et fournissez deux fois une phrase de passe d’au moins 12 caractères. Le jeton est chiffré localement avec AES-GCM et une clé dérivée par PBKDF2; la phrase de passe n’est pas enregistrée. Un jeton enregistré peut être déverrouillé pour le dépôt ou l’instance correspondant à l’URL. En enregistrant à nouveau un jeton pour la même instance, le jeton chiffré existant est remplacé. Le chiffrement nécessite un navigateur compatible Web Crypto et une origine HTTPS ou `localhost`. En cas de perte de la phrase de passe, le jeton enregistré est irrécupérable; il faut le supprimer et en fournir un nouveau.

## Portée et limites

- L’application parcourt l’historique de chaque branche accessible (commits dédupliqués), récupère les différences de commits et inspecte les lignes ajoutées dans les patchs fournis par l’API de la plateforme. Les branches supprimées, commits devenus inaccessibles et tags seuls ne sont pas inclus.
- Le rapport regroupe les détections par projet, fichier et valeur détectée; les extraits affichés masquent les valeurs sensibles. Il liste les commits concernés et compare chaque secret aux versions actuelles des fichiers sur les branches accessibles. Les rapports conservés localement contiennent uniquement ces données expurgées.
- Une branche sans commit depuis 180 jours est marquée inactive. La branche par défaut n’est jamais recommandée à la suppression; toute recommandation est consultative. Supprimer une branche ne révoque pas un secret et ne purge pas les commits toujours accessibles depuis d’autres références.
- La vérification de présence actuelle n’est possible que pour les fichiers et branches accessibles dont le contenu peut être récupéré. Les erreurs, réponses 404 (fichier absent ou accès refusé) et fichiers trop volumineux sont signalés et ne doivent pas être interprétés comme une absence certaine.
- Les fichiers binaires, les fichiers sans patch et les patchs omis par la plateforme ne peuvent pas être inspectés. Les fichiers sans patch, les commits atteignant les limites des API et les erreurs par dépôt sont signalés dans le rapport.
- Le détecteur couvre des formats reconnus de jetons (notamment GitHub, GitLab, AWS, Anthropic, Google, Stripe et Slack), les mots de passe dans certaines chaînes de connexion, ainsi que des affectations courantes (`password`, `client_secret`, `api_key`, etc.). Pour limiter les faux positifs, les affectations génériques exigent une valeur littérale et ignorent notamment les appels de méthode tels que `password = saConfig.getPassword()`. Les identifiants en clair dans le code restent détectés. Ces règles statiques ne remplacent pas un scanner spécialisé et peuvent encore produire des faux positifs ou manquer certains formats.
- Les formats évoluent selon les fournisseurs. Les règles s’appuient sur les formats documentés par [GitHub](https://docs.github.com/en/code-security/reference/secret-security/supported-secret-scanning-patterns), les recommandations de [GitLab](https://docs.gitlab.com/user/application_security/secret_detection/) et des exemples de règles maintenues dans [Gitleaks](https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml). Les secrets codés en dur correspondent notamment aux faiblesses décrites par [CWE-798](https://cwe.mitre.org/data/definitions/798.html).
- Les analyses de groupes ou d’historiques volumineux peuvent dépasser les limites des API GitHub ou GitLab. Les erreurs sont affichées; réduisez le périmètre ou réessayez après le renouvellement du quota.
- Un rapport sans détection ne prouve pas qu’aucun secret n’a été commité. En cas d’exposition confirmée, révoquez ou faites tourner le secret; supprimer un commit ne suffit pas.

Pour les dépôts GitHub privés, le jeton doit pouvoir lire leur contenu; pour une organisation, il doit aussi lister les dépôts. Pour GitLab, utilisez un jeton avec les scopes `read_api` et `read_repository`; l’utilisateur du jeton doit également avoir accès au groupe ou projet. Un jeton finement ciblé et à durée limitée est préférable à un jeton classique étendu.

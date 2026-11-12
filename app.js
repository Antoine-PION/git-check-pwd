(function () {
  "use strict";

  const form = document.getElementById("scan-form");
  const modeInput = document.getElementById("target-mode");
  const targetInput = document.getElementById("target");
  const targetLabel = document.getElementById("target-label");
  const targetHelp = document.getElementById("target-help");
  const tokenLabel = document.getElementById("token-label");
  const tokenInput = document.getElementById("token");
  const scanButton = document.getElementById("scan-button");
  const cancelButton = document.getElementById("cancel-button");
  const activity = document.getElementById("activity");
  const activityMessage = document.getElementById("activity-message");
  const progress = document.getElementById("progress");
  const errorMessage = document.getElementById("error-message");
  const results = document.getElementById("results");
  const summary = document.getElementById("summary");
  const issuesPanel = document.getElementById("scan-issues");
  const findingsPanel = document.getElementById("findings");
  let activeController = null;

  function setBusy(busy) {
    scanButton.disabled = busy;
    cancelButton.disabled = !busy;
    modeInput.disabled = busy;
    targetInput.disabled = busy;
    tokenInput.disabled = busy;
  }

  function setActivity(message, completed, total) {
    activity.hidden = false;
    activityMessage.textContent = message;
    progress.max = Math.max(total, 1);
    progress.value = completed;
  }

  function parseTarget(mode, value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Saisissez l’URL HTTPS complète d’un dépôt ou d’un groupe GitHub/GitLab.");
    }

    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new Error("Utilisez une URL HTTPS sans identifiants, paramètres ni fragment.");
    }

    const hostname = url.hostname.toLowerCase();
    const platform = hostname === "github.com" || hostname === "www.github.com"
      ? "github"
      : "gitlab";
    const rawPath = url.pathname.split("/").filter(Boolean);
    const actionIndex = rawPath.indexOf("-");
    const path = (actionIndex < 0 ? rawPath : rawPath.slice(0, actionIndex)).map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new Error("L’URL contient un chemin invalide.");
      }
    });

    if (platform === "gitlab" && mode === "group" && path[0] === "groups") {
      path.shift();
    }

    if (platform === "github" && mode === "repository" && path.length > 2) {
      path.length = 2;
    }
    if (platform === "github" && mode === "group" && path.length > 1) {
      path.length = 1;
    }
    if (mode === "repository" && path.length > 1 &&
        path[path.length - 1].toLowerCase().endsWith(".git")) {
      path[path.length - 1] = path[path.length - 1].slice(0, -4);
    }

    const requiredParts = mode === "repository" ? 2 : 1;
    if (path.length < requiredParts) {
      throw new Error(mode === "repository"
        ? "L’URL du dépôt doit contenir son propriétaire/groupe et son nom."
        : "L’URL du groupe ou de l’organisation est incomplète.");
    }
    if (path.some((part) => !part || part === "." || part === "..")) {
      throw new Error("Le chemin de l’URL est invalide.");
    }

    const apiBase = platform === "github"
      ? "https://api.github.com"
      : url.origin + "/api/v4";
    return {
      platform,
      apiBase,
      mode,
      path,
      fullPath: path.join("/"),
      origin: url.origin
    };
  }

  function apiUrl(target, path) {
    return target.apiBase + path;
  }

  function appendQuery(path, values) {
    const params = new URLSearchParams(values);
    return path + (path.includes("?") ? "&" : "?") + params.toString();
  }

  async function apiGet(target, path, token, signal) {
    const headers = target.platform === "github"
      ? {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "X-GitHub-Api-Version": "2022-11-28"
        }
      : { "PRIVATE-TOKEN": token };
    const response = await fetch(apiUrl(target, path), { headers, signal });

    if (!response.ok) {
      let message = "Erreur HTTP " + response.status;
      try {
        const body = await response.json();
        const serverMessage = body.message || body.error;
        if (typeof serverMessage === "string" && serverMessage.length > 0) {
          message = serverMessage.split(token).join("[masqué]");
        }
      } catch {
        message = "Erreur HTTP " + response.status + " renvoyée par l’API.";
      }

      if (response.status === 401) {
        throw new Error("Jeton refusé par " + target.platform + ". Vérifiez sa validité et ses droits.");
      }
      if (response.status === 403 && target.platform === "github" &&
          response.headers.get("X-RateLimit-Remaining") === "0") {
        throw new Error("Limite de requêtes GitHub atteinte. Réessayez après le renouvellement du quota.");
      }
      if (response.status === 429) {
        throw new Error("Limite de requêtes " + target.platform + " atteinte. Réessayez plus tard.");
      }
      if (response.status === 403) {
        throw new Error("Accès refusé par " + target.platform + " : " + message);
      }
      if (response.status === 404) {
        throw new Error("Ressource introuvable ou inaccessible avec ce jeton.");
      }
      throw new Error("L’API " + target.platform + " a refusé la requête : " + message);
    }

    return { data: await response.json(), headers: response.headers };
  }

  async function getAllPages(target, path, token, signal) {
    const items = [];
    let page = 1;
    let pageItems;

    do {
      const currentPage = page;
      const pagePath = appendQuery(path, { per_page: "100", page: String(currentPage) });
      const result = await apiGet(target, pagePath, token, signal);
      pageItems = result.data;
      if (!Array.isArray(pageItems)) {
        throw new Error("Réponse inattendue de l’API " + target.platform + ".");
      }
      items.push(...pageItems);

      if (target.platform === "gitlab") {
        const nextPage = result.headers.get("X-Next-Page");
        if (!nextPage) {
          break;
        }
        page = Number(nextPage);
        if (!Number.isInteger(page) || page <= currentPage) {
          throw new Error("Pagination GitLab invalide.");
        }
      } else {
        page += 1;
      }
    } while (target.platform === "gitlab" ? true : pageItems.length === 100);

    return items;
  }

  async function getRepositories(target, token, signal) {
    if (target.mode === "repository") {
      if (target.platform === "github") {
        return [{
          provider: target,
          owner: target.path[0],
          name: target.path[1],
          fullName: target.fullPath
        }];
      }

      const result = await apiGet(
        target,
        "/projects/" + encodeURIComponent(target.fullPath),
        token,
        signal
      );
      if (!result.data || !Number.isInteger(result.data.id) ||
          typeof result.data.path_with_namespace !== "string") {
        throw new Error("Réponse inattendue pour le projet GitLab.");
      }
      return [{
        provider: target,
        id: result.data.id,
        fullName: result.data.path_with_namespace
      }];
    }

    if (target.platform === "github") {
      const repos = await getAllPages(
        target,
        "/orgs/" + encodeURIComponent(target.path[0]) + "/repos?type=all",
        token,
        signal
      );
      return repos
        .filter((repo) => repo && typeof repo.full_name === "string" && repo.owner && repo.name)
        .map((repo) => ({
          provider: target,
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name
        }))
        .sort((left, right) => left.fullName.localeCompare(right.fullName));
    }

    const group = await apiGet(
      target,
      "/groups/" + encodeURIComponent(target.fullPath),
      token,
      signal
    );
    if (!group.data || !Number.isInteger(group.data.id)) {
      throw new Error("Réponse inattendue pour le groupe GitLab.");
    }
    const projects = await getAllPages(
      target,
      "/groups/" + group.data.id + "/projects?include_subgroups=true&with_shared=false",
      token,
      signal
    );
    return projects
      .filter((project) => project && Number.isInteger(project.id) &&
        typeof project.path_with_namespace === "string")
      .map((project) => ({
        provider: target,
        id: project.id,
        fullName: project.path_with_namespace
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async function scanGitHubRepository(repo, token, signal, onProgress) {
    const target = repo.provider;
    const prefix = "/repos/" + encodeURIComponent(repo.owner) + "/" +
      encodeURIComponent(repo.name);
    const branches = await getAllPages(target, prefix + "/branches", token, signal);
    const commitsBySha = new Map();
    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      if (!branch || typeof branch.name !== "string" || !branch.commit ||
          typeof branch.commit.sha !== "string") {
        throw new Error("Liste de branches inattendue pour " + repo.fullName + ".");
      }

      onProgress(repo.fullName, index + 1, branches.length, "branch");
      const branchCommits = await getAllPages(
        target,
        prefix + "/commits?sha=" + encodeURIComponent(branch.commit.sha),
        token,
        signal
      );
      for (const commit of branchCommits) {
        commitsBySha.set(commit.sha, commit);
      }
    }

    const commits = Array.from(commitsBySha.values());
    const findings = [];
    let filesScanned = 0;
    let unavailablePatches = 0;
    let limitedCommits = 0;

    for (let index = 0; index < commits.length; index += 1) {
      if (signal.aborted) {
        throw new DOMException("Analyse annulée.", "AbortError");
      }

      const commit = commits[index];
      onProgress(repo.fullName, index + 1, commits.length, "commit");
      const detail = (await apiGet(
        target,
        prefix + "/commits/" + encodeURIComponent(commit.sha),
        token,
        signal
      )).data;

      if (!detail || !Array.isArray(detail.files)) {
        throw new Error("Détail inattendu pour le commit " + commit.sha + ".");
      }
      if (detail.files.length >= 300) {
        limitedCommits += 1;
      }

      for (const file of detail.files) {
        if (typeof file.patch !== "string") {
          unavailablePatches += 1;
          continue;
        }

        filesScanned += 1;
        for (const finding of window.SecretScanner.scanPatch(file.patch)) {
          findings.push({
            ...finding,
            repository: repo.fullName,
            commit: commit.sha,
            path: file.filename,
            provider: target.platform,
            origin: target.origin
          });
        }
      }
    }

    return {
      repository: repo.fullName,
      commitCount: commits.length,
      filesScanned,
      unavailablePatches,
      limitedCommits,
      findings
    };
  }

  async function scanGitLabRepository(repo, token, signal, onProgress) {
    const target = repo.provider;
    const prefix = "/projects/" + repo.id + "/repository";
    const branches = await getAllPages(target, prefix + "/branches", token, signal);
    const commitsBySha = new Map();

    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      if (!branch || typeof branch.name !== "string") {
        throw new Error("Liste de branches inattendue pour " + repo.fullName + ".");
      }

      onProgress(repo.fullName, index + 1, branches.length, "branch");
      const commits = await getAllPages(
        target,
        appendQuery(prefix + "/commits", { ref_name: branch.name }),
        token,
        signal
      );
      for (const commit of commits) {
        if (commit && typeof commit.id === "string") {
          commitsBySha.set(commit.id, commit);
        }
      }
    }

    const commits = Array.from(commitsBySha.values());
    const findings = [];
    let filesScanned = 0;
    let unavailablePatches = 0;

    for (let index = 0; index < commits.length; index += 1) {
      if (signal.aborted) {
        throw new DOMException("Analyse annulée.", "AbortError");
      }

      const commit = commits[index];
      onProgress(repo.fullName, index + 1, commits.length, "commit");
      const diffs = await getAllPages(
        target,
        prefix + "/commits/" + encodeURIComponent(commit.id) + "/diff",
        token,
        signal
      );

      for (const diff of diffs) {
        if (!diff || typeof diff.diff !== "string" || diff.diff.length === 0) {
          unavailablePatches += 1;
          continue;
        }

        filesScanned += 1;
        for (const finding of window.SecretScanner.scanPatch(diff.diff)) {
          findings.push({
            ...finding,
            repository: repo.fullName,
            commit: commit.id,
            path: diff.new_path || diff.old_path || "Fichier inconnu",
            provider: target.platform,
            origin: target.origin
          });
        }
      }
    }

    return {
      repository: repo.fullName,
      commitCount: commits.length,
      filesScanned,
      unavailablePatches,
      limitedCommits: 0,
      findings
    };
  }

  async function scanRepository(repo, token, signal, onProgress) {
    return repo.provider.platform === "github"
      ? scanGitHubRepository(repo, token, signal, onProgress)
      : scanGitLabRepository(repo, token, signal, onProgress);
  }

  function appendText(parent, tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) {
      element.className = className;
    }
    parent.append(element);
    return element;
  }

  function renderFinding(finding) {
    const article = document.createElement("article");
    article.className = "finding";

    const top = document.createElement("div");
    top.className = "finding-top";
    article.append(top);

    const title = document.createElement("h3");
    title.textContent = finding.rule + " — " + finding.repository;
    top.append(title);
    appendText(top, "span", finding.severity, "badge");

    appendText(article, "p", finding.path + ":" + finding.line);
    const link = document.createElement("a");
    link.href = finding.provider === "github"
      ? "https://github.com/" + finding.repository.split("/").map(encodeURIComponent).join("/") +
        "/commit/" + encodeURIComponent(finding.commit)
      : finding.origin + "/" + finding.repository.split("/").map(encodeURIComponent).join("/") +
        "/-/commit/" + encodeURIComponent(finding.commit);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Voir le commit " + finding.commit.slice(0, 7);
    appendText(article, "p", "");
    article.lastElementChild.append(link);
    appendText(article, "code", finding.redactedLine);
    return article;
  }

  function renderReport(repoResults, scanIssues) {
    const allFindings = repoResults.flatMap((result) => result.findings);
    const totalCommits = repoResults.reduce((total, result) => total + result.commitCount, 0);
    const totalFiles = repoResults.reduce((total, result) => total + result.filesScanned, 0);
    results.hidden = false;
    summary.textContent = allFindings.length + " détection(s) · " +
      totalCommits + " commit(s) · " + totalFiles + " fichier(s) inspecté(s) · " +
      repoResults.length + " dépôt(s)";
    findingsPanel.replaceChildren();

    if (scanIssues.length > 0) {
      issuesPanel.hidden = false;
      issuesPanel.replaceChildren();
      const heading = appendText(issuesPanel, "strong", "Analyse incomplète ou limites rencontrées");
      heading.setAttribute("aria-label", "Analyse incomplète ou limites rencontrées");
      const list = document.createElement("ul");
      for (const issue of scanIssues) {
        appendText(list, "li", issue);
      }
      issuesPanel.append(list);
    } else {
      issuesPanel.hidden = true;
      issuesPanel.replaceChildren();
    }

    if (allFindings.length === 0) {
      appendText(
        findingsPanel,
        "p",
        "Aucun motif connu détecté dans les patchs analysés. Cela ne garantit pas l’absence de secrets.",
        "empty-state"
      );
      return;
    }

    allFindings.sort((left, right) =>
      left.repository.localeCompare(right.repository) ||
      left.path.localeCompare(right.path) ||
      left.line - right.line
    );
    for (const finding of allFindings) {
      findingsPanel.append(renderFinding(finding));
    }
  }

  async function startScan(event) {
    event.preventDefault();
    errorMessage.hidden = true;
    errorMessage.textContent = "";
    results.hidden = true;
    activity.hidden = false;
    progress.value = 0;
    setBusy(true);
    activeController = new AbortController();

    const token = tokenInput.value.trim();
    const mode = modeInput.value;

    try {
      if (!token) {
        throw new Error("Saisissez un jeton d’accès personnel.");
      }

      const target = parseTarget(mode, targetInput.value.trim());
      setActivity("Récupération des dépôts et de l’historique auprès de " + target.platform + "…", 0, 1);
      const repositories = await getRepositories(target, token, activeController.signal);
      if (repositories.length === 0) {
        throw new Error("Aucun dépôt accessible trouvé pour ce périmètre.");
      }

      const repoResults = [];
      const scanIssues = [];
      let completedRepositories = 0;

      for (const repo of repositories) {
        try {
          const result = await scanRepository(
            repo,
            token,
            activeController.signal,
            (name, current, total, stage) => {
              const label = stage === "branch" ? "branche" : "commit";
              const suffix = total > 0 ? " — " + label + " " + current + "/" + total : "";
              setActivity(
                "Analyse de " + name + suffix +
                  " (" + (completedRepositories + 1) + "/" + repositories.length + " dépôts)",
                completedRepositories,
                repositories.length
              );
            }
          );
          repoResults.push(result);
          if (result.unavailablePatches > 0) {
            scanIssues.push(
              result.repository + " : " + result.unavailablePatches +
              " fichier(s) sans patch exploitable fournis par " + repo.provider.platform + "."
            );
          }
          if (result.limitedCommits > 0) {
            scanIssues.push(
              result.repository + " : " + result.limitedCommits +
                " commit(s) ont atteint la limite de 300 fichiers renvoyés par l’API GitHub."
            );
          }
        } catch (error) {
          if (error.name === "AbortError") {
            throw error;
          }
          scanIssues.push(repo.fullName + " : " + error.message);
        }
        completedRepositories += 1;
        setActivity(
          "Dépôts traités : " + completedRepositories + "/" + repositories.length,
          completedRepositories,
          repositories.length
        );
      }

      if (repoResults.length === 0) {
        throw new Error("Aucun dépôt n’a pu être analysé. " + scanIssues.join(" "));
      }
      renderReport(repoResults, scanIssues);
      activityMessage.textContent = "Analyse terminée.";
      progress.value = progress.max;
    } catch (error) {
      if (error.name === "AbortError") {
        activityMessage.textContent = "Analyse annulée.";
      } else {
        errorMessage.textContent = error.message || "Une erreur inattendue a interrompu l’analyse.";
        errorMessage.hidden = false;
        activity.hidden = true;
      }
    } finally {
      tokenInput.value = "";
      activeController = null;
      setBusy(false);
    }
  }

  function updateTargetHelp() {
    let platform = "";
    try {
      const url = new URL(targetInput.value.trim());
      if (url.protocol === "https:") {
        const hostname = url.hostname.toLowerCase();
        platform = hostname === "github.com" || hostname === "www.github.com"
          ? "GitHub"
          : "GitLab";
      }
    } catch {
      platform = "";
    }
    if (modeInput.value === "group") {
      targetLabel.textContent = "URL du groupe / de l’organisation";
      targetInput.placeholder = platform === "GitHub"
        ? "https://github.com/organisation"
        : "https://gitlab.com/groupe/sous-groupe";
      targetHelp.textContent = platform === "GitHub"
        ? "Les dépôts accessibles de l’organisation GitHub seront analysés."
        : platform === "GitLab"
          ? "Les projets accessibles du groupe GitLab et de ses sous-groupes seront analysés."
          : "Collez l’URL HTTPS du groupe GitLab ou de l’organisation GitHub.";
    } else {
      targetLabel.textContent = "URL du dépôt";
      targetInput.placeholder = platform === "GitLab"
        ? "https://gitlab.com/groupe/sous-groupe/depot"
        : "https://github.com/proprietaire/depot";
      targetHelp.textContent = "Collez l’URL HTTPS complète du dépôt (GitLab accepte les groupes imbriqués).";
    }

    if (platform) {
      tokenLabel.textContent = "Jeton d’accès personnel " + platform;
    } else {
      tokenLabel.textContent = "Jeton d’accès personnel GitHub ou GitLab";
    }
  }

  modeInput.addEventListener("change", updateTargetHelp);
  targetInput.addEventListener("input", updateTargetHelp);

  form.addEventListener("submit", startScan);
  cancelButton.addEventListener("click", () => {
    if (activeController) {
      activeController.abort();
    }
  });
})();

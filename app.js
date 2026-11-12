(function () {
  "use strict";

  const apiBase = "https://api.github.com";
  const form = document.getElementById("scan-form");
  const modeInput = document.getElementById("target-mode");
  const targetInput = document.getElementById("target");
  const targetLabel = document.getElementById("target-label");
  const targetHelp = document.getElementById("target-help");
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

  function githubPathSegment(value) {
    return encodeURIComponent(value);
  }

  async function githubGet(path, token, signal) {
    const response = await fetch(apiBase + path, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal
    });

    if (!response.ok) {
      let message = "Erreur HTTP " + response.status;
      try {
        const body = await response.json();
        if (typeof body.message === "string" && body.message.length > 0) {
          message = body.message.split(token).join("[masqué]");
        }
      } catch {
        message = "Erreur HTTP " + response.status + " renvoyée par GitHub.";
      }

      if (response.status === 401) {
        throw new Error("Jeton refusé par GitHub. Vérifiez sa validité et ses droits.");
      }
      if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") {
        throw new Error("Limite de requêtes GitHub atteinte. Réessayez après le renouvellement indiqué par GitHub.");
      }
      if (response.status === 403) {
        throw new Error("Accès refusé par GitHub : " + message);
      }
      if (response.status === 404) {
        throw new Error("Ressource introuvable ou inaccessible avec ce jeton.");
      }
      throw new Error("GitHub a refusé la requête : " + message);
    }

    return response.json();
  }

  async function getAllPages(path, token, signal) {
    const items = [];
    let page = 1;
    let pageItems;

    do {
      pageItems = await githubGet(path + (path.includes("?") ? "&" : "?") +
        "per_page=100&page=" + page, token, signal);
      if (!Array.isArray(pageItems)) {
        throw new Error("Réponse inattendue de l’API GitHub.");
      }
      items.push(...pageItems);
      page += 1;
    } while (pageItems.length === 100);

    return items;
  }

  function validateTarget(mode, target) {
    if (mode === "repository") {
      const parts = target.split("/");
      const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
      const repositoryPattern = /^[A-Za-z0-9._-]+$/;
      if (parts.length !== 2 || !ownerPattern.test(parts[0]) || !repositoryPattern.test(parts[1])) {
        throw new Error("Saisissez un dépôt au format propriétaire/nom-du-dépôt.");
      }
      return { owner: parts[0], name: parts[1], fullName: parts[0] + "/" + parts[1] };
    }

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(target)) {
      throw new Error("Saisissez le nom de l’organisation GitHub.");
    }
    return { organization: target };
  }

  async function getRepositories(target, mode, token, signal) {
    if (mode === "repository") {
      return [{
        owner: target.owner,
        name: target.name,
        fullName: target.fullName
      }];
    }

    const repos = await getAllPages(
      "/orgs/" + githubPathSegment(target.organization) + "/repos?type=all",
      token,
      signal
    );
    return repos
      .filter((repo) => repo && typeof repo.full_name === "string" && repo.owner && repo.name)
      .map((repo) => ({
        owner: repo.owner.login,
        name: repo.name,
        fullName: repo.full_name
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  async function scanRepository(repo, token, signal, onProgress) {
    const prefix = "/repos/" + githubPathSegment(repo.owner) + "/" +
      githubPathSegment(repo.name);
    const branches = await getAllPages(prefix + "/branches", token, signal);
    const commitsBySha = new Map();
    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      if (!branch || typeof branch.name !== "string" || !branch.commit ||
          typeof branch.commit.sha !== "string") {
        throw new Error("Liste de branches inattendue pour " + repo.fullName + ".");
      }

      onProgress(repo.fullName, index + 1, branches.length, "branch");
      const branchCommits = await getAllPages(
        prefix + "/commits?sha=" + githubPathSegment(branch.commit.sha),
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
      const detail = await githubGet(
        prefix + "/commits/" + githubPathSegment(commit.sha),
        token,
        signal
      );

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
            path: file.filename
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
    link.href = "https://github.com/" +
      finding.repository.split("/").map(encodeURIComponent).join("/") +
      "/commit/" + encodeURIComponent(finding.commit);
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
        throw new Error("Saisissez un jeton GitHub.");
      }

      const target = validateTarget(mode, targetInput.value.trim());
      setActivity("Récupération des dépôts et de l’historique auprès de GitHub…", 0, 1);
      const repositories = await getRepositories(target, mode, token, activeController.signal);
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
                " fichier(s) sans patch exploitable fournis par GitHub."
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

  modeInput.addEventListener("change", () => {
    if (modeInput.value === "organization") {
      targetLabel.textContent = "Organisation GitHub";
      targetInput.placeholder = "nom-de-l-organisation";
      targetHelp.textContent = "Les dépôts accessibles au jeton seront analysés, y compris les dépôts archivés.";
    } else {
      targetLabel.textContent = "Dépôt GitHub";
      targetInput.placeholder = "proprietaire/depot";
      targetHelp.textContent = "Format attendu : propriétaire/nom-du-dépôt.";
    }
  });

  form.addEventListener("submit", startScan);
  cancelButton.addEventListener("click", () => {
    if (activeController) {
      activeController.abort();
    }
  });
})();

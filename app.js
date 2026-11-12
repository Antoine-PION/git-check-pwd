(function () {
  "use strict";

  const staleBranchAfterDays = 180;
  const maxFallbackSourceBytes = 1024 * 1024;
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
  const rememberTokenInput = document.getElementById("remember-token");
  const vaultPassphraseFields = document.getElementById("vault-passphrase-fields");
  const vaultConfirmFields = document.getElementById("vault-confirm-fields");
  const vaultPassphraseInput = document.getElementById("vault-passphrase");
  const vaultPassphraseConfirmInput = document.getElementById("vault-passphrase-confirm");
  const vaultStatus = document.getElementById("vault-status");
  const vaultActions = document.getElementById("vault-actions");
  const unlockTokenButton = document.getElementById("unlock-token-button");
  const deleteTokenButton = document.getElementById("delete-token-button");
  const storageStatus = document.getElementById("storage-status");
  const savedReportsList = document.getElementById("saved-reports-list");
  let activeController = null;
  let databasePromise;
  let targetRefreshId = 0;

  function setBusy(busy) {
    scanButton.disabled = busy;
    cancelButton.disabled = !busy;
    modeInput.disabled = busy;
    targetInput.disabled = busy;
    tokenInput.disabled = busy;
    rememberTokenInput.disabled = busy;
    vaultPassphraseInput.disabled = busy;
    vaultPassphraseConfirmInput.disabled = busy;
    unlockTokenButton.disabled = busy;
    deleteTokenButton.disabled = busy;
  }

  function setActivity(message, completed, total) {
    activity.hidden = false;
    activityMessage.textContent = message;
    progress.max = Math.max(total, 1);
    progress.value = completed;
  }

  function openDatabase() {
    if (!window.indexedDB) {
      return Promise.reject(new Error("Le stockage local du navigateur n’est pas disponible."));
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("git-check-pwd", 1);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("reports")) {
            database.createObjectStore("reports", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("tokens")) {
            database.createObjectStore("tokens", { keyPath: "id" });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error("Impossible d’ouvrir le stockage local du navigateur."));
        request.onblocked = () => reject(new Error("Le stockage local est bloqué par une autre version de l’application."));
      });
    }
    return databasePromise;
  }

  async function storeRequest(storeName, mode, action) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      let result;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(new Error("Échec d’accès au stockage local."));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new Error("Échec d’écriture dans le stockage local."));
      transaction.onabort = () => reject(new Error("L’opération de stockage local a été annulée."));
    });
  }

  function getAllStored(storeName) {
    return storeRequest(storeName, "readonly", (store) => store.getAll());
  }

  function getStored(storeName, id) {
    return storeRequest(storeName, "readonly", (store) => store.get(id));
  }

  function putStored(storeName, value) {
    return storeRequest(storeName, "readwrite", (store) => store.put(value));
  }

  function deleteStored(storeName, id) {
    return storeRequest(storeName, "readwrite", (store) => store.delete(id));
  }

  function randomId() {
    if (typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function encodeBase64(bytes) {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

  function decodeBase64(value) {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  }

  async function deriveVaultKey(passphrase, salt) {
    if (!crypto.subtle) {
      throw new Error("Le chiffrement local nécessite HTTPS ou localhost et un navigateur compatible Web Crypto.");
    }
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function tokenRecordId(target) {
    return target.platform + "|" + target.origin;
  }

  async function encryptToken(target, token, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveVaultKey(passphrase, salt);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(token)
    );
    return {
      id: tokenRecordId(target),
      platform: target.platform,
      origin: target.origin,
      salt: encodeBase64(salt),
      iv: encodeBase64(iv),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
      updatedAt: new Date().toISOString()
    };
  }

  async function decryptToken(record, passphrase) {
    const key = await deriveVaultKey(passphrase, decodeBase64(record.salt));
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: decodeBase64(record.iv) },
        key,
        decodeBase64(record.ciphertext)
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new Error("Phrase de passe incorrecte ou jeton chiffré illisible.");
    }
  }

  function reportId() {
    return randomId();
  }

  function createSafeReport(repoResults, scanIssues, targetLabel) {
    const now = new Date();
    const projects = repoResults.map((result) => {
      const secretIds = new Map();
      const findings = result.findings.map((finding) => {
        const key = JSON.stringify([finding.path, finding.rule, finding.secretValue]);
        if (!secretIds.has(key)) {
          secretIds.set(key, randomId());
        }
        return {
          secretId: secretIds.get(key),
          repository: finding.repository,
          path: finding.path,
          rule: finding.rule,
          severity: finding.severity,
          line: finding.line,
          redactedLine: finding.redactedLine,
          commit: finding.commit,
          provider: finding.provider,
          origin: finding.origin,
          currentBranches: finding.currentBranches.slice(),
          branchCheckIncomplete: finding.branchCheckIncomplete
        };
      });
      return {
        repository: result.repository,
        commitCount: result.commitCount,
        filesScanned: result.filesScanned,
        unavailablePatches: result.unavailablePatches,
        sourceFallbackScanned: result.sourceFallbackScanned || 0,
        limitedCommits: result.limitedCommits,
        issues: result.issues.slice(),
        branches: result.branches.map((branch) => ({
          name: branch.name,
          lastCommitDate: branch.lastCommitDate,
          ageDays: branch.ageDays,
          stale: branch.stale,
          isDefault: branch.isDefault,
          protected: branch.protected,
          secretFiles: Array.from(branch.secretFiles),
          secretCount: branch.secretCount,
          currentCheckIncomplete: branch.currentCheckIncomplete
        })),
        findings
      };
    });

    return {
      id: reportId(),
      createdAt: now.toISOString(),
      targetLabel,
      projects,
      issues: Array.from(new Set(scanIssues))
    };
  }

  function formatReportDate(value) {
    return new Date(value).toLocaleString("fr-FR");
  }

  function setStorageStatus(message, isError) {
    storageStatus.textContent = message;
    storageStatus.classList.toggle("error-text", Boolean(isError));
  }

  function setVaultStatus(message, isError) {
    vaultStatus.textContent = message;
    vaultStatus.classList.toggle("error-text", Boolean(isError));
  }

  async function refreshVaultControls() {
    const refreshId = ++targetRefreshId;
    vaultActions.hidden = true;
    vaultStatus.textContent = "";
    vaultPassphraseFields.hidden = !rememberTokenInput.checked;

    if (!targetInput.value.trim()) {
      vaultConfirmFields.hidden = true;
      return;
    }

    let target;
    try {
      target = parseTarget(modeInput.value, targetInput.value.trim());
    } catch {
      vaultConfirmFields.hidden = true;
      return;
    }

    try {
      const record = await getStored("tokens", tokenRecordId(target));
      if (refreshId !== targetRefreshId) {
        return;
      }
      vaultActions.hidden = !record;
      vaultPassphraseFields.hidden = !rememberTokenInput.checked && !record;
      vaultConfirmFields.hidden = !rememberTokenInput.checked;
      if (record) {
        setVaultStatus(
          rememberTokenInput.checked
            ? "Un jeton est déjà enregistré pour " + target.origin +
              ". Le jeton saisi le remplacera après l’analyse; confirmez la phrase de passe."
            : "Un jeton chiffré est enregistré pour " + target.origin +
              ". Déverrouillez-le avec votre phrase de passe.",
          false
        );
      } else if (rememberTokenInput.checked) {
        setVaultStatus(
          "Choisissez une phrase de passe d’au moins 12 caractères pour chiffrer ce jeton.",
          false
        );
      }
    } catch (error) {
      if (refreshId === targetRefreshId) {
        setVaultStatus(error.message, true);
      }
    }
  }

  async function refreshSavedReports() {
    try {
      const reports = await getAllStored("reports");
      reports.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      savedReportsList.replaceChildren();

      if (reports.length === 0) {
        appendText(savedReportsList, "p", "Aucun rapport enregistré sur cet appareil.", "field-help");
        return;
      }

      for (const report of reports) {
        const row = document.createElement("article");
        row.className = "saved-report";
        const description = document.createElement("p");
        const detectionCount = new Set(report.projects.flatMap((project) =>
          project.findings.map((finding) =>
            JSON.stringify([project.repository, finding.path, finding.secretId])
          )
        )).size;
        appendText(description, "strong", report.targetLabel || "Rapport d’analyse");
        appendText(
          description,
          "span",
          formatReportDate(report.createdAt) + " · " + detectionCount + " détection(s)"
        );
        row.append(description);

        const actions = document.createElement("div");
        actions.className = "saved-report-actions";
        const openButton = appendText(actions, "button", "Ouvrir");
        openButton.type = "button";
        openButton.addEventListener("click", () => {
          renderReport(report.projects, report.issues, report);
          results.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        const deleteButton = appendText(actions, "button", "Supprimer", "secondary");
        deleteButton.type = "button";
        deleteButton.addEventListener("click", async () => {
          deleteButton.disabled = true;
          try {
            await deleteStored("reports", report.id);
            setStorageStatus("Rapport supprimé de cet appareil.", false);
            await refreshSavedReports();
          } catch (error) {
            deleteButton.disabled = false;
            setStorageStatus(error.message, true);
          }
        });
        row.append(actions);
        savedReportsList.append(row);
      }
    } catch (error) {
      savedReportsList.replaceChildren();
      appendText(savedReportsList, "p", error.message, "error-text");
    }
  }

  async function unlockSavedToken() {
    try {
      const target = parseTarget(modeInput.value, targetInput.value.trim());
      const record = await getStored("tokens", tokenRecordId(target));
      if (!record) {
        throw new Error("Aucun jeton enregistré pour cette instance.");
      }
      const passphrase = vaultPassphraseInput.value;
      if (!passphrase) {
        throw new Error("Saisissez la phrase de passe du coffre local.");
      }
      tokenInput.value = await decryptToken(record, passphrase);
      vaultPassphraseInput.value = "";
      setVaultStatus("Jeton déverrouillé pour cette analyse. Il sera effacé du formulaire à la fin.", false);
    } catch (error) {
      setVaultStatus(error.message, true);
    }
  }

  async function removeSavedToken() {
    try {
      const target = parseTarget(modeInput.value, targetInput.value.trim());
      if (!window.confirm("Supprimer le jeton chiffré enregistré pour " + target.origin + " ?")) {
        return;
      }
      await deleteStored("tokens", tokenRecordId(target));
      tokenInput.value = "";
      vaultPassphraseInput.value = "";
      vaultPassphraseConfirmInput.value = "";
      rememberTokenInput.checked = false;
      setVaultStatus("Jeton enregistré supprimé de cet appareil.", false);
      await refreshVaultControls();
    } catch (error) {
      setVaultStatus(error.message, true);
    }
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
        const error = new Error("Jeton refusé par " + target.platform + ". Vérifiez sa validité et ses droits.");
        error.status = response.status;
        throw error;
      }
      if (response.status === 403 && target.platform === "github" &&
          response.headers.get("X-RateLimit-Remaining") === "0") {
        const error = new Error("Limite de requêtes GitHub atteinte. Réessayez après le renouvellement du quota.");
        error.status = response.status;
        throw error;
      }
      if (response.status === 429) {
        const error = new Error("Limite de requêtes " + target.platform + " atteinte. Réessayez plus tard.");
        error.status = response.status;
        throw error;
      }
      if (response.status === 403) {
        const error = new Error("Accès refusé par " + target.platform + " : " + message);
        error.status = response.status;
        throw error;
      }
      if (response.status === 404) {
        const error = new Error("Ressource introuvable ou inaccessible avec ce jeton.");
        error.status = response.status;
        throw error;
      }
      const error = new Error("L’API " + target.platform + " a refusé la requête : " + message);
      error.status = response.status;
      throw error;
    }

    return { data: await response.json(), headers: response.headers };
  }

  async function apiGetText(target, path, token, signal, maxBytes) {
    const response = await fetch(apiUrl(target, path), {
      headers: { "PRIVATE-TOKEN": token },
      signal
    });
    if (!response.ok) {
      const error = new Error(
        "Téléchargement de la source impossible (HTTP " + response.status + ")."
      );
      error.status = response.status;
      throw error;
    }

    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error("La source dépasse la limite de " + maxBytes + " octets.");
    }

    let bytes;
    if (response.body && response.body.getReader) {
      const reader = response.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          throw new Error("La source dépasse la limite de " + maxBytes + " octets.");
        }
        chunks.push(value);
      }
      bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
    } else {
      const text = await response.text();
      bytes = new TextEncoder().encode(text);
      if (bytes.length > maxBytes) {
        throw new Error("La source dépasse la limite de " + maxBytes + " octets.");
      }
    }

    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) {
      throw new Error("La source semble être un fichier binaire.");
    }
    return text;
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
        fullName: result.data.path_with_namespace,
        defaultBranch: result.data.default_branch
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
        fullName: project.path_with_namespace,
        defaultBranch: project.default_branch
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  function branchAssessment(branch) {
    const date = branch.lastCommitDate ? new Date(branch.lastCommitDate) : null;
    const ageDays = date && !Number.isNaN(date.getTime())
      ? Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000))
      : null;
    return {
      ...branch,
      ageDays,
      stale: ageDays !== null && ageDays >= staleBranchAfterDays,
      secretFiles: new Set(),
      secretCount: 0,
      currentCheckIncomplete: false
    };
  }

  function decodeBase64Content(content) {
    const binary = atob(content.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function getCurrentFileContent(repo, branch, path, token, signal) {
    const target = repo.provider;
    let apiPath;

    if (target.platform === "github") {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      apiPath = appendQuery("/repos/" + encodeURIComponent(repo.owner) + "/" +
        encodeURIComponent(repo.name) + "/contents/" + encodedPath, { ref: branch.headSha });
    } else {
      const projectPath = "/projects/" + repo.id + "/repository/files/" +
        encodeURIComponent(path);
      apiPath = appendQuery(projectPath, { ref: branch.headSha });
    }

    let result;
    try {
      result = await apiGet(target, apiPath, token, signal);
    } catch (error) {
      if (error.status === 404) {
        return { unavailable: true, reason: "fichier absent ou inaccessible (HTTP 404)" };
      }
      throw error;
    }

    const file = result.data;
    if (!file || file.encoding !== "base64" || typeof file.content !== "string") {
      return { unavailable: true };
    }

    try {
      return { content: decodeBase64Content(file.content) };
    } catch {
      return { unavailable: true };
    }
  }

  async function analyzeCurrentBranches(repo, branches, findings, token, signal, issues, onProgress) {
    const files = Array.from(new Set(findings
      .map((finding) => finding.path)
      .filter((path) => typeof path === "string" && path.length > 0)));
    const findingsByPath = new Map();
    for (const finding of findings) {
      if (!findingsByPath.has(finding.path)) {
        findingsByPath.set(finding.path, []);
      }
      findingsByPath.get(finding.path).push(finding);
    }
    for (const finding of findings) {
      finding.currentBranches = [];
      finding.currentBranchChecks = [];
    }

    let stopCurrentChecks = false;
    for (let branchIndex = 0; branchIndex < branches.length; branchIndex += 1) {
      const branch = branches[branchIndex];
      branch.secretFiles = new Set();
      const branchFindings = new Set();
      branch.currentCheckIncomplete = false;
      for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
        const path = files[fileIndex];
        if (signal.aborted) {
          throw new DOMException("Analyse annulée.", "AbortError");
        }
        onProgress(
          repo.fullName,
          branchIndex * Math.max(files.length, 1) + fileIndex + 1,
          Math.max(branches.length * files.length, 1),
          "current"
        );

        const pathFindings = findingsByPath.get(path) || [];
        if (stopCurrentChecks) {
          branch.currentCheckIncomplete = true;
          for (const finding of pathFindings) {
            finding.currentBranchChecks.push({ branch: branch.name, present: null });
          }
          continue;
        }

        let fileResult;
        try {
          fileResult = await getCurrentFileContent(repo, branch, path, token, signal);
        } catch (error) {
          if (error.name === "AbortError") {
            throw error;
          }
          issues.push(
            repo.fullName + " / branche " + branch.name + " / " + path +
            " : impossible de vérifier la présence actuelle du secret (" + error.message + ")."
          );
          branch.currentCheckIncomplete = true;
          if (error.status === 403 || error.status === 429) {
            stopCurrentChecks = true;
          }
          for (const finding of pathFindings) {
            finding.currentBranchChecks.push({ branch: branch.name, present: null });
          }
          continue;
        }

        if (fileResult.unavailable) {
          issues.push(
            repo.fullName + " / branche " + branch.name + " / " + path +
            " : " + (fileResult.reason || "contenu actuel inaccessible ou trop volumineux") +
            "; impossible de vérifier les secrets détectés."
          );
          branch.currentCheckIncomplete = true;
          for (const finding of pathFindings) {
            finding.currentBranchChecks.push({ branch: branch.name, present: null });
          }
          continue;
        }

        const currentDetections = new Set();
        const lines = fileResult.content.split(/\r?\n/);
        for (const line of lines) {
          for (const detection of window.SecretScanner.detectLine(line)) {
            currentDetections.add(JSON.stringify([path, detection.rule, detection.secretValue]));
          }
        }

        for (const finding of pathFindings) {
          const key = JSON.stringify([finding.path, finding.rule, finding.secretValue]);
          const present = currentDetections.has(key);
          finding.currentBranchChecks.push({ branch: branch.name, present });
          if (present) {
            finding.currentBranches.push(branch.name);
            branchFindings.add(key);
            branch.secretFiles.add(path);
          }
        }
      }
      branch.secretCount = branchFindings.size;
    }

    for (const finding of findings) {
      finding.branchCheckIncomplete = branches.length === 0 ||
        finding.currentBranchChecks.some((check) => check.present === null);
    }
  }

  async function scanGitHubRepository(repo, token, signal, onProgress) {
    const target = repo.provider;
    const prefix = "/repos/" + encodeURIComponent(repo.owner) + "/" +
      encodeURIComponent(repo.name);
    const repository = (await apiGet(target, prefix, token, signal)).data;
    if (!repository || typeof repository.default_branch !== "string") {
      throw new Error("Métadonnées du dépôt GitHub inattendues pour " + repo.fullName + ".");
    }
    const branches = await getAllPages(target, prefix + "/branches", token, signal);
    const commitsBySha = new Map();
    const branchAssessments = [];
    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      if (!branch || typeof branch.name !== "string" || !branch.commit ||
          typeof branch.commit.sha !== "string") {
        throw new Error("Liste de branches inattendue pour " + repo.fullName + ".");
      }

      branchAssessments.push(branchAssessment({
        name: branch.name,
        headSha: branch.commit.sha,
        lastCommitDate: branch.commit.commit &&
          branch.commit.commit.committer &&
          branch.commit.commit.committer.date ||
          branch.commit.commit &&
          branch.commit.commit.author &&
          branch.commit.commit.author.date,
        isDefault: branch.name === repository.default_branch,
        protected: Boolean(branch.protected)
      }));
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

    const issues = [];
    await analyzeCurrentBranches(
      repo, branchAssessments, findings, token, signal, issues, onProgress
    );

    return {
      repository: repo.fullName,
      commitCount: commits.length,
      filesScanned,
      unavailablePatches,
      limitedCommits,
      findings,
      branches: branchAssessments,
      issues
    };
  }

  async function scanGitLabRepository(repo, token, signal, onProgress) {
    const target = repo.provider;
    const prefix = "/projects/" + repo.id + "/repository";
    const branches = await getAllPages(target, prefix + "/branches", token, signal);
    const commitsBySha = new Map();
    const branchAssessments = [];

    for (let index = 0; index < branches.length; index += 1) {
      const branch = branches[index];
      if (!branch || typeof branch.name !== "string" ||
          !branch.commit || typeof branch.commit.id !== "string") {
        throw new Error("Liste de branches inattendue pour " + repo.fullName + ".");
      }

      branchAssessments.push(branchAssessment({
        name: branch.name,
        headSha: branch.commit.id,
        lastCommitDate: branch.commit.committed_date || branch.commit.authored_date,
        isDefault: Boolean(branch.default),
        protected: Boolean(branch.protected)
      }));
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
    const issues = [];
    let filesScanned = 0;
    let unavailablePatches = 0;
    let sourceFallbackScanned = 0;

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
        if (!diff) {
          unavailablePatches += 1;
          continue;
        }

        const path = diff.new_path || diff.old_path;
        const sourceRequired = typeof diff.diff !== "string" || diff.diff.length === 0;
        if (sourceRequired) {
          onProgress(repo.fullName, index + 1, commits.length, "source");
          const sourcePath = diff.deleted_file ? diff.old_path : path;
          const sourceRef = diff.deleted_file
            ? commit.parent_ids && commit.parent_ids[0]
            : commit.id;
          if (!sourcePath || !sourceRef) {
            unavailablePatches += 1;
            issues.push(
              repo.fullName + " / commit " + commit.id +
                " : source indisponible pour " + (sourcePath || "un fichier sans nom") + "."
            );
            continue;
          }

          try {
            const source = await apiGetText(
              target,
              prefix + "/files/" + encodeURIComponent(sourcePath) + "/raw" +
                "?ref=" + encodeURIComponent(sourceRef),
              token,
              signal,
              maxFallbackSourceBytes
            );
            filesScanned += 1;
            sourceFallbackScanned += 1;
            for (const finding of window.SecretScanner.scanSource(source)) {
              findings.push({
                ...finding,
                repository: repo.fullName,
                commit: diff.deleted_file ? sourceRef : commit.id,
                path: sourcePath,
                provider: target.platform,
                origin: target.origin
              });
            }
          } catch (error) {
            if (error.name === "AbortError") {
              throw error;
            }
            unavailablePatches += 1;
            issues.push(
              repo.fullName + " / commit " + commit.id + " / " + sourcePath +
                " : patch absent et source non analysée (" + error.message + ")."
            );
          }
          continue;
        }

        filesScanned += 1;
        for (const finding of window.SecretScanner.scanPatch(diff.diff)) {
          findings.push({
            ...finding,
            repository: repo.fullName,
            commit: commit.id,
            path: path || "Fichier inconnu",
            provider: target.platform,
            origin: target.origin
          });
        }
      }
    }

    await analyzeCurrentBranches(
      repo, branchAssessments, findings, token, signal, issues, onProgress
    );

    return {
      repository: repo.fullName,
      commitCount: commits.length,
      filesScanned,
      unavailablePatches,
      sourceFallbackScanned,
      limitedCommits: 0,
      findings,
      branches: branchAssessments,
      issues
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

  function getCommitUrl(finding, sha) {
    return finding.provider === "github"
      ? "https://github.com/" + finding.repository.split("/").map(encodeURIComponent).join("/") +
        "/commit/" + encodeURIComponent(sha)
      : finding.origin + "/" + finding.repository.split("/").map(encodeURIComponent).join("/") +
        "/-/commit/" + encodeURIComponent(sha);
  }

  function getBranchState(branch) {
    const labels = [];
    if (branch.isDefault) labels.push("par défaut");
    if (branch.protected) labels.push("protégée");
    if (branch.ageDays === null) {
      labels.push("date d’activité inconnue");
    } else {
      const date = new Date(branch.lastCommitDate).toLocaleDateString("fr-FR");
      labels.push((branch.stale ? "inactive" : "active") + " · dernier commit le " +
        date + " (" + branch.ageDays + " jours)");
    }
    return labels.join(" · ");
  }

  function renderCommitList(secret) {
    const details = document.createElement("details");
    const commits = Array.from(secret.commits.values())
      .sort((left, right) => left.commit.localeCompare(right.commit));
    appendText(details, "summary", "Commits contenant ce secret (" + commits.length + ")");
    const list = document.createElement("ul");
    for (const commit of commits) {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = getCommitUrl(secret, commit.commit);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = commit.commit;
      item.append(link);
      list.append(item);
    }
    details.append(list);
    return details;
  }

  function renderSecret(secret, branchesByName) {
    const article = document.createElement("article");
    article.className = "secret-finding";
    const top = document.createElement("div");
    top.className = "finding-top";
    article.append(top);
    appendText(top, "h5", secret.rule);
    appendText(top, "span", secret.severity, "badge");

    appendText(article, "h6", "Lignes détectées dans les commits");
    const excerpt = document.createElement("pre");
    const code = document.createElement("code");
    const lines = Array.from(secret.lines.values())
      .sort((left, right) => left.line - right.line || left.redactedLine.localeCompare(right.redactedLine));
    code.textContent = lines
      .map((line) => "L" + line.line + "  " + line.redactedLine)
      .join("\n");
    excerpt.append(code);
    article.append(excerpt);

    if (typeof secret.secretValue === "string") {
      const revealButton = appendText(article, "button", "Afficher la valeur détectée", "secondary");
      revealButton.type = "button";
      revealButton.setAttribute("aria-expanded", "false");
      const value = appendText(article, "code", "", "revealed-secret");
      value.hidden = true;
      value.textContent = secret.secretValue;
      revealButton.addEventListener("click", () => {
        value.hidden = !value.hidden;
        revealButton.setAttribute("aria-expanded", String(!value.hidden));
        revealButton.textContent = value.hidden
          ? "Afficher la valeur détectée"
          : "Masquer la valeur détectée";
      });
    }

    appendText(article, "h6", "Présence actuelle dans les branches");
    const presentBranches = Array.from(secret.currentBranches)
      .map((name) => branchesByName.get(name))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    if (presentBranches.length > 0) {
      appendText(
        article,
        "p",
        "Ce secret est encore détecté dans le fichier de " + presentBranches.length + " branche(s)."
      );
      const list = document.createElement("ul");
      for (const branch of presentBranches) {
        appendText(list, "li", branch.name + " — " + getBranchState(branch));
      }
      article.append(list);
    }
    if (secret.branchCheckIncomplete) {
      appendText(
        article,
        "p",
        presentBranches.length > 0
          ? "La vérification de présence est incomplète pour certaines branches."
          : "Secret non détecté dans les contenus vérifiables; la vérification de certaines branches est incomplète."
      );
    } else if (presentBranches.length === 0) {
      appendText(article, "p", "Secret non détecté dans le contenu actuel des branches vérifiées.");
    }

    if (presentBranches.length > 0) {
      appendText(
        article,
        "p",
        "Recommandation : révoquer ou renouveler le secret puis retirer le fichier sensible. Supprimer une branche ne retire pas le secret de l’historique des commits."
      );
    } else if (secret.currentBranches.size === 0 && !secret.branchCheckIncomplete) {
      appendText(
        article,
        "p",
        "Le secret n’est plus détecté dans les branches vérifiées. Vérifiez néanmoins l’historique et révoquez-le : supprimer une branche ne purge pas les commits encore accessibles."
      );
    }

    article.append(renderCommitList(secret));
    return article;
  }

  function renderProjectIssues(project, issues) {
    if (issues.length === 0) {
      return;
    }
    const section = document.createElement("section");
    section.className = "project-issues";
    appendText(section, "h4", "Limites et erreurs de ce projet");
    const list = document.createElement("ul");
    for (const issue of issues) {
      appendText(list, "li", issue);
    }
    section.append(list);
    project.append(section);
  }

  function renderBranchOverview(repoResult) {
    const details = document.createElement("details");
    details.className = "branch-overview";
    appendText(
      details,
      "summary",
      "État des branches et recommandations (" + repoResult.branches.length + ")"
    );
    const list = document.createElement("ul");
    const branches = repoResult.branches.slice().sort((left, right) =>
      Number(right.stale) - Number(left.stale) || left.name.localeCompare(right.name)
    );

    for (const branch of branches) {
      const item = document.createElement("li");
      const label = branch.name + " — " + getBranchState(branch) +
        (branch.secretCount > 0
          ? " — secret(s) encore présent(s) dans " + Array.from(branch.secretFiles).join(", ")
          : branch.currentCheckIncomplete
            ? " — vérification incomplète du contenu actuel"
            : " — aucun des secrets détectés n’est actuellement visible");
      appendText(item, "p", label);

      let recommendation;
      if (branch.isDefault) {
        recommendation = "Branche par défaut : ne pas supprimer. Traitez les secrets exposés et évaluez séparément l’historique.";
      } else if (branch.secretCount > 0) {
        recommendation = "Traiter et révoquer les secrets avant toute décision. La suppression de la branche n’efface pas les commits accessibles ailleurs.";
      } else if (branch.currentCheckIncomplete) {
        recommendation = "Vérification incomplète : ne pas conclure à l’absence de secrets ni recommander une suppression avant d’avoir vérifié le contenu.";
      } else if (branch.protected) {
        recommendation = "Branche protégée : ne pas supprimer sans validation de l’équipe responsable et vérification des règles de protection.";
      } else if (branch.stale) {
        recommendation = "Suppression éventuellement envisageable après vérification de la fusion, des demandes de fusion et du propriétaire. La suppression d’une branche ne purge pas les secrets présents dans d’autres historiques.";
      } else if (branch.ageDays === null) {
        recommendation = "Date inconnue : vérifier l’activité et le propriétaire avant toute décision.";
      } else {
        recommendation = "Branche active : vérifier son activité, ses demandes de fusion et son propriétaire avant toute opération de nettoyage.";
      }
      appendText(item, "p", recommendation, "branch-recommendation");
      list.append(item);
    }
    details.append(list);
    return details;
  }

  function groupFindings(findings) {
    const files = new Map();
    for (const finding of findings) {
      if (!files.has(finding.path)) {
        files.set(finding.path, new Map());
      }
      const secrets = files.get(finding.path);
      const key = finding.secretId || JSON.stringify([finding.rule, finding.secretValue]);
      if (!secrets.has(key)) {
        secrets.set(key, {
          ...finding,
          lines: new Map(),
          commits: new Map(),
          currentBranches: new Set(),
          branchCheckIncomplete: false
        });
      }

      const secret = secrets.get(key);
      secret.lines.set(
        JSON.stringify([finding.line, finding.redactedLine]),
        { line: finding.line, redactedLine: finding.redactedLine }
      );
      secret.commits.set(finding.commit, finding);
      for (const branch of finding.currentBranches) {
        secret.currentBranches.add(branch);
      }
      secret.branchCheckIncomplete = secret.branchCheckIncomplete || finding.branchCheckIncomplete;
    }
    return files;
  }

  function renderProject(repoResult) {
    const project = document.createElement("article");
    project.className = "project-result";
    appendText(project, "h3", repoResult.repository);
    project.append(renderBranchOverview(repoResult));

    const files = groupFindings(repoResult.findings);
    const branchesByName = new Map(repoResult.branches.map((branch) => [branch.name, branch]));
    const paths = Array.from(files.keys()).sort((left, right) => left.localeCompare(right));
    for (const path of paths) {
      const file = document.createElement("section");
      file.className = "file-result";
      appendText(file, "h4", path);
      const secrets = Array.from(files.get(path).values())
        .sort((left, right) => left.rule.localeCompare(right.rule));
      for (const secret of secrets) {
        file.append(renderSecret(secret, branchesByName));
      }
      project.append(file);
    }

    renderProjectIssues(project, repoResult.issues);
    return project;
  }

  function renderReport(repoResults, scanIssues, savedReport) {
    const allFindings = repoResults.flatMap((result) => result.findings);
    const uniqueFindings = new Set(allFindings.map((finding) =>
      finding.secretId ||
        JSON.stringify([finding.repository, finding.path, finding.rule, finding.secretValue])
    ));
    const totalCommits = repoResults.reduce((total, result) => total + result.commitCount, 0);
    const totalFiles = repoResults.reduce((total, result) => total + result.filesScanned, 0);
    const allIssues = Array.from(new Set(scanIssues));
    results.hidden = false;
    document.getElementById("results-heading").textContent = savedReport
      ? "Rapport du " + formatReportDate(savedReport.createdAt)
      : "Résultats de l’analyse";
    summary.textContent = uniqueFindings.size + " détection(s) distincte(s) · " +
      totalCommits + " commit(s) · " + totalFiles + " fichier(s) inspecté(s) · " +
      repoResults.length + " projet(s)";
    findingsPanel.replaceChildren();

    if (allIssues.length > 0) {
      issuesPanel.hidden = false;
      issuesPanel.replaceChildren();
      const heading = appendText(issuesPanel, "strong", "Analyse incomplète ou limites rencontrées");
      heading.setAttribute("aria-label", "Analyse incomplète ou limites rencontrées");
      const list = document.createElement("ul");
      for (const issue of allIssues) {
        appendText(list, "li", issue);
      }
      issuesPanel.append(list);
    } else {
      issuesPanel.hidden = true;
      issuesPanel.replaceChildren();
    }

    if (repoResults.every((result) => result.findings.length === 0)) {
      appendText(
        findingsPanel,
        "p",
        "Aucun motif connu détecté dans les patchs ou sources analysés. Cela ne garantit pas l’absence de secrets.",
        "empty-state"
      );
    }

    for (const repoResult of repoResults.slice().sort((left, right) =>
      left.repository.localeCompare(right.repository)
    )) {
      findingsPanel.append(renderProject(repoResult));
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
      if (rememberTokenInput.checked) {
        const passphrase = vaultPassphraseInput.value;
        if (passphrase.length < 12) {
          throw new Error("La phrase de passe du coffre doit contenir au moins 12 caractères.");
        }
        if (vaultPassphraseConfirmInput.value !== passphrase) {
          throw new Error("Les deux saisies de la phrase de passe ne correspondent pas.");
        }
      }

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
              const label = stage === "branch"
                ? "branche"
                : stage === "current"
                  ? "vérification de fichier/branche"
                  : stage === "source"
                    ? "source sans patch"
                  : "commit";
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
          if (result.sourceFallbackScanned > 0) {
            result.issues.push(
              result.sourceFallbackScanned + " fichier(s) sans patch exploitable : " +
                "source téléchargée et analysée (limite de " +
                Math.floor(maxFallbackSourceBytes / 1024) + " Kio par fichier)."
            );
          }
          if (result.unavailablePatches > 0) {
            result.issues.push(
              result.repository + " : " + result.unavailablePatches +
              " fichier(s) sans patch ou source exploitable; contenus non analysés."
            );
          }
          if (result.limitedCommits > 0) {
            result.issues.push(
              result.repository + " : " + result.limitedCommits +
                " commit(s) ont atteint la limite de 300 fichiers renvoyés par l’API GitHub; certains contenus ont pu être omis."
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
      const report = createSafeReport(repoResults, scanIssues, targetInput.value.trim());
      renderReport(repoResults, scanIssues);
      let reportSaved = false;
      try {
        await putStored("reports", report);
        reportSaved = true;
        setStorageStatus("Rapport enregistré sur cet appareil avec les valeurs sensibles masquées.", false);
        await refreshSavedReports();
      } catch (error) {
        setStorageStatus("Rapport affiché, mais impossible de l’enregistrer localement : " + error.message, true);
      }

      if (rememberTokenInput.checked) {
        try {
          const record = await encryptToken(target, token, vaultPassphraseInput.value);
          await putStored("tokens", record);
          setVaultStatus("Jeton chiffré et enregistré pour " + target.origin + ".", false);
          await refreshVaultControls();
        } catch (error) {
          setVaultStatus(
            (reportSaved ? "Rapport enregistré, mais " : "Analyse terminée, mais ") +
              "impossible d’enregistrer le jeton : " + error.message,
            true
          );
        }
      }
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
      vaultPassphraseInput.value = "";
      vaultPassphraseConfirmInput.value = "";
      activeController = null;
      setBusy(false);
      await refreshVaultControls();
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
  modeInput.addEventListener("change", refreshVaultControls);
  targetInput.addEventListener("input", updateTargetHelp);
  targetInput.addEventListener("change", refreshVaultControls);
  rememberTokenInput.addEventListener("change", refreshVaultControls);
  unlockTokenButton.addEventListener("click", unlockSavedToken);
  deleteTokenButton.addEventListener("click", removeSavedToken);

  form.addEventListener("submit", startScan);
  cancelButton.addEventListener("click", () => {
    if (activeController) {
      activeController.abort();
    }
  });

  refreshSavedReports();
})();

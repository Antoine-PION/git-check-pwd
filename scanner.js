(function () {
  "use strict";

  const placeholderValues = /^(?:\*{4,}|x{4,}|<[^>]*>|your[_-].*|replace[_-].*|example.*|sample.*|dummy.*|change[_-]?me|changeme|test|none|null|undefined|true|false)$/i;
  const rules = [
    {
      name: "Clé privée",
      expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
      severity: "Élevée"
    },
    {
      name: "Jeton GitHub",
      expression: /\b(?:gh[pousr]_[A-Za-z0-9_]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/,
      severity: "Élevée"
    },
    {
      name: "Clé d’accès AWS",
      expression: /\bAKIA[0-9A-Z]{16}\b/,
      severity: "Élevée"
    },
    {
      name: "Clé API Google",
      expression: /\bAIza[0-9A-Za-z_-]{35}\b/,
      severity: "Élevée"
    },
    {
      name: "Clé secrète Stripe",
      expression: /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/,
      severity: "Élevée"
    },
    {
      name: "Jeton Slack",
      expression: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
      severity: "Élevée"
    },
    {
      name: "Mot de passe ou secret assigné",
      expression: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([^\s"'`,;]{8,}))/i,
      severity: "À vérifier"
    }
  ];

  function detectLine(text) {
    const matches = [];

    for (const rule of rules) {
      const expression = new RegExp(rule.expression.source, rule.expression.flags + "g");
      let match;
      while ((match = expression.exec(text)) !== null) {
        const secret = match[1] || match[2] || match[3] || match[0];
        if (rule.name === "Mot de passe ou secret assigné" && placeholderValues.test(secret)) {
          continue;
        }

        const start = match.index + match[0].lastIndexOf(secret);
        matches.push({
          rule: rule.name,
          severity: rule.severity,
          start,
          end: start + secret.length,
          secretValue: secret
        });
      }
    }

    const spans = [];
    for (const match of matches.slice().sort((left, right) => left.start - right.start)) {
      const previous = spans[spans.length - 1];
      if (previous && match.start <= previous.end) {
        previous.end = Math.max(previous.end, match.end);
      } else {
        spans.push({ start: match.start, end: match.end });
      }
    }

    let redactedLine = "";
    let cursor = 0;
    for (const span of spans) {
      redactedLine += text.slice(cursor, span.start) + "*****";
      cursor = span.end;
    }
    redactedLine += text.slice(cursor);

    return matches.map(({ rule, severity, secretValue }) => ({ rule, severity, secretValue, redactedLine }));
  }

  function scanPatch(patch) {
    const findings = [];
    let newLineNumber = null;

    for (const line of patch.split(/\r?\n/)) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        newLineNumber = Number(hunk[1]);
        continue;
      }

      if (newLineNumber === null || line.startsWith("\\ No newline")) {
        continue;
      }

      if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      }

      if (line.startsWith("+")) {
        for (const detection of detectLine(line.slice(1))) {
          findings.push({ ...detection, line: newLineNumber });
        }
        newLineNumber += 1;
      } else if (line.startsWith(" ")) {
        newLineNumber += 1;
      }
    }

    return findings;
  }

  window.SecretScanner = Object.freeze({ detectLine, scanPatch });
})();

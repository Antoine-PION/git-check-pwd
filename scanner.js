(function () {
  "use strict";

  const placeholderValues = /^(?:\*{4,}|x{4,}|<[^>]*>|\$\{?[^}]+\}?|\{\{.*\}\}|your[_-].*|replace[_-].*|example.*|sample.*|dummy.*|placeholder.*|change[_-]?me|changeme|todo|fixme|test|password|secret|response|result|value|data|config|env|none|null|undefined|true|false)$/i;
  const assignmentExpression = /["'`]?([A-Za-z_$][\w$-]*)["'`]?\s*[:=]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|`([^`\r\n]{8,})`|([^\s"'`,;]{8,}))/i;
  const secretKeySuffixes = [
    "password", "passwd", "pwd", "pass", "passphrase", "secret", "secretkey",
    "apikey", "apisecret", "accesstoken", "authtoken", "authenticationtoken",
    "clientsecret", "privatekey", "credential", "credentials", "token", "jwt",
    "refreshtoken", "sessiontoken", "idtoken", "apitoken", "bearertoken",
    "webhooksecret", "webhooktoken", "signingkey", "encryptionkey",
    "awssecretaccesskey"
  ];
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
      name: "Jeton GitLab",
      expression: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
      severity: "Élevée"
    },
    {
      name: "Clé d’accès AWS",
      expression: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
      severity: "Élevée"
    },
    {
      name: "Clé API Anthropic",
      expression: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{30,}\b/,
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
      name: "Jeton Bearer",
      expression: /\bBearer\s+([A-Za-z0-9._~+/-]{20,}={0,2})/i,
      severity: "Élevée",
      captureGroup: 1
    },
    {
      name: "Mot de passe dans une chaîne de connexion",
      expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:/@\s]+:([^@\s/]{8,})@/i,
      severity: "Élevée",
      captureGroup: 1
    },
    {
      name: "Mot de passe ou secret assigné",
      expression: assignmentExpression,
      severity: "À vérifier",
      captureGroup: [2, 3, 4, 5]
    }
  ];

  function isSecretAssignment(match) {
    const key = match[1].toLowerCase().replace(/[_-]/g, "");
    return secretKeySuffixes.some((suffix) => key.endsWith(suffix));
  }

  function getCapturedValue(match, rule) {
    if (rule.captureGroup === 1) {
      return match[1];
    }
    if (Array.isArray(rule.captureGroup)) {
      return rule.captureGroup.map((group) => match[group]).find(Boolean);
    }
    return match[0];
  }

  function isLikelyCodeExpression(value) {
    return /[(){};]|(?:^|[^=!<>])(?:=>|==|!=|\|\||&&|\+\+|--|\?)/.test(value) ||
      /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) ||
      /^(?:get|fetch|read|load|resolve|find|retrieve|lookup|obtain)[A-Z_$]/.test(value) ||
      (/^[A-Za-z_$][\w$]*$/.test(value) && /[a-z]/.test(value) &&
        /[A-Z]/.test(value));
  }

  function detectLine(text) {
    const matches = [];

    for (const rule of rules) {
      const expression = new RegExp(rule.expression.source, rule.expression.flags + "g");
      let match;
      while ((match = expression.exec(text)) !== null) {
        if (rule.name === "Mot de passe ou secret assigné" &&
            !isSecretAssignment(match)) {
          continue;
        }
        const secret = getCapturedValue(match, rule);
        if (!secret || placeholderValues.test(secret) ||
            (rule.name === "Mot de passe ou secret assigné" &&
              Boolean(match[5]) && isLikelyCodeExpression(secret))) {
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

  function scanSource(source) {
    const findings = [];
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      for (const detection of detectLine(lines[index])) {
        findings.push({ ...detection, line: index + 1 });
      }
    }
    return findings;
  }

  window.SecretScanner = Object.freeze({ detectLine, scanPatch, scanSource });
})();

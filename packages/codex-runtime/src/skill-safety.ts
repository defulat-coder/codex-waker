import type {
  SkillSafetyFinding,
  SkillSafetySeverity,
  SkillScanSummary,
} from '@waker/contracts';

/**
 * Deterministic safety scanner for skill files (aligned with the legacy
 * SkillSafetyScanner, adapted to the local threat model: the inbound surface is
 * filesystem change under `.agents/skills/`, not an HTTP upload). Pure functions,
 * regex/heuristics only — no model calls. Findings are report-only; nothing here
 * blocks installation or execution, matching the "report, don't gate" posture.
 */

/** Findings kept per report; counts always reflect the full hit set. */
const MAX_KEPT_FINDINGS = 100;

interface SafetyRule {
  id: string;
  severity: SkillSafetySeverity;
  pattern: RegExp;
  message: string;
}

/**
 * Rules are ordered critical → warning → info. Each rule reports at most its first
 * match per file, so a single file cannot flood the report with one pattern.
 */
const RULES: SafetyRule[] = [
  {
    id: 'secret-exfiltration',
    severity: 'critical',
    // 旧版同款：敏感词 80 字符内出现外发动作。`\.env` 用负向后行排除 process.env。
    pattern:
      /((?<![\w.])\.env|token|credential|secret|cookie|authorization|api[-_ ]?key|password|private[-_ ]?key)[^\n]{0,80}(upload|send|post|curl|wget|https?:)/i,
    message: '内容疑似将本地密钥/凭证随外发请求传出',
  },
  {
    id: 'secret-exfiltration',
    severity: 'critical',
    // 反向：先读敏感路径，同行再出现网络外发。
    pattern:
      /(~\/?\.(ssh|aws|gnupg)|id_rsa|id_ed25519|(?<![\w.])\.env|credentials|密钥|凭证|令牌)[^\n]{0,80}(curl|wget|nc\b|https?:\/\/|上传|发送|外发)/i,
    message: '内容疑似读取敏感凭证路径并外发',
  },
  {
    id: 'obfuscated-payload',
    severity: 'critical',
    pattern: /base64\s+(?:--decode|-d|-D)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
    message: '内容要求解码 base64 载荷并直接交给 shell 执行',
  },
  {
    id: 'obfuscated-payload',
    severity: 'critical',
    pattern: /eval\s*\(\s*(?:atob\s*\(|Buffer\.from\s*\([^\n)]*base64)/i,
    message: '内容要求 eval 执行 base64 解码后的内容',
  },
  {
    id: 'obfuscated-payload',
    severity: 'critical',
    pattern: /eval\s*[\s(]*\$\(\s*(?:curl|wget)\b/i,
    message: '内容要求 eval 执行网络拉取的内容',
  },
  {
    id: 'obfuscated-payload',
    severity: 'critical',
    pattern: /(?:iex|Invoke-Expression)\s*\([^\n]{0,80}(?:DownloadString|FromBase64String)/i,
    message: '内容要求执行下载/解码后的 PowerShell 载荷',
  },
  {
    id: 'prompt-injection',
    severity: 'warning',
    pattern:
      /ignore (?:all )?(?:previous|prior|above) instructions|you are now system|developer message|忽略(?:之前|先前|以上|前面)的?(?:所有|全部)?(?:指令|指示|提示词)/i,
    message: '内容试图覆盖更高优先级的指令（prompt injection 特征）',
  },
  {
    id: 'hidden-instruction',
    severity: 'warning',
    pattern: /<!--[\s\S]*?(?:ignore|system|developer|忽略|系统指令)[\s\S]*?-->/i,
    message: 'HTML 注释中藏有指令，渲染不可见但会进入模型上下文',
  },
  {
    id: 'hidden-instruction',
    severity: 'warning',
    pattern: /display\s*:\s*none/i,
    message: '内容使用 display:none 隐藏文本，可能夹带不可见指令',
  },
  {
    id: 'concealment-directive',
    severity: 'warning',
    pattern:
      /(?:do not|don't|never)\s+(?:tell|inform|notify|mention|disclose)[^\n]{0,40}(?:the )?user|不要?告[诉知]用户|无需告知用户|不要?让用户知道|对(?:用户|使用者)保密/i,
    message: '内容要求对用户隐瞒行为或信息',
  },
  {
    id: 'privilege-escalation',
    severity: 'warning',
    pattern:
      /\bsudo\s+|chmod\s+777|disable (?:security|permission)|bypass (?:approval|permission)|禁用(?:安全|权限)|绕过(?:审批|权限)/i,
    message: '内容要求提权或绕过权限/审批',
  },
  {
    id: 'destructive-command',
    severity: 'warning',
    pattern:
      /\brm\s+-[a-z]*[rf][a-z]*[rf][a-z]*\b|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f[a-z]*d\b|mkfs\.|dd\s+[^\n]*of=\/dev\//i,
    message: '内容包含破坏性命令，执行前需要人工复核',
  },
  {
    id: 'remote-code-execution',
    severity: 'warning',
    pattern: /(?:curl|wget)\s+[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
    message: '内容要求将网络下载的脚本直接管道给 shell 执行',
  },
  {
    id: 'sensitive-path-reference',
    severity: 'info',
    pattern:
      /~\/\.(?:ssh|aws|gnupg)\b|\/\.(?:ssh|aws|gnupg)\/|\bid_rsa\b|\bid_ed25519\b|\/etc\/(?:passwd|shadow)\b/i,
    message: '内容引用了敏感凭证路径，建议确认其必要性',
  },
  {
    id: 'sensitive-path-reference',
    severity: 'info',
    pattern: /\b(?:cat|less|head|tail|source)\s+[^\n]*\.env\b/i,
    message: '内容要求读取 .env 文件，建议确认其必要性',
  },
];

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

/** Scans one text file; returns at most one finding per rule (first hit). */
export function scanSkillText(path: string, content: string): SkillSafetyFinding[] {
  const findings: SkillSafetyFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(content);
    if (!match) continue;
    findings.push({
      ruleId: rule.id,
      severity: rule.severity,
      path,
      line: lineOf(content, match.index ?? 0),
      message: rule.message,
    });
  }
  return findings;
}

const SEVERITY_RANK: Record<SkillSafetySeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Aggregates per-file findings into the summary stored on version manifests and scan reports. */
export function summarizeSkillScan(
  scannedPaths: string[],
  findings: SkillSafetyFinding[],
): SkillScanSummary {
  const sorted = [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.ruleId.localeCompare(b.ruleId),
  );
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const finding of sorted) counts[finding.severity] += 1;
  return {
    scannedPaths: [...scannedPaths].sort(),
    findings: sorted.slice(0, MAX_KEPT_FINDINGS),
    counts,
    level: counts.critical > 0 ? 'critical' : counts.warning > 0 ? 'warning' : counts.info > 0 ? 'info' : 'clean',
    ...(sorted.length > MAX_KEPT_FINDINGS ? { truncated: true } : {}),
  };
}

import * as fs from 'fs';
import * as path from 'path';

const TEMPLATE_DIR = path.join(__dirname, '..', 'templates');

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATE_DIR, name), 'utf8');
}

/**
 * Replace {{KEY}} placeholders. Values may be CDK string tokens (e.g. a user pool id);
 * CDK resolves tokens embedded in strings into Fn::Join at synth time.
 * Throws on any placeholder without a value so a typo can't ship a broken config.
 */
export function render(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`Template placeholder {{${key}}} has no value`);
    return v;
  });
  return out;
}

/** YAML list items at a given indent, e.g. ["a","b"] -> '      - "a"\n      - "b"'. */
export function yamlList(items: string[], indent: number): string {
  const pad = ' '.repeat(indent);
  return items.map((i) => `${pad}- ${JSON.stringify(i)}`).join('\n');
}

/** A bash snippet writing `content` verbatim to `dest` via a quoted heredoc (no shell expansion). */
export function writeFileSnippet(dest: string, content: string, mode = '644'): string {
  const delim = `__HS_EOF_${path.basename(dest).replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}__`;
  if (content.includes(delim)) throw new Error(`heredoc delimiter collision for ${dest}`);
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return `cat > ${dest} <<'${delim}'\n${body}${delim}\nchmod ${mode} ${dest}\n`;
}

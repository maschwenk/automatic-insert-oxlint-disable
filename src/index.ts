import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import MagicString from 'magic-string';

type Diagnostic = {
    message: string;
    code: string;
    severity: 'error' | 'warning' | 'info';
    causes: unknown[];
    url: string;
    help: string;
    filename: string;
    labels: {
        label?: string;
        span: {
            offset: number;
            length: number;
            line: number;
            column: number;
        };
    }[];
};

type OxcJsonOutput = {
    diagnostics: Diagnostic[];
};

function groupBy<T, K extends string | number | symbol>(items: T[], keyFn: (item: T) => K): Record<K, T[]> {
    const result = {} as Record<K, T[]>;
    for (const item of items) {
        const key = keyFn(item);
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(item);
    }
    return result;
}

type DisableDirective = {
    rules: string[];
    message?: string;
};

function parseDisableDirective(line: string): DisableDirective {
    // Match: // oxlint-disable-next-line rule1, rule2, ... -- optional message
    const match = line.match(/\/\/\s*oxlint-disable-next-line\s+(.+)/);
    if (!match) return { rules: [] };

    const content = match[1];
    // Check if there's a message separator (--)
    const separatorIndex = content.indexOf(' -- ');
    if (separatorIndex !== -1) {
        const rulesStr = content.slice(0, separatorIndex);
        const message = content.slice(separatorIndex + 4).trim();
        return {
            rules: rulesStr.split(',').map((r) => r.trim()),
            message: message || undefined,
        };
    }

    return {
        rules: content.split(',').map((r) => r.trim()),
    };
}

const BANNED_PATHS = ['node_modules', '.git'];

function isBannedPath(filename: string): boolean {
    return BANNED_PATHS.some((banned) => filename.includes(`/${banned}/`) || filename.startsWith(`${banned}/`));
}

function hasUncommittedChanges(): boolean {
    // Skip git check if SKIP_GIT_CHECK env var is set
    if (process.env.SKIP_GIT_CHECK === '1' || process.env.SKIP_GIT_CHECK === 'true') {
        return false;
    }

    try {
        const status = execSync('git status --porcelain', {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return status.trim().length > 0;
    } catch {
        // If git command fails (e.g., not a git repo), assume no changes
        return false;
    }
}

function run() {
    if (hasUncommittedChanges()) {
        console.error('Error: Working tree has uncommitted changes.');
        console.error('Please commit or stash your changes before running this tool.');
        process.exit(1);
    }

    const { values, positionals } = parseArgs({
        options: {
            rule: {
                type: 'string',
                short: 'r',
            },
            'dry-run': {
                type: 'boolean',
                short: 'd',
                default: false,
            },
            message: {
                type: 'string',
                short: 'm',
            },
        },
        allowPositionals: true,
    });

    const targetRuleToDisable = values.rule;
    const dryRun = values['dry-run'];
    const customMessage = values.message;
    const additionalOxlintArguments = positionals;

    if (!targetRuleToDisable) {
        console.error('Usage: node script.ts --rule <plugin/rule-name> [--message <message>] [-- <oxlint args>]');
        console.error('Example: node script.ts --rule eslint/no-unused-vars --message "TODO: fix this" -- src/');
        process.exit(1);
    }

    // Validate rule format (plugin/rule-name)
    if (!targetRuleToDisable.includes('/')) {
        console.error(`Invalid rule format: "${targetRuleToDisable}". Expected format: plugin/rule-name`);
        process.exit(1);
    }

    const [pluginName, ruleName] = targetRuleToDisable.split('/');
    const targetCodeToDisable = `${pluginName}(${ruleName})`;

    // Run oxlint with JSON output
    const oxlintCommand = [
        './node_modules/.bin/oxlint',
        '--format=json',
        '-c oxlintrc.json',
        `-A all -D ${targetRuleToDisable}`,
        ...additionalOxlintArguments,
    ].join(' ');

    console.log(`Running: ${oxlintCommand}`);

    let oxlintOutput: OxcJsonOutput | undefined;
    try {
        const stdout = execSync(oxlintCommand, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log('oxlint finished running.');

        // write stdout to a file
        writeFileSync('oxlint-output.json', stdout, 'utf-8');
        oxlintOutput = JSON.parse(stdout);
    } catch (error: unknown) {
        console.log(error);
        // oxlint exits with non-zero when there are diagnostics
        if (error && typeof error === 'object' && 'stdout' in error) {
            const stdout = (error as { stdout: string }).stdout;
            if (stdout) {
                oxlintOutput = JSON.parse(stdout);
            } else {
                console.error('Failed to run oxlint:', error);
                process.exit(1);
            }
        } else {
            console.error('Failed to run oxlint:', error);
            process.exit(1);
        }
    }

    if (!oxlintOutput || oxlintOutput.diagnostics.length === 0) {
        console.log('No diagnostics found for rule:', targetRuleToDisable);
        return;
    }

    console.log(`Found ${oxlintOutput.diagnostics.length} diagnostic(s) for rule: ${targetRuleToDisable}`);

    // Filter diagnostics to only include the target rule
    const filteredDiagnostics = oxlintOutput.diagnostics.filter((diag) => diag.code === targetCodeToDisable);

    if (filteredDiagnostics.length === 0) {
        console.log('No diagnostics match the target rule code:', targetCodeToDisable);
        return;
    }

    const diagnosticsByFile = groupBy(filteredDiagnostics, (diag) => diag.filename);

    let totalModifications = 0;

    for (const [filename, diagnostics] of Object.entries(diagnosticsByFile)) {
        if (!diagnostics || diagnostics.length === 0) continue;

        // Skip banned paths (node_modules, .git)
        if (isBannedPath(filename)) {
            console.log(`Skipping banned path: ${filename}`);
            continue;
        }

        const sourceCode = readFileSync(filename, 'utf-8');
        const lines = sourceCode.split('\n');
        const magicString = new MagicString(sourceCode);

        // Sort diagnostics by line number in descending order to avoid offset issues
        const sortedDiagnostics = [...diagnostics].sort((a, b) => b.labels[0].span.line - a.labels[0].span.line);

        // Track which lines we've already processed to handle multiple diagnostics on same line
        const processedLines = new Set<number>();

        for (const diag of sortedDiagnostics) {
            if (!diag.labels[0]) continue;

            const line = diag.labels[0].span.line; // 1-based

            // Skip if we've already processed this line
            if (processedLines.has(line)) continue;
            processedLines.add(line);

            const previousLineIndex = line - 2; // Convert to 0-based and go up one line
            const previousLine = lines[previousLineIndex];

            // Calculate the position at the start of the current line
            const lineStartOffset = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0);

            // Get indentation of the current line
            const currentLine = lines[line - 1];
            const indentMatch = currentLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '';

            if (previousLine && previousLine.includes('oxlint-disable-next-line')) {
                // Append to existing directive
                const existing = parseDisableDirective(previousLine);
                if (!existing.rules.includes(targetRuleToDisable)) {
                    // Find the end of the previous line and append the rule
                    const prevLineStartOffset = lines.slice(0, previousLineIndex).join('\n').length + (previousLineIndex > 0 ? 1 : 0);
                    const prevLineEndOffset = prevLineStartOffset + previousLine.length;

                    // Determine the final message: prefer existing, but use new if no existing
                    const finalMessage = existing.message || customMessage;
                    const messageSuffix = finalMessage ? ` -- ${finalMessage}` : '';

                    // Replace the entire previous line with updated directive
                    const newDirective = `${indent}// oxlint-disable-next-line ${[...existing.rules, targetRuleToDisable].join(', ')}${messageSuffix}`;
                    magicString.overwrite(prevLineStartOffset, prevLineEndOffset, newDirective);
                    totalModifications++;
                }
            } else {
                // Add new directive
                const messageSuffix = customMessage ? ` -- ${customMessage}` : '';
                const directive = `${indent}// oxlint-disable-next-line ${targetRuleToDisable}${messageSuffix}\n`;
                magicString.prependLeft(lineStartOffset, directive);
                totalModifications++;
            }
        }

        const newSource = magicString.toString();

        if (dryRun) {
            console.log(`\n--- ${filename} (dry run) ---`);
            console.log(newSource);
        } else {
            writeFileSync(filename, newSource);
            console.log(`Updated: ${filename} (${diagnostics.length} directive(s))`);
        }
    }

    console.log(`\nTotal modifications: ${totalModifications}`);
    if (dryRun) {
        console.log('(dry run - no files were modified)');
    }
}

run();

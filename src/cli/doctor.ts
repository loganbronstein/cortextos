import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface Check {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
  fix?: string;
}

export const doctorCommand = new Command('doctor')
  .option('--instance <id>', 'Instance ID', 'default')
  .description('Diagnose common issues')
  .action(async (options: { instance: string }) => {
    console.log('\ncortextOS Doctor\n');

    const checks: Check[] = [];

    // Check Node.js version
    const nodeVersion = process.version;
    const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);
    checks.push({
      name: 'Node.js version',
      status: major >= 20 ? 'pass' : 'fail',
      message: `${nodeVersion} ${major >= 20 ? '(OK)' : '(requires 20+)'}`,
      fix: major < 20 ? 'Install Node.js 20+ from https://nodejs.org' : undefined,
    });

    // Check PM2
    try {
      const pm2Version = execSync('pm2 --version', { encoding: 'utf-8' }).trim();
      checks.push({
        name: 'PM2',
        status: 'pass',
        message: `v${pm2Version}`,
      });
    } catch {
      checks.push({
        name: 'PM2',
        status: 'warn',
        message: 'Not installed',
        fix: 'Install with: npm install -g pm2',
      });
    }

    // Check Claude Code CLI
    try {
      const claudeVersion = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
      checks.push({
        name: 'Claude Code CLI',
        status: 'pass',
        message: claudeVersion,
      });
    } catch {
      checks.push({
        name: 'Claude Code CLI',
        status: 'fail',
        message: 'Not found',
        fix: 'Install Claude Code: npm install -g @anthropic-ai/claude-code',
      });
    }

    // Check node-pty
    try {
      require('node-pty');
      checks.push({
        name: 'node-pty',
        status: 'pass',
        message: 'Native module loaded',
      });
    } catch {
      checks.push({
        name: 'node-pty',
        status: 'fail',
        message: 'Failed to load native module',
        fix: process.platform === 'win32'
          ? 'Install Visual C++ Build Tools: npm install -g windows-build-tools'
          : 'Install build tools: xcode-select --install (macOS) or apt install build-essential (Linux)',
      });
    }

    // Check state directory
    const ctxRoot = join(homedir(), '.cortextos', options.instance);
    checks.push({
      name: 'State directory',
      status: existsSync(ctxRoot) ? 'pass' : 'warn',
      message: existsSync(ctxRoot) ? ctxRoot : 'Not found',
      fix: !existsSync(ctxRoot) ? 'Run: cortextos init <org-name>' : undefined,
    });

    // Check ANTHROPIC_API_KEY
    checks.push({
      name: 'ANTHROPIC_API_KEY',
      status: process.env.ANTHROPIC_API_KEY ? 'pass' : 'warn',
      message: process.env.ANTHROPIC_API_KEY ? 'Set' : 'Not set',
      fix: !process.env.ANTHROPIC_API_KEY ? 'Export ANTHROPIC_API_KEY in your shell profile' : undefined,
    });

    // Display results
    let hasFailures = false;
    for (const check of checks) {
      const icon = check.status === 'pass' ? 'OK' : check.status === 'warn' ? 'WARN' : 'FAIL';
      const prefix = `  [${icon}]`;
      console.log(`${prefix.padEnd(10)} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`           Fix: ${check.fix}`);
      }
      if (check.status === 'fail') hasFailures = true;
    }

    const warnCount = checks.filter(c => c.status === 'warn').length;
    const failCount = checks.filter(c => c.status === 'fail').length;

    console.log('');
    if (failCount > 0) {
      console.log(`  ${failCount} check(s) failed. Fix the issues above and run doctor again.\n`);
      process.exit(1);
    } else if (warnCount > 0) {
      console.log(`  All critical checks passed, ${warnCount} warning(s). See above for details.\n`);
    } else {
      console.log('  All checks passed.\n');
    }
  });

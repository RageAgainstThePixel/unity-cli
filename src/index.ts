#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const program = new Command();

program
    .name('unity-cli')
    .description('A command line utility for the Unity Game Engine.')
    .version(pkg.version);

// TODO additional commands

program.parse(process.argv);

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Core first: the other packages depend on it.
const PACKAGES = ['core', 'langchain', 'vercel', 'autoevals', 'tau-bench'];

function isPublished(name, version) {
    const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { encoding: 'utf8' });
    return result.status === 0 && result.stdout.trim() === version;
}

// Publishes one package at a time with the terminal attached, so npm's 2FA prompt works.
// `pnpm -r pub` can't do that: it runs the scripts as detached children, in parallel.
function main() {
    for (const dir of PACKAGES) {
        const packagePath = path.resolve('./packages', dir);
        const { name, version } = require(path.join(packagePath, 'package.json'));

        if (isPublished(name, version)) {
            console.log(`Skipping ${name}@${version}: already published`);
            continue;
        }

        const result = spawnSync('pnpm', ['publish', '--no-git-checks'], {
            cwd: packagePath,
            stdio: 'inherit',
        });
        if (result.status !== 0) {
            console.error(`Failed to publish ${name}@${version}`);
            process.exit(result.status ?? 1);
        }
    }
}

main();

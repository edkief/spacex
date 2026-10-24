import { spawn } from 'child_process';
import path from 'path';

export async function runCrashTest(shipId: string, position: {x: number, y: number, z: number}) {
    const child = spawn('node', [
        '-e', 
        `
        const { initDb } = require('./app/src/server/db/client');
        const { repo } = require('./app/src/server/db/repo');
        initDb();
        repo.saveShipState('${shipId}', { position: JSON.stringify(${JSON.stringify(position)}) })
            .then(() => {
                process.kill(process.pid, 'SIGKILL');
            });
        `
    ], {
        cwd: process.cwd(),
        env: { ...process.env, DB_DRIVER: 'sqlite', DB_PATH: '/tmp/opencode/crash.sqlite' }
    });

    return new Promise((resolve) => {
        child.on('exit', resolve);
    });
}

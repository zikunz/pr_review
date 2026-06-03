import { exec } from 'node:child_process';

export function convertImage(req) {
  exec('convert ' + req.query.path + ' /tmp/out.png');
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
const exec = promisify(execFile);
const script = "cutoff=$(date -d '7 days ago' +%s); docker ps -aq --filter 'name=^nf-' | while read -r id; do created=$(docker inspect -f '{{.Created}}' \"$id\"); [ $(date -d \"$created\" +%s) -lt $cutoff ] && docker rm -f \"$id\"; done";
exec("ssh", ["-i", config.deploySshKey, "-o", "StrictHostKeyChecking=no", `root@${config.deployHost}`, script]).then(({ stdout }) => console.log(stdout)).catch((error) => { console.error(error); process.exit(1); });

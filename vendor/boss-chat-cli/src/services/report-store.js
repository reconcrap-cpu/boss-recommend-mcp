import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function timestampToken(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export class ReportStore {
  constructor(baseDir) {
    this.reportsDir = path.join(baseDir, 'reports');
  }

  async write(summary) {
    await mkdir(this.reportsDir, { recursive: true });
    const filePath = path.join(this.reportsDir, `run-${timestampToken()}.json`);
    await writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return filePath;
  }
}

"""Run pytest in a child process with only temporary local state."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    with tempfile.TemporaryDirectory(prefix='gcli-diag-tests-') as directory:
        env = os.environ.copy()
        for key in ('REDIS_URL', 'MONGODB_URI', 'POSTGRESQL_URI', 'MYSQL_URI', 'DATABASE_URL', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'PROXY', 'http_proxy', 'https_proxy', 'all_proxy'):
            env[key] = ''
        env.update(ENABLE_LOG='0', LOG_LEVEL='info', PYTHONUTF8='1', NO_PROXY='*',
                   CREDENTIALS_DIR=str(Path(directory) / 'credentials'),
                   LOG_FILE=str(Path(directory) / 'service.log'),
                   DIAG_PEERS='', DIAG_INSTANCE_ID='', DIAG_ENVIRONMENT='test', DIAG_DEPLOYMENT_ID='isolated')
        Path(env['CREDENTIALS_DIR']).mkdir()
        return subprocess.call([sys.executable, '-m', 'pytest', *sys.argv[1:]], env=env,
                               cwd=Path(__file__).resolve().parents[1])


if __name__ == '__main__':
    raise SystemExit(main())
